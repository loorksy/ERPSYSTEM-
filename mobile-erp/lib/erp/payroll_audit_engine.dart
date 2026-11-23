/// Line-by-line port of ERP `services/payrollAuditEngine.js`
/// (`runPayrollAuditCore` and helpers). The classification, salary, discount,
/// colors and the per-title grouping are identical to the ERP server.
library;

import 'js_compat.dart';
import 'normalize.dart';

typedef SheetRows = List<List<String>>;

const String typeAgent = 'سحب وكالة';
const String typeAgentTwo = 'سحب وكالة - راتبيين';
const String typeManagement = 'سحب إدارة';
const String typeNotFound = 'غير موجود';

const String statusAgent = 'سحب وكيل';
const String statusAgentTwo = 'سحب وكيل راتبين';
const String statusManagement = 'سحب ادارة';

/// Audit without the management sheet (owner's request 2026-11-23, 3.4.0):
/// a user found in the agent sheet whose salary there is 0 (or empty).
/// Takes the place of «سحب إدارة», which needs the management sheet;
/// written as the status with a salary of 0.
const String typeNoSalary = 'بدون راتب';
const String statusNoSalary = 'بدون راتب';

const String defaultAgentColor = '#8b5cf6';
const String defaultManagementColor = '#facc15';

bool isAgentType(String type) => type.startsWith(typeAgent);

/// ERP `isHeaderRowUserInfo`.
bool isHeaderRowUserInfo(List<String> row, int colC) {
  final c = normalizeForNumber(cellAt(row, colC));
  final n = jsParseFloat(c);
  return c.isEmpty || !jsIsFiniteNumber(n);
}

/// ERP `isHeaderRowCycle`.
bool isHeaderRowCycle(List<String> row, int? colIndex) {
  final col = colIndex ?? 0;
  final first = normalizeForNumber(cellAt(row, col) ?? '');
  if (first.isEmpty) return true;
  final n = jsParseFloat(first);
  return !jsIsFiniteNumber(n);
}

/// ERP `isHeaderRow` (agencySyncService / cycleAccountingService).
bool isHeaderRowGeneric(List<String>? row, int? colIdx) {
  if (row == null || colIdx == null) return true;
  final raw = cellAt(row, colIdx);
  final val = raw != null ? raw.trim() : '';
  if (val.isEmpty) return true;
  final normalized = normalizeUserId(val);
  if (normalized.isEmpty) return true;
  final n = jsParseFloat(normalized);
  return !jsIsFiniteNumber(n);
}

class AuditColumns {
  const AuditColumns({
    this.userInfoUserIdCol = 'C',
    this.userInfoTitleCol = 'D',
    this.userInfoSalaryCol = 'L',
    this.cycleMgmtUserIdCol = 'A',
    this.cycleAgentUserIdCol = 'A',
    this.cycleAgentSalaryCol = 'D',
  });

  final String userInfoUserIdCol;
  final String userInfoTitleCol;
  final String userInfoSalaryCol;
  final String cycleMgmtUserIdCol;
  final String cycleAgentUserIdCol;
  final String cycleAgentSalaryCol;

  static String _or(String? v, String d) => v == null || v.isEmpty ? d : v;

  factory AuditColumns.of({
    String? userInfoUserIdCol,
    String? userInfoTitleCol,
    String? userInfoSalaryCol,
    String? cycleMgmtUserIdCol,
    String? cycleAgentUserIdCol,
    String? cycleAgentSalaryCol,
  }) => AuditColumns(
    userInfoUserIdCol: _or(userInfoUserIdCol, 'C'),
    userInfoTitleCol: _or(userInfoTitleCol, 'D'),
    userInfoSalaryCol: _or(userInfoSalaryCol, 'L'),
    cycleMgmtUserIdCol: _or(cycleMgmtUserIdCol, 'A'),
    cycleAgentUserIdCol: _or(cycleAgentUserIdCol, 'A'),
    cycleAgentSalaryCol: _or(cycleAgentSalaryCol, 'D'),
  );
}

class AgentMatch {
  const AgentMatch(this.row, this.idx, this.sheetRowIndex);
  final List<String> row;
  final int idx;

