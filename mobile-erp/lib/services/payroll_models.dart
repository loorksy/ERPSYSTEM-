import '../data/app_database.dart';
import '../erp/payroll_audit_engine.dart';

typedef Progress = void Function(String message);

/// Where the user-info table ("جدول بيانات المستخدمين") comes from.
sealed class UserInfoSource {
  const UserInfoSource();
}

class GoogleUserInfo extends UserInfoSource {
  const GoogleUserInfo(this.spreadsheetId, this.sheetName);
  final String spreadsheetId;

  /// Empty → first sheet (ERP «أول ورقة»).
  final String? sheetName;
}

class LocalUserInfo extends UserInfoSource {
  const LocalUserInfo(this.fileName, this.sheetName, this.rows);
  final String fileName;
  final String sheetName;
  final Rows rows;
}

class PayrollRequest {
  const PayrollRequest({
    required this.cycleId,
    required this.userInfo,
    required this.discountRate,
    required this.agentColor,
    required this.managementColor,
    required this.columns,
    this.userInfoStatusCol,
    this.forceReaudit = false,
    this.emptyTitle,
    this.withoutManagement = false,
  });

  final int cycleId;
  final UserInfoSource userInfo;

  /// `null` → saved settings (ERP `resolvePayrollDiscountRatePct`).
  final double? discountRate;
  final String agentColor;
  final String managementColor;
  final AuditColumns columns;
  final String? userInfoStatusCol;
  final bool forceReaudit;

  /// Sheet for users with an empty agency name (owner's request: the
  /// workspace's «غير مذكور»); null keeps ERP's «صف_N».
  final String? emptyTitle;

  /// Audit with the user-info and agent sheets only (owner's request
  /// 2026-11-23, 3.4.0): see `runPayrollAuditCore`. Off = ERP.
  final bool withoutManagement;

  /// Background jobs only run Google audits.
  Map<String, Object?> toJson() {
    final ui = userInfo;
    if (ui is! GoogleUserInfo) {
      throw StateError('Only Google audits are saved as jobs.');
    }
    return {
      'cycleId': cycleId,
      'spreadsheetId': ui.spreadsheetId,
      'sheetName': ui.sheetName,
      'discountRate': discountRate,
      'agentColor': agentColor,
      'managementColor': managementColor,
      'userInfoUserIdCol': columns.userInfoUserIdCol,
      'userInfoTitleCol': columns.userInfoTitleCol,
      'userInfoSalaryCol': columns.userInfoSalaryCol,
      'cycleMgmtUserIdCol': columns.cycleMgmtUserIdCol,
      'cycleAgentUserIdCol': columns.cycleAgentUserIdCol,
      'cycleAgentSalaryCol': columns.cycleAgentSalaryCol,
      'userInfoStatusCol': userInfoStatusCol,
      'forceReaudit': forceReaudit,
      'emptyTitle': emptyTitle,
      'withoutManagement': withoutManagement,
    };
  }

  static PayrollRequest fromJson(Map<String, Object?> j) => PayrollRequest(
    cycleId: (j['cycleId'] as num).toInt(),
    userInfo: GoogleUserInfo(
      j['spreadsheetId'] as String,
      j['sheetName'] as String?,
    ),
    discountRate: (j['discountRate'] as num?)?.toDouble(),
    agentColor: j['agentColor'] as String,
    managementColor: j['managementColor'] as String,
    columns: AuditColumns.of(
      userInfoUserIdCol: j['userInfoUserIdCol'] as String?,
      userInfoTitleCol: j['userInfoTitleCol'] as String?,
      userInfoSalaryCol: j['userInfoSalaryCol'] as String?,
      cycleMgmtUserIdCol: j['cycleMgmtUserIdCol'] as String?,
      cycleAgentUserIdCol: j['cycleAgentUserIdCol'] as String?,
      cycleAgentSalaryCol: j['cycleAgentSalaryCol'] as String?,
    ),
    userInfoStatusCol: j['userInfoStatusCol'] as String?,
    forceReaudit: j['forceReaudit'] == true,
    emptyTitle: j['emptyTitle'] as String?,
    withoutManagement: j['withoutManagement'] == true,
  );
}

class SampleCheck {
  const SampleCheck(this.userId, this.inMgmt, this.inAgent);
  final String userId;
  final bool inMgmt;
  final bool inAgent;
}

class PayrollDiagnostic {
  const PayrollDiagnostic({
    required this.managementUniqueCount,
    required this.agentUniqueCount,
    required this.userInfoUniqueCount,
    required this.sampleCheck,
  });
  final int managementUniqueCount;
  final int agentUniqueCount;
  final int userInfoUniqueCount;
  final List<SampleCheck> sampleCheck;

  Map<String, Object?> toJson() => {
    'm': managementUniqueCount,
    'a': agentUniqueCount,
    'u': userInfoUniqueCount,
    's': [
      for (final c in sampleCheck) [c.userId, c.inMgmt, c.inAgent],
    ],
  };

