import '../data/app_database.dart';
import '../erp/js_compat.dart';
import '../erp/normalize.dart';
import '../erp/payroll_audit_engine.dart';
import '../google/sheets_client.dart';
import 'chart.dart';
import 'ledger.dart';
import 'money.dart';
import 'parties.dart';

/// The figures of a financial cycle, from its saved sheets (as the web
/// ERP's `computeManagementSheetTotalsFromRows` and the transfer discount
/// of `rebuildDeferredFromLocalAgentData`).
class CycleFigures {
  const CycleFigures({
    required this.cycle,
    required this.hasData,
    this.agentSalaries = 0,
    this.discount = 0,
    this.mgmtW = 0,
    this.mgmtYZ = 0,
  });
  final Cycle cycle;
  final bool hasData;

  /// Sum of the agent sheet's salary column (cents, before discount).
  final int agentSalaries;

  /// What the cycle's transfer discount keeps (cents).
  final int discount;

  /// Sum of column W of the management sheet (cents).
  final int mgmtW;

  /// Sum of columns Y + Z of the management sheet (cents).
  final int mgmtYZ;

  int get agentNet => agentSalaries - discount;
  String get name => cycle.name.isEmpty ? 'دورة #${cycle.id}' : cycle.name;
}

/// The parts of a cycle that are posted (each once; posting again reverses
/// the previous entry first, in the same transaction).
abstract final class CyclePart {
  static const agent = 'agent';
  static const management = 'mgmt';
  static String share(int partyAccountId) => 'share:$partyAccountId';
}

/// «ترحيل الدورة» (stage 4): the cycle's money as entries, so its profits
/// are in the books like any other operation (the web ERP posted some of
/// them to the ledger, some to the main fund only, some twice).
class CyclePosting {
  CyclePosting(this.ledger, this.db, this.parties);
  final Ledger ledger;
  final AppDatabase db;
  final Parties parties;

  static String ref(int cycleId, String part) => 'cycle:$cycleId:$part';

  static int _cents(Object? cell) {
    final n = jsParseFloat(normalizeForNumber(cell?.toString()));
    return jsIsFiniteNumber(n) ? (n * centsPerUnit).round() : 0;
  }

  static bool _header(List<String> row, int idCol) =>
      normalizeUserId(cellAt(row, idCol)).isEmpty;

  Future<CycleFigures> figures(int cycleId) async {
    final cycle = await db.getCycleInfo(cycleId);
    if (cycle == null) throw LedgerException('الدورة غير موجودة');
    // A Google cycle's sheets are in its cache (audit / sync); a cycle
    // made from files keeps them in the cycle itself.
    final cache = await db.getCycleCache(cycleId);
    Rows agent = cache?.agentData ?? const [];
    Rows mgmt = cache?.managementData ?? const [];
    if (agent.isEmpty && mgmt.isEmpty) {
      final full = await db.getCycle(cycleId);
      agent = full?.agentRows ?? const [];
      mgmt = full?.managementRows ?? const [];
    }
    if (agent.isEmpty && mgmt.isEmpty) {
      return CycleFigures(cycle: cycle, hasData: false);
    }
    final cols = await db.getCycleColumns(cycleId);
    final agentId = columnLetterToIndex(cols.agentUserIdCol) ?? 0;
    final salaryCol = columnLetterToIndex(cols.agentSalaryCol) ?? 3;
    var salaries = 0;
    var discount = 0;
    for (var i = agent.isEmpty ? 0 : 1; i < agent.length; i++) {
      final row = agent[i];
      if (normalizeUserId(cellAt(row, agentId)).isEmpty) continue;
      final s = computeSalaryWithDiscount([
        cellAt(row, salaryCol),
      ], cycle.transferDiscountPct);
      salaries += (s.before * centsPerUnit).round();
      discount += ((s.before - s.after) * centsPerUnit).round();
    }
    var w = 0;
    var yz = 0;
    final mgmtId = columnLetterToIndex(cols.mgmtUserIdCol) ?? 0;
    final start = mgmt.isNotEmpty && _header(mgmt.first, mgmtId) ? 1 : 0;
    for (var i = start; i < mgmt.length; i++) {
      final row = mgmt[i];
      w += _cents(cellAt(row, 22));
      yz += _cents(cellAt(row, 24)) + _cents(cellAt(row, 25));
    }
    return CycleFigures(
      cycle: cycle,
      hasData: true,
      agentSalaries: salaries,
      discount: discount,
      mgmtW: w,
      mgmtYZ: yz,
    );
  }