  /// Zero-based row index in the agent sheet.
  final int sheetRowIndex;
}

class MgmtEntry {
  const MgmtEntry(this.row, this.sheetRowIndex);
  final List<String> row;

  /// Zero-based row index in the management sheet.
  final int sheetRowIndex;
}

class AuditResultRow {
  const AuditResultRow({
    required this.userId,
    required this.title,
    required this.type,
    required this.managementRow,
    required this.mgmtSheetRowIndex,
    required this.agentSheetRowIndices,
    required this.salaryValue,
    required this.statusLabel,
    required this.rowIndex,
  });

  final String userId;
  final String title;
  final String type;
  final List<String>? managementRow;
  final int? mgmtSheetRowIndex;
  final List<int> agentSheetRowIndices;

  /// `null` means the ERP empty string `''` (not written as a number).
  final double? salaryValue;
  final String statusLabel;

  /// One-based row number in the user-info sheet.
  final int rowIndex;
}

class TitleItem {
  const TitleItem(this.managementRow, this.color, this.type);
  final List<String> managementRow;
  final String color;
  final String type;
}

class AuditSummary {
  const AuditSummary({
    required this.total,
    required this.agent,
    required this.management,
    required this.notFound,
    this.noSalary = 0,
  });
  final int total;
  final int agent;
  final int management;
  final int notFound;

  /// «بدون راتب» (audit without the management sheet).
  final int noSalary;

  Map<String, Object?> toJson() => {
    'total': total,
    'agent': agent,
    'management': management,
    'notFound': notFound,
    'noSalary': noSalary,
  };

  static AuditSummary fromJson(Map<String, Object?> j) => AuditSummary(
    total: (j['total'] as num?)?.toInt() ?? 0,
    agent: (j['agent'] as num?)?.toInt() ?? 0,
    management: (j['management'] as num?)?.toInt() ?? 0,
    notFound: (j['notFound'] as num?)?.toInt() ?? 0,
    noSalary: (j['noSalary'] as num?)?.toInt() ?? 0,
  );
}

class AuditCoreOutput {
  AuditCoreOutput({
    required this.results,
    required this.byTitle,
    required this.titleOrder,
    required this.summary,
    required this.dataStart,
    required this.dataRows,
    required this.agentColorVal,
    required this.mgmtColorVal,
    required this.colC,
    required this.colD,
    required this.colL,
    required this.mgmtDataRows,
    required this.agentDataRows,
    required this.cycleMgmtCol,
    required this.cycleAgentCol,
    required this.mgmtByUserId,
    required this.agentByUserId,
  });

  final List<AuditResultRow> results;
  final Map<String, List<TitleItem>> byTitle;

  /// `Object.keys(byTitle)` order.
  final List<String> titleOrder;
  final AuditSummary summary;
  final int dataStart;
  final SheetRows dataRows;
  final String agentColorVal;
  final String mgmtColorVal;
  final int colC;
  final int colD;
  final int colL;
  final SheetRows mgmtDataRows;
  final SheetRows agentDataRows;
  final int cycleMgmtCol;
  final int cycleAgentCol;
  final Map<String, MgmtEntry> mgmtByUserId;
  final Map<String, List<AgentMatch>> agentByUserId;
}