  static PayrollDiagnostic fromJson(Map<String, Object?> j) =>
      PayrollDiagnostic(
        managementUniqueCount: (j['m'] as num).toInt(),
        agentUniqueCount: (j['a'] as num).toInt(),
        userInfoUniqueCount: (j['u'] as num).toInt(),
        sampleCheck: [
          for (final c in (j['s'] as List? ?? const []))
            SampleCheck((c as List)[0].toString(), c[1] == true, c[2] == true),
        ],
      );
}

/// A user id that appears on more than one row of the user-info sheet.
/// [rows] are 1-based sheet rows; the first one is the row that is audited.
class DuplicateGroup {
  const DuplicateGroup(this.userId, this.rows);
  final String userId;
  final List<int> rows;

  int get firstRow => rows.first;
  List<int> get skippedRows => rows.sublist(1);

  List<Object?> toJson() => [userId, rows];
  static DuplicateGroup fromJson(Object? j) => DuplicateGroup(
    (j as List)[0].toString(),
    [for (final r in (j[1] as List)) (r as num).toInt()],
  );
}

class PayrollResult {
  PayrollResult({
    required this.success,
    required this.message,
    this.code,
    this.summary,
    this.applied = false,
    this.cycleSynced = false,
    this.localOnly = false,
    this.spreadsheetUrl,
    this.results = const [],
    this.sampleUserIds = const [],
    this.sampleMgmtIds = const [],
    this.sampleAgentIds = const [],
    this.diagnostic,
    this.duplicates = const [],
  });

  /// The same result with another message (incremental audit, 3.3.0).
  PayrollResult withMessage(String text) => PayrollResult(
    success: success,
    message: text,
    code: code,
    summary: summary,
    applied: applied,
    cycleSynced: cycleSynced,
    localOnly: localOnly,
    spreadsheetUrl: spreadsheetUrl,
    results: results,
    sampleUserIds: sampleUserIds,
    sampleMgmtIds: sampleMgmtIds,
    sampleAgentIds: sampleAgentIds,
    diagnostic: diagnostic,
    duplicates: duplicates,
  );

  factory PayrollResult.fail(String message, {String? code, String? url}) =>
      PayrollResult(
        success: false,
        message: message,
        code: code,
        spreadsheetUrl: url,
      );

  final bool success;
  final String message;
  final String? code;
  final AuditSummary? summary;
  final bool applied;
  final bool cycleSynced;
  final bool localOnly;
  final String? spreadsheetUrl;
  final List<AuditResultRow> results;
  final List<String> sampleUserIds;
  final List<String> sampleMgmtIds;
  final List<String> sampleAgentIds;
  final PayrollDiagnostic? diagnostic;
  final List<DuplicateGroup> duplicates;

  bool get unchanged => code == 'USER_INFO_UNCHANGED';

  Map<String, Object?> toLog() => {
    'success': success,
    'message': message,
    'summary': summary?.toJson(),
    'localOnly': localOnly,
    'spreadsheetUrl': spreadsheetUrl,
    'duplicates': duplicates.length,
  };

  Map<String, Object?> toJson() => {
    'success': success,
    'message': message,
    'code': code,
    'summary': summary?.toJson(),
    'applied': applied,
    'cycleSynced': cycleSynced,
    'localOnly': localOnly,
    'spreadsheetUrl': spreadsheetUrl,
    'results': [
      for (final r in results) [r.userId, r.title, r.type],
    ],
    'sampleUserIds': sampleUserIds,
    'sampleMgmtIds': sampleMgmtIds,
    'sampleAgentIds': sampleAgentIds,
    'diagnostic': diagnostic?.toJson(),
    'duplicates': [for (final d in duplicates) d.toJson()],
  };

  static PayrollResult fromJson(Map<String, Object?> j) {
    List<String> strings(Object? v) => [
      for (final x in (v as List? ?? const [])) x.toString(),
    ];
    final summary = j['summary'];
    final diagnostic = j['diagnostic'];
    return PayrollResult(
      success: j['success'] == true,
      message: (j['message'] ?? '').toString(),
      code: j['code'] as String?,
      summary:
          summary is Map
              ? AuditSummary.fromJson(Map<String, Object?>.from(summary))
              : null,
      applied: j['applied'] == true,
      cycleSynced: j['cycleSynced'] == true,
      localOnly: j['localOnly'] == true,
      spreadsheetUrl: j['spreadsheetUrl'] as String?,
      results: [
        for (final r in (j['results'] as List? ?? const []))
          AuditResultRow(
            userId: (r as List)[0].toString(),
            title: r[1].toString(),
            type: r[2].toString(),
            managementRow: null,
            mgmtSheetRowIndex: null,
            agentSheetRowIndices: const [],
            salaryValue: null,
            statusLabel: '',
            rowIndex: 0,
          ),
      ],
      sampleUserIds: strings(j['sampleUserIds']),
      sampleMgmtIds: strings(j['sampleMgmtIds']),
      sampleAgentIds: strings(j['sampleAgentIds']),
      diagnostic:
          diagnostic is Map
              ? PayrollDiagnostic.fromJson(
                Map<String, Object?>.from(diagnostic),
              )
              : null,
      duplicates: [
        for (final d in (j['duplicates'] as List? ?? const []))
          DuplicateGroup.fromJson(d),
      ],
    );
  }
}

