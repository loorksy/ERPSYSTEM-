import '../erp/normalize.dart';

/// Default columns of a workspace (owner's request, 2026-11-17): each
/// workspace (company) can lay its sheets out differently. The defaults are
/// the columns the app always used; they can be changed at any time in
/// Settings and are applied to the audit page.
class WorkspaceColumns {
  const WorkspaceColumns({
    this.userInfoUserIdCol = 'C',
    this.userInfoTitleCol = 'D',
    this.userInfoSalaryCol = 'L',
    this.userInfoStatusCol = '',
    this.mgmtUserIdCol = 'A',
    this.agentUserIdCol = 'A',
    this.agentSalaryCol = 'D',
    this.agentNameCol = 'C',
    this.mgmtShareCol = 'W',
    this.unmentionedLabel = 'غير مذكور',
    this.unmentionedIdCols = const ['A'],
    this.unmentionedLabelCols = const ['E'],
    this.unmentionedColor = defaultUnmentionedColor,
  });

  /// Orange: different from the agent (violet) and management (yellow)
  /// colours of the audit.
  static const defaultUnmentionedColor = '#f97316';

  /// User-info sheet: user id (ERP column C).
  final String userInfoUserIdCol;

  /// User-info sheet: agency name = target sheet (ERP column D).
  final String userInfoTitleCol;

  /// User-info sheet: salary written by the audit (ERP column L).
  final String userInfoSalaryCol;

  /// User-info sheet: status written by the audit; empty = the column
  /// after the salary (ERP default).
  final String userInfoStatusCol;

  final String mgmtUserIdCol;
  final String agentUserIdCol;
  final String agentSalaryCol;

  /// Agent sheet: user name shown in «غير المدققين» (column C).
  final String agentNameCol;

  /// Management sheet: sub-agent amount; «سحب غير الملوّن» skips rows where
  /// it is empty or zero (column W).
  final String mgmtShareCol;

  /// Written in the title column (and [unmentionedLabelCols]) for users
  /// added by «تدقيق غير المذكورين»; also the name of the sheet the rows
  /// go to in the management spreadsheet.
  final String unmentionedLabel;

  /// User-info columns that also receive the id of an added user (A).
  final List<String> unmentionedIdCols;

  /// User-info columns that also receive [unmentionedLabel] (E).
  final List<String> unmentionedLabelCols;

  /// Colour of the management rows pulled to «غير مذكور» (in the
  /// management sheet and on their copies), owner's request 2026-11-17.
  final String unmentionedColor;

  static const storageKey = 'workspaceColumnsV1';

  Map<String, Object?> toJson() => {
    'userInfoUserIdCol': userInfoUserIdCol,
    'userInfoTitleCol': userInfoTitleCol,
    'userInfoSalaryCol': userInfoSalaryCol,
    'userInfoStatusCol': userInfoStatusCol,
    'mgmtUserIdCol': mgmtUserIdCol,
    'agentUserIdCol': agentUserIdCol,
    'agentSalaryCol': agentSalaryCol,
    'agentNameCol': agentNameCol,
    'mgmtShareCol': mgmtShareCol,
    'unmentionedLabel': unmentionedLabel,
    'unmentionedIdCols': unmentionedIdCols,
    'unmentionedLabelCols': unmentionedLabelCols,
    'unmentionedColor': unmentionedColor,
  };

  static WorkspaceColumns fromJson(Object? j) {
    const d = WorkspaceColumns();
    if (j is! Map) return d;
    String col(String key, String fallback, {bool allowEmpty = false}) {
      final v = (j[key] as String?)?.trim().toUpperCase() ?? '';
      if (v.isEmpty) return allowEmpty ? '' : fallback;
      return columnLetterToIndex(v) == null ? fallback : v;
    }

    List<String> cols(String key, List<String> fallback) {
      final v = j[key];
      if (v is! List) return fallback;
      return [
        for (final x in v)
          if (columnLetterToIndex(x.toString().trim()) != null)
            x.toString().trim().toUpperCase(),
      ];
    }

    final label = (j['unmentionedLabel'] as String?)?.trim() ?? '';
    return WorkspaceColumns(
      userInfoUserIdCol: col('userInfoUserIdCol', d.userInfoUserIdCol),
      userInfoTitleCol: col('userInfoTitleCol', d.userInfoTitleCol),
      userInfoSalaryCol: col('userInfoSalaryCol', d.userInfoSalaryCol),
      userInfoStatusCol: col('userInfoStatusCol', '', allowEmpty: true),
      mgmtUserIdCol: col('mgmtUserIdCol', d.mgmtUserIdCol),
      agentUserIdCol: col('agentUserIdCol', d.agentUserIdCol),
      agentSalaryCol: col('agentSalaryCol', d.agentSalaryCol),
      agentNameCol: col('agentNameCol', d.agentNameCol),
      mgmtShareCol: col('mgmtShareCol', d.mgmtShareCol),
      unmentionedLabel: label.isEmpty ? d.unmentionedLabel : label,
      unmentionedIdCols: cols('unmentionedIdCols', d.unmentionedIdCols),
      unmentionedLabelCols: cols(
        'unmentionedLabelCols',
        d.unmentionedLabelCols,
      ),
      unmentionedColor: _color(j['unmentionedColor']),
    );
  }

  static String _color(Object? v) {
    final s = v?.toString().trim().toLowerCase() ?? '';
    return RegExp(r'^#[0-9a-f]{6}$').hasMatch(s) ? s : defaultUnmentionedColor;
  }

  /// Parses "A, E" into ["A", "E"]; null when a letter is invalid.
  static List<String>? parseColumnList(String text) {
    final out = <String>[];
    for (final part in text.split(RegExp(r'[,،\s]+'))) {
      final p = part.trim().toUpperCase();
      if (p.isEmpty) continue;
      if (columnLetterToIndex(p) == null) return null;
      if (!out.contains(p)) out.add(p);
    }
    return out;
  }

  /// A problem that would make the audit or the «غير مذكور» tools write
  /// in the wrong place, or null.
  String? validate() {
    if (userInfoUserIdCol == userInfoTitleCol) {
      return 'عمود رقم المستخدم وعمود اسم الورقة في جدول بيانات المستخدمين يجب أن يكونا مختلفين.';
    }
    final status =
        userInfoStatusCol.isEmpty
            ? columnIndexToLetter((columnLetterToIndex(userInfoSalaryCol)!) + 1)
            : userInfoStatusCol;
    if (status == userInfoSalaryCol) {
      return 'عمود الحالة يجب أن يختلف عن عمود الراتب.';
    }
    final written = {userInfoSalaryCol, status};
    for (final c in [
      userInfoUserIdCol,
      userInfoTitleCol,
      ...unmentionedIdCols,
      ...unmentionedLabelCols,
    ]) {
      if (written.contains(c)) {
        return 'العمود $c يُكتب فيه الراتب أو الحالة؛ اختر عمودًا آخر.';
      }
    }
    for (final c in unmentionedIdCols) {
      if (c == userInfoTitleCol || unmentionedLabelCols.contains(c)) {
        return 'العمود $c لا يمكن أن يحمل رقم المستخدم و«$unmentionedLabel» معًا.';
      }
    }
    if (unmentionedLabelCols.contains(userInfoUserIdCol)) {
      return 'عمود رقم المستخدم لا يمكن أن يُكتب فيه «$unmentionedLabel».';
    }
    return null;
  }
}
