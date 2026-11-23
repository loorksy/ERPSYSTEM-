import '../data/app_database.dart';
import '../erp/normalize.dart';
import '../erp/payroll_audit_engine.dart';
import '../google/sheets_client.dart';
import 'payroll_service.dart';

class CycleSearchHit {
  const CycleSearchHit({
    required this.cycleId,
    required this.cycleName,
    required this.memberId,
    required this.name,
    required this.logicalStatus,
    required this.salaryBefore,
    required this.salaryAfter,
    required this.auditStatus,
    required this.auditSource,
    required this.inMgmt,
    required this.inAgent,
  });
  final int cycleId;
  final String cycleName;
  final String memberId;
  final String? name;
  final String logicalStatus;
  final double salaryBefore;
  final double salaryAfter;
  final String auditStatus;
  final String? auditSource;
  final bool inMgmt;
  final bool inAgent;

  bool get canAudit =>
      logicalStatus != typeNotFound &&
      (auditStatus.isEmpty || auditStatus == 'غير مدقق');
}

/// A member of «دليل الأعضاء».
class MemberSummary {
  const MemberSummary({
    required this.id,
    required this.name,
    required this.cycles,
    required this.lastCycle,
    required this.lastSalary,
  });
  final String id;
  final String name;
  final int cycles;
  final String lastCycle;
  final double lastSalary;
}

class SearchOutcome {
  const SearchOutcome.ok(this.hits) : message = null;
  const SearchOutcome.fail(this.message) : hits = const [];
  final List<CycleSearchHit> hits;
  final String? message;
  bool get success => message == null;
}

class IndividualAuditResult {
  const IndividualAuditResult(this.success, this.message);
  final bool success;
  final String message;
}

/// Port of ERP `routes/search.js`: user search inside one cycle or across
/// all cycles, and the selective (individual) audit.
class SearchService {
  SearchService(this.db, this.sheetsProvider);

  final AppDatabase db;
  final SheetsApi Function() sheetsProvider;

  /// Like ERP, the search reads only the cycle cache (`payroll_cycle_cache`),
  /// filled by the bulk audit and by the background cycle sync.
  Future<({Rows mgmt, Rows agent, CycleCache? cache})?> _data(
    Cycle cycle,
  ) async {
    final cache = await db.getCycleCache(cycle.id);
    if (cache == null) return null;
    return (mgmt: cache.managementData, agent: cache.agentData, cache: cache);
  }

  /// ERP always treats the first row as the header (`slice(1)`).
  static Rows _dataRows(Rows rows) =>
      rows.length > 1 ? rows.sublist(1) : const <List<String>>[];