/// The writes of one Google audit, computed once and then executed step
/// by step so an interrupted audit resumes where it stopped.
class AuditPlan {
  AuditPlan({
    required this.cycleId,
    required this.steps,
    required this.next,
    required this.result,
    required this.finish,
  });

  final int cycleId;

  /// Each step: `{'k': kind, ...}`; see `PayrollService.runStep`.
  final List<Map<String, Object?>> steps;

  /// Index of the first step that has not completed yet.
  int next;

  /// The audit result shown when every step is done.
  final PayrollResult result;

  /// Data saved on the phone by the last step (statuses, cache, hash).
  final Map<String, Object?> finish;

  bool get complete => next >= steps.length;

  Map<String, Object?> toJson() => {
    'cycleId': cycleId,
    'steps': steps,
    'next': next,
    'result': result.toJson(),
    'finish': finish,
  };

  static AuditPlan fromJson(Map<String, Object?> j) => AuditPlan(
    cycleId: (j['cycleId'] as num).toInt(),
    steps: [
      for (final s in (j['steps'] as List)) Map<String, Object?>.from(s as Map),
    ],
    next: (j['next'] as num).toInt(),
    result: PayrollResult.fromJson(
      Map<String, Object?>.from(j['result'] as Map),
    ),
    finish: Map<String, Object?>.from(j['finish'] as Map),
  );
}

/// An agent-sheet user who has no «مدقق» status in the cycle yet.
class PendingMember {
  const PendingMember(this.id, this.name, this.row);
  final String id;

  /// Column C of the agent sheet.
  final String name;

  /// 1-based row in the agent sheet (first occurrence).
  final int row;
}

class PendingAgentMembers {
  const PendingAgentMembers(this.members, this.agentTotal);

  /// Not audited yet, in agent-sheet order.
  final List<PendingMember> members;

  /// Distinct user ids in the agent sheet.
  final int agentTotal;
}

/// Kinds of background job (the request JSON carries `kind`).
abstract final class JobKind {
  /// The bulk audit (ERP `payroll-execute`). Jobs saved before 2.4.0 have
  /// no kind and are audits.
  static const audit = 'audit';

  /// Owner's request (2026-11-17): agent-sheet users missing from the
  /// user-info sheet are added to it as «غير مذكور», then audited.
  static const unmentionedUsers = 'unmentionedUsers';

  /// Owner's request (2026-11-17): management rows not coloured (not
  /// audited) with a value in the sub-agent column (W) are copied to the
  /// «غير مذكور» sheet.
  static const unmentionedMgmt = 'unmentionedMgmt';

  /// «إضافات وخصومات» (ERP member adjustments, bulk): not tied to a cycle.
  static const adjustments = 'adjustments';

  static String of(Map<String, Object?> request) =>
      (request['kind'] as String?) ?? audit;

  static String title(String kind) => switch (kind) {
    unmentionedUsers => 'تدقيق غير المذكورين',
    unmentionedMgmt => 'نقل سجلات الإدارة غير الملوّنة',
    adjustments => 'تطبيق التسويات',
    _ => 'التدقيق',
  };
}

/// Columns and label used by the «غير مذكور» tools (workspace settings).
class UnmentionedOptions {
  const UnmentionedOptions({
    this.label = 'غير مذكور',
    this.idCols = const ['A'],
    this.labelCols = const ['E'],
    this.shareCol = 'W',
    this.color = '#f97316',
  });

  /// Colour of the pulled management rows and of their copies.
  final String color;

  /// Written in the title column (it routes the copy to the sheet of the
  /// same name in the management spreadsheet) and in [labelCols].
  final String label;

  /// User-info columns that also receive the user id (besides the id
  /// column of the audit).
  final List<String> idCols;

  /// User-info columns that also receive [label] (besides the title column).
  final List<String> labelCols;

  /// Management column holding the sub-agent amount; rows where it is empty
  /// or zero are not pulled.
  final String shareCol;

  Map<String, Object?> toJson() => {
    'label': label,
    'idCols': idCols,
    'labelCols': labelCols,
    'shareCol': shareCol,
    'color': color,
  };

  static UnmentionedOptions fromJson(Object? j) {
    if (j is! Map) return const UnmentionedOptions();
    List<String> list(Object? v, List<String> d) =>
        v is List ? [for (final x in v) x.toString()] : d;
    final label = (j['label'] as String?)?.trim() ?? '';
    return UnmentionedOptions(
      label: label.isEmpty ? 'غير مذكور' : label,
      idCols: list(j['idCols'], const ['A']),
      labelCols: list(j['labelCols'], const ['E']),
      shareCol: (j['shareCol'] as String?) ?? 'W',
      color: (j['color'] as String?) ?? '#f97316',
    );
  }
}