/// ERP `runPayrollAuditCore`.
///
/// [emptyTitle] (owner's request, 2026-11-17): a user whose title column
/// (agency name, D) is empty goes to the sheet of that name («غير مذكور»)
/// instead of ERP's one-sheet-per-row «صف_N». Null keeps ERP's behaviour.
///
/// [withoutManagement] (owner's request 2026-11-23, 3.4.0; off = ERP): the
/// audit uses the user-info and agent sheets only. A user whose agent rows
/// add up to a salary is «سحب وكالة» as in ERP; one found in the agent
/// sheet with a salary of 0 (or empty) is «بدون راتب» (salary 0); one not
/// in the agent sheet, or a row without a user id, is «غير موجود». The
/// management sheet is not read, so nothing goes to the agency sheets
/// ([byTitle] is empty) and only agent rows are coloured.
AuditCoreOutput runPayrollAuditCore({
  required SheetRows managementRows,
  required SheetRows agentRows,
  required SheetRows userInfoRows,
  AuditColumns columns = const AuditColumns(),
  double discountRatePct = 0,
  String? agentColor,
  String? managementColor,
  String? emptyTitle,
  bool withoutManagement = false,
}) {
  if (withoutManagement) managementRows = const [];
  final colC = columnLetterToIndex(columns.userInfoUserIdCol) ?? 2;
  final colD = columnLetterToIndex(columns.userInfoTitleCol) ?? 3;
  final cycleMgmtCol = columnLetterToIndex(columns.cycleMgmtUserIdCol) ?? 0;
  final cycleAgentCol = columnLetterToIndex(columns.cycleAgentUserIdCol) ?? 0;
  final cycleAgentSalaryColIdx =
      columnLetterToIndex(columns.cycleAgentSalaryCol) ?? 3;

  final allRows = userInfoRows;
  final dataStart =
      allRows.isNotEmpty && isHeaderRowUserInfo(allRows[0], colC) ? 1 : 0;
  final dataRows = allRows.sublist(dataStart);

  final pct = discountRatePct.isNaN ? 0.0 : discountRatePct;
  final discountMultiplier = (1 - pct / 100).clamp(0.0, 1.0).toDouble();

  final agentHeaderRows =
      agentRows.isNotEmpty && isHeaderRowCycle(agentRows[0], cycleAgentCol)
          ? 1
          : 0;
  final agentDataRows = agentRows.sublist(agentHeaderRows);
  final agentByUserId = <String, List<AgentMatch>>{};
  for (var idx = 0; idx < agentDataRows.length; idx++) {
    final row = agentDataRows[idx];
    final id = normalizeUserId(cellAt(row, cycleAgentCol));
    if (id.isEmpty) continue;
    agentByUserId
        .putIfAbsent(id, () => <AgentMatch>[])
        .add(AgentMatch(row, idx, agentHeaderRows + idx));
  }

  final mgmtHeaderRows =
      managementRows.isNotEmpty &&
              isHeaderRowCycle(managementRows[0], cycleMgmtCol)
          ? 1
          : 0;
  final mgmtDataRows = managementRows.sublist(mgmtHeaderRows);
  final mgmtByUserId = <String, MgmtEntry>{};
  for (var idx = 0; idx < mgmtDataRows.length; idx++) {
    final row = mgmtDataRows[idx];
    final id = normalizeUserId(cellAt(row, cycleMgmtCol));
    // Like ERP: the last duplicate management row wins.
    if (id.isNotEmpty) mgmtByUserId[id] = MgmtEntry(row, mgmtHeaderRows + idx);
  }

  final agentColorVal =
      agentColor == null || agentColor.isEmpty ? '#3b82f6' : agentColor;
  final mgmtColorVal =
      managementColor == null || managementColor.isEmpty
          ? '#10b981'
          : managementColor;

  final label =
      emptyTitle == null || emptyTitle.trim().isEmpty
          ? null
          : emptyTitle.trim();
  final results = <AuditResultRow>[];
  final byTitle = <String, List<TitleItem>>{};
  final titleInsertion = <String>[];

  for (var i = 0; i < dataRows.length; i++) {
    final row = dataRows[i];
    final uid = normalizeUserId(cellAt(row, colC));
    final rawTitle = cellAt(row, colD);
    final trimmedTitle = (rawTitle ?? '').trim();
    final String title;
    if (label == null) {
      title = trimmedTitle.isNotEmpty ? trimmedTitle : 'صف_${i + 1}';
    } else {
      // Owner's «غير مذكور»: an empty cell, or the label typed by hand
      // (even with invisible direction marks or extra spaces from a copy),
      // all go to the one sheet of that name.
      final cleaned = _cleanTitle(trimmedTitle);
      title =
          cleaned.isEmpty || cleaned == _cleanTitle(label)
              ? label
              : trimmedTitle;
    }
    final agentMatches =
        uid.isNotEmpty
            ? (agentByUserId[uid] ?? const <AgentMatch>[])
            : const <AgentMatch>[];
    final mgmtEntry = uid.isNotEmpty ? mgmtByUserId[uid] : null;
    final mgmtRow = mgmtEntry?.row;
    final inAgent = agentMatches.isNotEmpty;
    final inMgmt = mgmtRow != null;

    var type = typeNotFound;
    double? salaryValue;
    var statusLabel = '';
    if (withoutManagement) {
      if (inAgent) {
        var sumRaw = 0.0;
        for (final m in agentMatches) {
          final v = cellAt(m.row, cycleAgentSalaryColIdx);
          final n = jsParseFloat(normalizeForNumber(v ?? ''));
          sumRaw += jsIsFiniteNumber(n) ? n : 0;
        }
        if (sumRaw != 0) {
          type = agentMatches.length > 1 ? typeAgentTwo : typeAgent;
          salaryValue = jsRound(sumRaw * discountMultiplier * 100) / 100;
          statusLabel = agentMatches.length > 1 ? statusAgentTwo : statusAgent;
        } else {
          type = typeNoSalary;
          salaryValue = 0;
          statusLabel = statusNoSalary;
        }
      }
    } else if (inAgent && inMgmt) {
      type = agentMatches.length > 1 ? typeAgentTwo : typeAgent;
      var sumRaw = 0.0;
      for (final m in agentMatches) {
        final v = cellAt(m.row, cycleAgentSalaryColIdx);
        final n = jsParseFloat(normalizeForNumber(v ?? ''));
        sumRaw += jsIsFiniteNumber(n) ? n : 0;
      }
      salaryValue = jsRound(sumRaw * discountMultiplier * 100) / 100;
      statusLabel = agentMatches.length > 1 ? statusAgentTwo : statusAgent;
    } else if (inMgmt) {
      type = typeManagement;
      salaryValue = 0;
      statusLabel = statusManagement;
    }

    results.add(
      AuditResultRow(
        userId: uid,
        title: title,
        type: type,
        managementRow: mgmtRow,
        mgmtSheetRowIndex: mgmtEntry?.sheetRowIndex,
        agentSheetRowIndices: [for (final m in agentMatches) m.sheetRowIndex],
        salaryValue: salaryValue,
        statusLabel: statusLabel,
        rowIndex: dataStart + i + 1,
      ),
    );

    if ((isAgentType(type) || type == typeManagement) && mgmtRow != null) {
      if (!byTitle.containsKey(title)) {
        byTitle[title] = <TitleItem>[];
        titleInsertion.add(title);
      }
      final rowColor = isAgentType(type) ? agentColorVal : mgmtColorVal;
      byTitle[title]!.add(TitleItem(mgmtRow, rowColor, type));
    }
  }

  final summary = AuditSummary(
    total: results.length,
    agent: results.where((r) => isAgentType(r.type)).length,
    management: results.where((r) => r.type == typeManagement).length,
    notFound: results.where((r) => r.type == typeNotFound).length,
    noSalary: results.where((r) => r.type == typeNoSalary).length,
  );

  return AuditCoreOutput(
    results: results,
    byTitle: byTitle,
    titleOrder: jsObjectKeyOrder(titleInsertion),
    summary: summary,
    dataStart: dataStart,
    dataRows: dataRows,
    agentColorVal: agentColorVal,
    mgmtColorVal: mgmtColorVal,
    colC: colC,
    colD: colD,
    colL: columnLetterToIndex(columns.userInfoSalaryCol) ?? 11,
    mgmtDataRows: mgmtDataRows,
    agentDataRows: agentDataRows,
    cycleMgmtCol: cycleMgmtCol,
    cycleAgentCol: cycleAgentCol,
    mgmtByUserId: mgmtByUserId,
    agentByUserId: agentByUserId,
  );
}