  Future<CycleSearchHit?> _searchInCycle(
    Cycle cycle,
    String queryId,
    double discountRate,
  ) async {
    final data = await _data(cycle);
    if (data == null) return null;
    final cols = await db.getCycleColumns(cycle.id);
    final mgmtColIdx = columnLetterToIndex(cols.mgmtUserIdCol) ?? 0;
    final agentUserColIdx = columnLetterToIndex(cols.agentUserIdCol) ?? 0;
    final agentSalaryColIdx = columnLetterToIndex(cols.agentSalaryCol) ?? 3;
    var inMgmt = false;
    var inAgent = false;
    final agentSalaryCells = <String?>[];
    String? name;
    String? canonicalId;
    for (final row in _dataRows(data.mgmt)) {
      final id = normalizeUserId(cellAt(row, mgmtColIdx));
      if (id.isNotEmpty && id == queryId) {
        inMgmt = true;
        canonicalId ??= id;
        final n = cellAt(row, 1);
        if (name == null && n != null && n.isNotEmpty) name = n;
      }
    }
    for (final row in _dataRows(data.agent)) {
      final id = normalizeUserId(cellAt(row, agentUserColIdx));
      if (id.isNotEmpty && id == queryId) {
        inAgent = true;
        canonicalId ??= id;
        final n = cellAt(row, 1);
        if (name == null && n != null && n.isNotEmpty) name = n;
        agentSalaryCells.add(cellAt(row, agentSalaryColIdx));
      }
    }
    if (!inMgmt && !inAgent) return null;
    final salary = computeSalaryWithDiscount(agentSalaryCells, discountRate);
    var logicalStatus = typeNotFound;
    if (inAgent && inMgmt) {
      logicalStatus =
          agentSalaryCells.length > 1 ? statusAgentTwo : statusAgent;
    } else if (inMgmt) {
      logicalStatus = statusManagement;
    }
    final cache = data.cache;
    final manual = classifyManualStatus(
      inMgmt: inMgmt,
      inAgent: inAgent,
      mgmtColored: cache?.auditedMgmtIds.contains(queryId) ?? false,
      agentColored: cache?.auditedAgentIds.contains(queryId) ?? false,
    );
    final cached = await db.getUserAuditStatus(
      cycle.id,
      canonicalId ?? queryId,
    );
    return CycleSearchHit(
      cycleId: cycle.id,
      cycleName: cycle.name.isEmpty ? 'دورة #${cycle.id}' : cycle.name,
      memberId: canonicalId ?? queryId,
      name: name,
      logicalStatus: logicalStatus,
      salaryBefore: salary.before,
      salaryAfter: salary.after,
      auditStatus: cached?.status ?? manual.status,
      auditSource: cached?.source ?? manual.source,
      inMgmt: inMgmt,
      inAgent: inAgent,
    );
  }

  /// ERP `GET /search-user`.
  Future<SearchOutcome> searchUser(
    int cycleId,
    String userIdRaw,
    double discountRate,
  ) async {
    final queryId = normalizeUserId(userIdRaw);
    if (queryId.isEmpty) {
      return const SearchOutcome.fail('رقم المستخدم غير صالح');
    }
    final cycle = await db.getCycleInfo(cycleId);
    if (cycle == null) return const SearchOutcome.fail('الدورة غير موجودة');
    if (!await db.hasCycleCache(cycle.id)) {
      return const SearchOutcome.fail(
        'لم تتم مزامنة الدورة بعد. انتظر المزامنة التلقائية أو نفّذ التدقيق من شاشة التدقيق.',
      );
    }
    final hit = await _searchInCycle(cycle, queryId, discountRate);
    if (hit == null) {
      return SearchOutcome.ok([
        CycleSearchHit(
          cycleId: cycle.id,
          cycleName: cycle.name,
          memberId: queryId,
          name: null,
          logicalStatus: typeNotFound,
          salaryBefore: 0,
          salaryAfter: 0,
          auditStatus: 'غير مدقق',
          auditSource: null,
          inMgmt: false,
          inAgent: false,
        ),
      ]);
    }
    return SearchOutcome.ok([hit]);
  }

  /// ERP `GET /user-across-cycles` (every cycle is checked).
  Future<SearchOutcome> searchAcrossCycles(
    String userIdRaw,
    double discountRate,
  ) async {
    final queryId = normalizeUserId(userIdRaw);
    if (queryId.isEmpty) {
      return const SearchOutcome.fail('رقم المستخدم غير صالح');
    }
    final hits = <CycleSearchHit>[];
    for (final cycle in await db.listCycles()) {
      final hit = await _searchInCycle(cycle, queryId, discountRate);
      if (hit != null) hits.add(hit);
    }
    if (hits.isEmpty) {
      return const SearchOutcome.fail(
        'رقم المستخدم غير موجود في أي دورة مالية حالية',
      );
    }
    return SearchOutcome.ok(hits);
  }