  /// The live (not reversed) entry of a part, if posted.
  Future<JournalEntry?> posted(int cycleId, String part) async {
    final rows = await ledger.db.query(
      'acc_entries',
      columns: ['id'],
      where: 'ref = ? AND reversed_by_id IS NULL AND reverses_id IS NULL',
      whereArgs: [ref(cycleId, part)],
      orderBy: 'id DESC',
      limit: 1,
    );
    return rows.isEmpty ? null : ledger.entry(rows.first['id'] as int);
  }

  Future<JournalEntry> _replace(
    int cycleId,
    String part,
    EntryDraft draft,
  ) async {
    final old = await posted(cycleId, part);
    if (old != null) {
      await ledger.reverse(old.id, memo: 'إعادة ترحيل: ${old.memo}');
    }
    return ledger.post(draft);
  }

  /// The agent sheet's salaries: received in [receivedInId] (a fund), owed
  /// to the paying accreditation [accreditationId] after the transfer
  /// discount, which is our profit («أرباح خصم التحويل»).
  Future<JournalEntry> postAgent(
    int cycleId, {
    required int receivedInId,
    required int accreditationId,
    int? salaries,
    int? discount,
    String? date,
  }) async {
    final f = await figures(cycleId);
    final s = salaries ?? f.agentSalaries;
    final d = discount ?? f.discount;
    if (s <= 0) throw LedgerException('لا رواتب في جدول الوكيل لهذه الدورة');
    if (d < 0 || d > s) throw LedgerException('الخصم بين 0 ومجموع الرواتب');
    final rev = await ledger.byRole(Roles.revTransferDiscount);
    return _replace(
      cycleId,
      CyclePart.agent,
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: 'رواتب جدول الوكيل — ${f.name}',
        kind: EntryKind.cycle,
        ref: ref(cycleId, CyclePart.agent),
        meta: {
          'cycle': cycleId,
          'salaries': s,
          'discount': d,
          'pct': f.cycle.transferDiscountPct,
          'accreditation': accreditationId,
          'fund': receivedInId,
        },
        lines: [
          JournalLine(accountId: receivedInId, debit: s),
          if (s - d > 0)
            JournalLine(
              accountId: accreditationId,
              credit: s - d,
              memo: 'الرواتب بعد الخصم',
            ),
          if (d > 0)
            JournalLine(
              accountId: rev.id,
              credit: d,
              memo:
                  'خصم التحويل ${f.cycle.transferDiscountPct.toString().replaceAll(RegExp(r'\.0$'), '')}٪',
            ),
        ],
      ),
    );
  }

  /// The management sheet: W and Y+Z received in [receivedInId]; W is
  /// «إيرادات الإدارة (عمود W)» (the sub-agencies' shares are moved out of
  /// it by [postShares]) and Y+Z is «أرباح التدقيق».
  Future<JournalEntry> postManagement(
    int cycleId, {
    required int receivedInId,
    int? w,
    int? yz,
    String? date,
  }) async {
    final f = await figures(cycleId);
    final ww = w ?? f.mgmtW;
    final y = yz ?? f.mgmtYZ;
    if (ww < 0 || y < 0) throw LedgerException('المبالغ لا تكون سالبة');
    if (ww + y <= 0) {
      throw LedgerException('لا مبالغ في جدول الإدارة لهذه الدورة');
    }
    final revW = await ledger.byRole(Roles.revMgmtW);
    final revAudit = await ledger.byRole(Roles.revAudit);
    return _replace(
      cycleId,
      CyclePart.management,
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: 'جدول الإدارة (W + Y+Z) — ${f.name}',
        kind: EntryKind.cycle,
        ref: ref(cycleId, CyclePart.management),
        meta: {'cycle': cycleId, 'w': ww, 'yz': y, 'fund': receivedInId},
        lines: [
          JournalLine(accountId: receivedInId, debit: ww + y),
          if (ww > 0)
            JournalLine(accountId: revW.id, credit: ww, memo: 'عمود W'),
          if (y > 0)
            JournalLine(accountId: revAudit.id, credit: y, memo: 'Y + Z'),
        ],
      ),
    );
  }

  /// Each sub-agency's share of the cycle: its sheet's W total, of which
  /// the company keeps the agency's percentage. The base comes out of
  /// «إيرادات الإدارة (عمود W)».
  Future<List<JournalEntry>> postShares(
    int cycleId,
    Map<int, int> baseByParty, {
    String? date,
  }) async {
    final f = await figures(cycleId);
    final revW = await ledger.byRole(Roles.revMgmtW);
    final out = <JournalEntry>[];
    for (final e in baseByParty.entries) {
      if (e.value <= 0) continue;
      final p = await parties.ofAccount(e.key);
      if (p == null || p.kind != PartyKind.subAgency) continue;
      final company = percentOf(e.value, p.percentBp);
      final agency = e.value - company;
      final sub = await ledger.byRole(Roles.revSubAgency);
      out.add(
        await _replace(
          cycleId,
          CyclePart.share(e.key),
          EntryDraft(
            date: date ?? Ledger.today(),
            memo: 'حصة ${p.name} — ${f.name}',
            kind: EntryKind.share,
            ref: ref(cycleId, CyclePart.share(e.key)),
            meta: {
              'cycle': cycleId,
              'base': e.value,
              'companyBp': p.percentBp,
              'company': company,
              'agency': agency,
            },
            lines: [
              JournalLine(accountId: revW.id, debit: e.value),
              if (agency > 0)
                JournalLine(
                  accountId: e.key,
                  credit: agency,
                  memo: 'حصة الوكالة',
                ),
              if (company > 0)
                JournalLine(
                  accountId: sub.id,
                  credit: company,
                  memo: 'حصة الشركة ${formatPercent(p.percentBp)}٪',
                ),
            ],
          ),
        ),
      );
    }
    return out;
  }

  /// The W total of every sheet of the management spreadsheet except the
  /// management and agent sheets (one sheet per sub-agency, as the web
  /// ERP's agency sync).
  static Future<Map<String, int>> agencyTotals(
    Cycle cycle,
    SheetsApi sheets,
  ) async {
    final id = cycle.managementSpreadsheetId;
    if (id == null) {
      throw LedgerException('الدورة غير مرتبطة بجدول إدارة في Google');
    }
    final meta = await sheets.getSpreadsheet(id);
    final skip = {
      if (cycle.managementSheetName != null) cycle.managementSheetName!.trim(),
      if (cycle.agentSpreadsheetId == id && cycle.agentSheetName != null)
        cycle.agentSheetName!.trim(),
    };
    final titles = [for (final s in meta.sheets) s.title];
    final agencySheets =
        skip.isEmpty
            ? titles.skip(1)
            : titles.where((t) => !skip.contains(t.trim()));
    final out = <String, int>{};
    for (final t in agencySheets) {
      final rows = await sheets.valuesGet(
        id,
        "'${t.replaceAll("'", "''")}'!A:W",
      );
      var sum = 0;
      for (final row in rows) {
        if (normalizeUserId(cellAt(row, 0)).isEmpty) continue;
        sum += _cents(cellAt(row, 22));
      }
      out[t.trim()] = sum;
    }
    return out;
  }
}