final RegExp _invisibleMarks = RegExp(
  '[\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069\u00A0]',
);

/// A title compared with the «غير مذكور» label: invisible marks removed,
/// spaces collapsed.
String _cleanTitle(String s) =>
    s.replaceAll(_invisibleMarks, ' ').replaceAll(RegExp(r'\s+'), ' ').trim();

class DuplicateCheck {
  const DuplicateCheck(this.duplicateIds, this.duplicateRowNumbers);
  final List<String> duplicateIds;
  final List<int> duplicateRowNumbers;
}

/// ERP `findDuplicateUserInfoMemberIds`.
DuplicateCheck findDuplicateUserInfoMemberIds(
  SheetRows userInfoRows,
  String? userInfoUserIdCol,
) {
  final colC =
      columnLetterToIndex(
        userInfoUserIdCol == null || userInfoUserIdCol.isEmpty
            ? 'C'
            : userInfoUserIdCol,
      ) ??
      2;
  final dataStart =
      userInfoRows.isNotEmpty && isHeaderRowUserInfo(userInfoRows[0], colC)
          ? 1
          : 0;
  final seen = <String>{};
  final duplicateIds = <String>[];
  final duplicateRowNumbers = <int>[];
  for (var i = dataStart; i < userInfoRows.length; i++) {
    final id = normalizeUserId(cellAt(userInfoRows[i], colC));
    if (id.isEmpty) continue;
    if (!seen.add(id)) {
      if (!duplicateIds.contains(id)) duplicateIds.add(id);
      duplicateRowNumbers.add(i + 1);
    }
  }
  return DuplicateCheck(duplicateIds, duplicateRowNumbers);
}