  /// «دليل الأعضاء» (LorkERP): every member found in the cached sheets of
  /// the cycles, newest cycle first: id, name, how many cycles, and the
  /// agent-sheet salary (before discount) in the latest cycle.
  Future<List<MemberSummary>> members() async {
    final byId = <String, MemberSummary>{};
    final cycles = await db.listCycles();
    for (final cycle in cycles) {
      var data = await _data(cycle);
      if (data == null) {
        // A cycle made from files keeps its sheets in the cycle itself.
        final full = await db.getCycle(cycle.id);
        if (full == null ||
            (full.managementRows.isEmpty && full.agentRows.isEmpty)) {
          continue;
        }
        data = (mgmt: full.managementRows, agent: full.agentRows, cache: null);
      }
      final cols = await db.getCycleColumns(cycle.id);
      final mgmtCol = columnLetterToIndex(cols.mgmtUserIdCol) ?? 0;
      final agentCol = columnLetterToIndex(cols.agentUserIdCol) ?? 0;
      final salaryCol = columnLetterToIndex(cols.agentSalaryCol) ?? 3;
      final seen = <String>{};
      final salaries = <String, List<String?>>{};
      final names = <String, String>{};
      void take(List<String> row, int col, {bool agent = false}) {
        final id = normalizeUserId(cellAt(row, col));
        if (id.isEmpty) return;
        seen.add(id);
        final n = cellAt(row, 1);
        if (n != null && n.trim().isNotEmpty) {
          names.putIfAbsent(id, () => n.trim());
        }
        if (agent) {
          salaries.putIfAbsent(id, () => []).add(cellAt(row, salaryCol));
        }
      }

      for (final row in _dataRows(data.mgmt)) {
        take(row, mgmtCol);
      }
      for (final row in _dataRows(data.agent)) {
        take(row, agentCol, agent: true);
      }
      final cycleName = cycle.name.isEmpty ? 'دورة #${cycle.id}' : cycle.name;
      for (final id in seen) {
        final old = byId[id];
        final salary =
            computeSalaryWithDiscount(salaries[id] ?? const [], 0).before;
        byId[id] =
            old == null
                ? MemberSummary(
                  id: id,
                  name: names[id] ?? '',
                  cycles: 1,
                  lastCycle: cycleName,
                  lastSalary: salary,
                )
                : MemberSummary(
                  id: id,
                  name: old.name.isEmpty ? (names[id] ?? '') : old.name,
                  cycles: old.cycles + 1,
                  lastCycle: old.lastCycle,
                  lastSalary: old.lastSalary,
                );
      }
    }
    return byId.values.toList();
  }

  /// ERP `GET /cycle-sheets`: sheets of the cycle's management spreadsheet.
  Future<List<String>> cycleSheets(int cycleId) async {
    final cycle = await db.getCycleInfo(cycleId);
    if (cycle == null) return const [];
    if (cycle.managementSpreadsheetId != null) {
      final meta = await withSheetsRetry(
        () => sheetsProvider().getSpreadsheet(cycle.managementSpreadsheetId!),
      );
      return [for (final s in meta.sheets) s.title];
    }
    final book = LocalWorkbookState.fromJson(
      await db.getLocalWorkbook(cycleId),
    );
    return book.targets.keys.toList();
  }

  /// ERP `POST /execute-audit-advanced` (selective audit of one user).
  Future<IndividualAuditResult> executeIndividual({
    required int cycleId,
    required String memberIdRaw,
    required String targetSheetTitle,
    required bool createIfMissing,
    required String agentColor,
    required String managementColor,
    double discountRate = 0,
  }) async {
    try {
      return await _executeIndividual(
        cycleId: cycleId,
        memberIdRaw: memberIdRaw,
        targetSheetTitle: targetSheetTitle,
        createIfMissing: createIfMissing,
        agentColor: agentColor,
        managementColor: managementColor,
        discountRate: discountRate,
      );
    } catch (e) {
      return IndividualAuditResult(false, e.toString());
    }
  }