/// ERP `computeSalaryWithDiscount`.
({double before, double after}) computeSalaryWithDiscount(
  Iterable<String?> rawSalaries,
  double discountRatePct,
) {
  var sum = 0.0;
  for (final v in rawSalaries) {
    final n = jsParseFloat(normalizeForNumber(v));
    sum += jsIsFiniteNumber(n) ? n : 0;
  }
  final rate = discountRatePct.isNaN ? 0.0 : discountRatePct;
  final multiplier = (1 - rate / 100).clamp(0.0, 1.0).toDouble();
  final after = jsRound(sum * multiplier * 100) / 100;
  return (before: sum, after: after);
}

/// ERP `classifyManualStatus`.
({String status, String? source}) classifyManualStatus({
  required bool inMgmt,
  required bool inAgent,
  required bool mgmtColored,
  required bool agentColored,
}) {
  final hasAnyColor = mgmtColored || agentColored;
  if (!inMgmt && !inAgent) return (status: 'غير مدقق', source: null);
  if (!hasAnyColor) return (status: 'غير مدقق', source: null);
  if (agentColored && !mgmtColored) {
    return (status: 'مدقق', source: 'مدقق وكيل يدوي');
  }
  if (mgmtColored && !agentColored) {
    return (status: 'مدقق', source: 'مدقق ادارة يدوي');
  }
  return (status: 'مدقق', source: 'مدقق يدوي');
}

/// ERP `hexToRgb` (0–1 floats for the Sheets API).
Map<String, double> hexToRgb(String hex) {
  final h = hex.replaceFirst(RegExp('^#'), '');
  if (h.length != 6) return {'red': 1, 'green': 1, 'blue': 1};
  double part(int start) {
    final v = int.tryParse(h.substring(start, start + 2), radix: 16);
    return v == null ? 0 : v / 255;
  }

  return {'red': part(0), 'green': part(2), 'blue': part(4)};
}

/// ERP `safeHexColor` (search routes).
String safeHexColor(String? input, String fallback) {
  if (input == null || input.isEmpty) return fallback;
  var s = input.trim();
  if (s.startsWith('#')) s = s.substring(1);
  if (RegExp(r'^[0-9a-fA-F]{6}$').hasMatch(s)) return '#${s.toLowerCase()}';
  return fallback;
}

/// ERP `safeSheetTitle`.
String safeSheetTitle(String? title) {
  final base = (title == null || title.isEmpty) ? 'Sheet' : title;
  var s = base.replaceAll(RegExp(r'[:*?/\\]'), '_');
  if (s.length > 100) s = s.substring(0, 100);
  return s.isEmpty ? 'Sheet' : s;
}

/// Formats a salary like ERP's JSON / HTML output.
String formatSalary(double? v) => v == null ? '' : jsNumberToString(v);