  Future<IndividualAuditResult> _executeIndividual({
    required int cycleId,
    required String memberIdRaw,
    required String targetSheetTitle,
    required bool createIfMissing,
    required String agentColor,
    required String managementColor,
    required double discountRate,
  }) async {
    final member = normalizeUserId(memberIdRaw);
    if (member.isEmpty) {
      return const IndividualAuditResult(
        false,
        'اختر الدورة وأدخل رقم المستخدم أولاً',
      );
    }
    final cycle = await db.getCycleInfo(cycleId);
    if (cycle == null) {
      return const IndividualAuditResult(false, 'الدورة غير موجودة');
    }
    final data = await _data(cycle);
    if (data == null) {
      return const IndividualAuditResult(
        false,
        'لم تتم مزامنة هذه الدورة بعد. انتظر المزامنة التلقائية أو حمّل الدورة من شاشة التدقيق.',
      );
    }
    final cols = await db.getCycleColumns(cycleId);
    final mgmtIdx = columnLetterToIndex(cols.mgmtUserIdCol) ?? 0;
    final agentIdx = columnLetterToIndex(cols.agentUserIdCol) ?? 0;
    final agentSalaryIdx = columnLetterToIndex(cols.agentSalaryCol) ?? 3;

    // ERP skips the first row of both sheets (`slice(1)`).
    const mgmtHeader = 1;
    const agentHeader = 1;
    List<String>? mgmtRow;
    final mgmtRowIndices = <int>[];
    for (var i = mgmtHeader; i < data.mgmt.length; i++) {
      final id = normalizeUserId(cellAt(data.mgmt[i], mgmtIdx));
      if (id.isNotEmpty && id == member) {
        mgmtRow ??= data.mgmt[i];
        mgmtRowIndices.add(i);
      }
    }
    final agentMatches = <List<String>>[];
    final agentRowIndices = <int>[];
    for (var i = agentHeader; i < data.agent.length; i++) {
      final id = normalizeUserId(cellAt(data.agent[i], agentIdx));
      if (id.isNotEmpty && id == member) {
        agentMatches.add(data.agent[i]);
        agentRowIndices.add(i);
      }
    }
    final inMgmt = mgmtRow != null;
    final inAgent = agentMatches.isNotEmpty;
    if (!inMgmt && !inAgent) {
      return const IndividualAuditResult(
        false,
        'هذا المستخدم غير موجود في بيانات الدورة المختارة',
      );
    }
    final salary = computeSalaryWithDiscount([
      for (final r in agentMatches) cellAt(r, agentSalaryIdx),
    ], discountRate);
    var statusLabel = typeNotFound;
    if (inAgent && inMgmt) {
      statusLabel = agentMatches.length > 1 ? statusAgentTwo : statusAgent;
    } else if (inMgmt) {
      statusLabel = statusManagement;
    }
    final targetTitle = targetSheetTitle.trim();
    if (targetTitle.isEmpty) {
      return const IndividualAuditResult(
        false,
        'أدخل اسم الورقة الهدف في جدول الإدارة',
      );
    }
    final baseAgent = safeHexColor(agentColor, defaultAgentColor);
    final baseMgmt = safeHexColor(managementColor, defaultManagementColor);
    final rowColor = statusLabel == statusManagement ? baseMgmt : baseAgent;
    final mgmtSourceColor =
        statusLabel.startsWith(statusAgent) ? baseAgent : baseMgmt;

    String message;
    if (cycle.managementSpreadsheetId != null) {
      message = await _individualGoogle(
        cycle: cycle,
        data: data,
        member: member,
        mgmtIdx: mgmtIdx,
        agentIdx: agentIdx,
        mgmtRow: mgmtRow,
        inMgmt: inMgmt,
        inAgent: inAgent,
        targetTitle: targetTitle,
        createIfMissing: createIfMissing,
        rowColor: rowColor,
        mgmtSourceColor: mgmtSourceColor,
        agentColor: baseAgent,
      );
    } else {
      final book = LocalWorkbookState.fromJson(
        await db.getLocalWorkbook(cycleId),
      );
      String? existingName;
      for (final k in book.targets.keys) {
        if (k == targetTitle) existingName = k;
      }
      if (existingName == null && !createIfMissing) {
        return const IndividualAuditResult(
          false,
          'اسم الورقة غير موجود واخترت عدم إنشائها. اكتب اسم ورقة جديدة أو اختر ورقة أخرى.',
        );
      }
      final target = book.targets.putIfAbsent(targetTitle, () => <TargetRow>[]);
      final existingIds = <String>{
        for (var i = 1; i < target.length; i++)
          normalizeUserId(cellAt(target[i].values, mgmtIdx)),
      };
      if (target.isNotEmpty &&
          !isHeaderRowGeneric(target.first.values, mgmtIdx)) {
        existingIds.add(normalizeUserId(cellAt(target.first.values, mgmtIdx)));
      }
      if (mgmtRow != null && !existingIds.contains(member)) {
        target.add(TargetRow(List<String>.from(mgmtRow), rowColor));
        message =
            'تم تنفيذ التدقيق الانتقائي في ملف الدورة على الهاتف وتحديث حالة البحث';
      } else {
        message =
            'المستخدم موجود مسبقاً في الورقة الهدف. لم يُكرر الصف، وحُدّثت الألوان والحالة.';
      }
      if (inMgmt) {
        for (final i in mgmtRowIndices) {
          book.mgmtColors[i] = mgmtSourceColor;
        }
      }
      if (inAgent) {
        for (final i in agentRowIndices) {
          book.agentColors[i] = baseAgent;
        }
      }
      await db.saveLocalWorkbook(cycleId, book.toJson());
    }

    final cache = data.cache;
    final auditedAgent = {...?cache?.auditedAgentIds};
    final auditedMgmt = {...?cache?.auditedMgmtIds};
    if (inAgent) auditedAgent.add(member);
    if (inMgmt) auditedMgmt.add(member);
    await db.saveUserAuditStatuses(cycleId, [
      AuditEntry(member, 'مدقق', 'تدقيق من أداة البحث', {
        'statusLabel': statusLabel,
        'targetSheetTitle': targetTitle,
        'salaryBefore': salary.before,
        'salaryAfter': salary.after,
      }),
    ]);
    await db.saveCycleCache(
      cycleId,
      CycleCache(
        managementData: data.mgmt,
        agentData: data.agent,
        managementSheetName:
            cache?.managementSheetName ?? cycle.managementSheetName,
        agentSheetName: cache?.agentSheetName ?? cycle.agentSheetName,
        auditedAgentIds: auditedAgent,
        auditedMgmtIds: auditedMgmt,
        foundInTargetSheetIds: cache?.foundInTargetSheetIds ?? {member},
      ),
    );
    return IndividualAuditResult(true, message);
  }

  Future<String> _individualGoogle({
    required Cycle cycle,
    required ({Rows mgmt, Rows agent, CycleCache? cache}) data,
    required String member,
    required int mgmtIdx,
    required int agentIdx,
    required List<String>? mgmtRow,
    required bool inMgmt,
    required bool inAgent,
    required String targetTitle,
    required bool createIfMissing,
    required String rowColor,
    required String mgmtSourceColor,
    required String agentColor,
  }) async {
    final sheets = sheetsProvider();
    final spreadsheetId = cycle.managementSpreadsheetId!;
    final meta = await withSheetsRetry(
      () => sheets.getSpreadsheet(spreadsheetId),
    );
    SheetProps? found;
    for (final s in meta.sheets) {
      if (s.title == targetTitle) found = s;
    }
    if (found == null && !createIfMissing) {
      throw Exception(
        'اسم الورقة غير موجود واخترت عدم إنشائها. اكتب اسم ورقة جديدة أو اختر ورقة أخرى.',
      );
    }
    if (found == null) {
      final replies = await withSheetsRetry(
        () => sheets.batchUpdate(spreadsheetId, [
          {
            'addSheet': {
              'properties': {'title': targetTitle},
            },
          },
        ]),
      );
      final props =
          replies.isEmpty
              ? null
              : (replies.first['addSheet'] as Map?)?['properties'] as Map?;
      if (props == null || props['sheetId'] is! num) {
        throw Exception('فشل إنشاء الورقة الجديدة في جدول الإدارة');
      }
      found = SheetProps(
        (props['sheetId'] as num).toInt(),
        targetTitle,
        ((props['gridProperties'] as Map?)?['columnCount'] as num?)?.toInt(),
      );
    }
    final range = rangeWholeSheet(targetTitle);
    final existingRows = await withSheetsRetry(
      () => sheets.valuesGet(spreadsheetId, range),
    );
    final existingIds = <String>{};
    // Bug fix: ERP skipped row 1 even in target sheets the bulk audit wrote
    // without a header, so that first user could be copied twice.
    for (var idx = 0; idx < existingRows.length; idx++) {
      if (idx == 0 && isHeaderRowGeneric(existingRows[0], mgmtIdx)) continue;
      final id = normalizeUserId(cellAt(existingRows[idx], mgmtIdx));
      if (id.isNotEmpty) existingIds.add(id);
    }
    String message;
    if (mgmtRow != null && !existingIds.contains(member)) {
      final updatedRange = await withSheetsRetry(
        () => sheets.valuesAppend(spreadsheetId, range, [mgmtRow]),
      );
      try {
        final start =
            updatedRange != null
                ? parseRangeStartRowIndex0(updatedRange)
                : existingRows.length;
        await withSheetsRetry(
          () => sheets.batchUpdate(spreadsheetId, [
            colorRowRequest(
              found!.sheetId,
              start,
              rowColor,
              // append widens the grid to the row when needed
              endColumn: [
                mgmtRow.length,
                found.columnCount ?? 0,
                1,
              ].reduce((a, b) => a > b ? a : b).clamp(1, 200),
            ),
          ]),
        );
      } catch (_) {}
      message = 'تم تنفيذ التدقيق الانتقائي في جدول الإدارة وتحديث حالة البحث';
    } else {
      message =
          'المستخدم موجود مسبقاً في الورقة الهدف. لم يُكرر الصف، وحُدّثت الألوان والحالة.';
    }

    // Color the original rows in the management and agent sheets.
    try {
      final mgmtSheetName =
          data.cache?.managementSheetName ?? cycle.managementSheetName;
      final agentSheetName = data.cache?.agentSheetName ?? cycle.agentSheetName;
      if (mgmtSheetName != null && inMgmt) {
        await _colorMatchingRows(
          sheets,
          spreadsheetId,
          mgmtSheetName,
          mgmtIdx,
          member,
          mgmtSourceColor,
        );
      }
      final agentSs = cycle.agentSpreadsheetId ?? spreadsheetId;
      if (agentSheetName != null && inAgent) {
        await _colorMatchingRows(
          sheets,
          agentSs,
          agentSheetName,
          agentIdx,
          member,
          agentColor,
        );
      }
    } catch (_) {}
    return message;
  }

  Future<void> _colorMatchingRows(
    SheetsApi sheets,
    String spreadsheetId,
    String sheetName,
    int idCol,
    String member,
    String color,
  ) async {
    final meta = await withSheetsRetry(
      () => sheets.getSpreadsheet(spreadsheetId),
    );
    final sheetId = getSheetIdByTitle(meta, sheetName);
    if (sheetId == null) return;
    final rows = await withSheetsRetry(
      () => sheets.valuesGet(spreadsheetId, rangeWholeSheet(sheetName)),
    );
    final requests = <Map<String, dynamic>>[];
    for (var idx = 1; idx < rows.length; idx++) {
      if (normalizeUserId(cellAt(rows[idx], idCol)) == member) {
        requests.add(
          colorRowRequest(
            sheetId,
            idx,
            color,
            endColumn: colorEndColumn(meta, sheetId),
          ),
        );
      }
    }
    if (requests.isNotEmpty) {
      await withSheetsRetry(() => sheets.batchUpdate(spreadsheetId, requests));
    }
  }
}
