// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'dart:convert';

import 'package:flutter/material.dart';

import '../app_services.dart';
import '../data/app_database.dart';
import '../erp/normalize.dart';
import '../google/sheets_client.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';
import 'help.dart';
import 'ui_kit.dart';

/// Settings → the columns of the open workspace (owner's request,
/// 2026-11-17). Defaults are the columns the app always used; saving them
/// applies them to the audit page right away.
class ColumnsPage extends StatefulWidget {
  const ColumnsPage({super.key});
  @override
  State<ColumnsPage> createState() => _ColumnsPageState();
}

class _ColumnsPageState extends State<ColumnsPage> {
  WorkspaceColumns? _c;
  final _label = TextEditingController();

  /// Extra columns of «غير المذكورين», chosen with «+» (owner, 3.3.1).
  List<String> _idCols = const [];
  List<String> _labelCols = const [];
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _label.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final c = await AppScope.read(context).db.getWorkspaceColumns();
    if (mounted) _show(c);
    _loadHeads();
  }

  void _show(WorkspaceColumns c) {
    setState(() {
      _c = c;
      _label.text = c.unmentionedLabel;
      _idCols = [...c.unmentionedIdCols];
      _labelCols = [...c.unmentionedLabelCols];
    });
  }

  WorkspaceColumns _with({
    String? userInfoUserIdCol,
    String? userInfoTitleCol,
    String? userInfoSalaryCol,
    String? userInfoStatusCol,
    String? mgmtUserIdCol,
    String? agentUserIdCol,
    String? agentSalaryCol,
    String? agentNameCol,
    String? mgmtShareCol,
    String? unmentionedColor,
  }) {
    final c = _c!;
    return WorkspaceColumns(
      userInfoUserIdCol: userInfoUserIdCol ?? c.userInfoUserIdCol,
      userInfoTitleCol: userInfoTitleCol ?? c.userInfoTitleCol,
      userInfoSalaryCol: userInfoSalaryCol ?? c.userInfoSalaryCol,
      userInfoStatusCol: userInfoStatusCol ?? c.userInfoStatusCol,
      mgmtUserIdCol: mgmtUserIdCol ?? c.mgmtUserIdCol,
      agentUserIdCol: agentUserIdCol ?? c.agentUserIdCol,
      agentSalaryCol: agentSalaryCol ?? c.agentSalaryCol,
      agentNameCol: agentNameCol ?? c.agentNameCol,
      mgmtShareCol: mgmtShareCol ?? c.mgmtShareCol,
      unmentionedLabel: c.unmentionedLabel,
      unmentionedIdCols: c.unmentionedIdCols,
      unmentionedLabelCols: c.unmentionedLabelCols,
      unmentionedColor: unmentionedColor ?? c.unmentionedColor,
    );
  }

  Future<void> _save() async {
    final c = _c;
    if (c == null) return;
    final idCols = _idCols;
    final labelCols = _labelCols;
    final label = _label.text.trim();
    final next = WorkspaceColumns(
      userInfoUserIdCol: c.userInfoUserIdCol,
      userInfoTitleCol: c.userInfoTitleCol,
      userInfoSalaryCol: c.userInfoSalaryCol,
      userInfoStatusCol: c.userInfoStatusCol,
      mgmtUserIdCol: c.mgmtUserIdCol,
      agentUserIdCol: c.agentUserIdCol,
      agentSalaryCol: c.agentSalaryCol,
      agentNameCol: c.agentNameCol,
      mgmtShareCol: c.mgmtShareCol,
      unmentionedLabel: label.isEmpty ? 'غير مذكور' : label,
      unmentionedIdCols: idCols,
      unmentionedLabelCols: labelCols,
      unmentionedColor: c.unmentionedColor,
    );
    final problem = next.validate();
    if (problem != null) {
      showToast(context, problem, ToastType.error);
      return;
    }
    setState(() => _saving = true);
    final services = AppScope.read(context);
    await services.db.saveWorkspaceColumns(next);
    services.columnsChanged();
    if (!mounted) return;
    setState(() => _saving = false);
    _show(next);
    showToast(
      context,
      'حُفظ ربط حقول «${services.workspace.name}» وطُبِّق على شاشة التدقيق',
      ToastType.success,
    );
    // Back to Settings, like the mockup.
    Navigator.of(context).maybePop();
  }

  String _labelText() =>
      _label.text.trim().isEmpty ? 'غير مذكور' : _label.text.trim();

  /// The user-info columns that receive the salary and the status (not
  /// offered for the extra columns).
  static Set<String> _written(WorkspaceColumns c) => {
    c.userInfoSalaryCol,
    c.userInfoStatusCol.isEmpty
        ? columnIndexToLetter(
          (columnLetterToIndex(c.userInfoSalaryCol) ?? 10) + 1,
        )
        : c.userInfoStatusCol,
  };

  /// One mapping row (`.frow`): label and a compact column picker.
  Widget _pick(
    String label,
    String value,
    ValueChanged<String> onChanged, {
    bool allowAuto = false,
    List<String> head = const [],
  }) => FormRow(
    label,
    CompactSelect<String>(
      options: [
        if (allowAuto) const SelectOption('', 'تلقائي'),
        ...columnOptions(head),
      ],
      shown: (v) => v.isEmpty ? 'تلقائي' : v,
      value: value,
      onChanged: onChanged,
    ),
  );

  /// Header rows for the column names («C - رقم المستخدم» like ERPSYSTEM):
  /// management and agent from the latest period on the phone, user info
  /// from the audit's user-info sheet when Google is connected.
  List<String> _uiHead = const [];
  List<String> _mgmtHead = const [];
  List<String> _agentHead = const [];

  Future<void> _loadHeads() async {
    final s = AppScope.read(context);
    try {
      final cycles = await s.db.listCycles();
      if (cycles.isNotEmpty) {
        final c = await s.db.getCycle(cycles.first.id);
        if (c != null && mounted) {
          setState(() {
            _mgmtHead =
                c.managementRows.isEmpty ? const [] : c.managementRows.first;
            _agentHead = c.agentRows.isEmpty ? const [] : c.agentRows.first;
          });
        }
      }
      if (!s.auth.isConnected) return;
      final raw = await s.db.getValue('payrollAuditDraftV1');
      final d = raw == null ? const {} : jsonDecode(raw) as Map;
      final ss = '${d['spreadsheetId'] ?? ''}';
      if (ss.isEmpty) return;
      var sheet = '${d['userInfoSheetName'] ?? ''}';
      if (sheet.isEmpty) {
        final meta = await s.sheets.getSpreadsheet(ss);
        if (meta.sheets.isEmpty) return;
        sheet = meta.sheets.first.title;
      }
      final rows = await s.sheets.valuesGet(
        ss,
        "'${escapeSheetTitleForRange(sheet)}'!1:1",
      );
      if (mounted && rows.isNotEmpty) setState(() => _uiHead = rows.first);
    } catch (_) {
      // Letters only.
    }
  }

  Widget _section(String title, Widget child, {Widget? after}) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [SectionLabel(title), child, if (after != null) after],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final c = _c;
    return Directionality(
      textDirection: TextDirection.rtl,
      child: ColoredBox(
        color: Tw.paper,
        child:
            c == null
                ? const Center(child: CircularProgressIndicator())
                : ListView(
                  padding: const EdgeInsets.only(bottom: 32),
                  children: [
                    // `.topbar`: back to Settings, «الافتراضي», «؟».
                    SizedBox(
                      height: 54,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(6, 4, 6, 0),
                        child: Row(
                          children: [
                            TextButton.icon(
                              onPressed: () => Navigator.of(context).maybePop(),
                              icon: const Icon(Icons.chevron_right, size: 22),
                              label: const Text(
                                'الإعدادات',
                                style: TextStyle(fontSize: 16),
                              ),
                            ),
                            const Spacer(),
                            RefreshAction(onRefresh: _loadHeads),
                            HelpButton(
                              title: 'ربط حقول البيانات',
                              items: () => mappingHelp,
                            ),
                            TextButton(
                              onPressed: () {
                                _show(const WorkspaceColumns());
                                showToast(
                                  context,
                                  'أُعيدت الأعمدة الافتراضية. اضغط «حفظ ربط الحقول» لتطبيقها.',
                                  ToastType.info,
                                );
                              },
                              child: const Text('الافتراضي'),
                            ),
                          ],
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 2, 20, 0),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('ربط حقول البيانات', style: Ds.screenTitle),
                          const SizedBox(height: 4),
                          Text(
                            'أعمدة «${services.workspace.name}». تُطبَّق على شاشة التدقيق عند الحفظ.',
                            style: TextStyle(fontSize: 14.5, color: Tw.ink2),
                          ),
                        ],
                      ),
                    ),
                    _section(
                      'بيانات المستخدمين',
                      FormRows(
                        onSurface: false,
                        children: [
                          _pick(
                            head: _uiHead,
                            'رقم المستخدم',
                            c.userInfoUserIdCol,
                            (v) => setState(
                              () => _c = _with(userInfoUserIdCol: v),
                            ),
                          ),
                          _pick(
                            head: _uiHead,
                            'اسم الوكالة (ورقة الوجهة)',
                            c.userInfoTitleCol,
                            (v) =>
                                setState(() => _c = _with(userInfoTitleCol: v)),
                          ),
                          _pick(
                            head: _uiHead,
                            'كتابة الراتب',
                            c.userInfoSalaryCol,
                            (v) => setState(
                              () => _c = _with(userInfoSalaryCol: v),
                            ),
                          ),
                          _pick(
                            head: _uiHead,
                            'كتابة الحالة',
                            c.userInfoStatusCol,
                            (v) => setState(
                              () => _c = _with(userInfoStatusCol: v),
                            ),
                            allowAuto: true,
                          ),
                        ],
                      ),
                    ),
                    _section(
                      'جدول الإدارة',
                      FormRows(
                        onSurface: false,
                        children: [
                          _pick(
                            head: _mgmtHead,
                            'رقم المستخدم',
                            c.mgmtUserIdCol,
                            (v) => setState(() => _c = _with(mgmtUserIdCol: v)),
                          ),
                          _pick(
                            head: _mgmtHead,
                            'مبلغ الوكيل الفرعي',
                            c.mgmtShareCol,
                            (v) => setState(() => _c = _with(mgmtShareCol: v)),
                          ),
                        ],
                      ),
                    ),
                    _section(
                      'جدول الوكيل',
                      FormRows(
                        onSurface: false,
                        children: [
                          _pick(
                            head: _agentHead,
                            'رقم المستخدم',
                            c.agentUserIdCol,
                            (v) =>
                                setState(() => _c = _with(agentUserIdCol: v)),
                          ),
                          _pick(
                            head: _agentHead,
                            'الراتب',
                            c.agentSalaryCol,
                            (v) =>
                                setState(() => _c = _with(agentSalaryCol: v)),
                          ),
                          _pick(
                            head: _agentHead,
                            'الاسم',
                            c.agentNameCol,
                            (v) => setState(() => _c = _with(agentNameCol: v)),
                          ),
                        ],
                      ),
                    ),
                    _section(
                      'غير المذكورين',
                      FormRows(
                        onSurface: false,
                        children: [
                          FormRow(
                            'النص (واسم الورقة في جدول الإدارة)',
                            ErpTextField(
                              controller: _label,
                              thick: true,
                              maxLength: 60,
                              onChanged: (_) => setState(() {}),
                            ),
                            block: true,
                          ),
                          FormRow(
                            'أعمدة إضافية لرقم المستخدم (غير ${c.userInfoUserIdCol})',
                            ColumnChips(
                              values: _idCols,
                              header: _uiHead,
                              exclude: {
                                ..._written(c),
                                c.userInfoTitleCol,
                                ..._labelCols,
                              },
                              emptyText:
                                  'لا يوجد — يُكتب في ${c.userInfoUserIdCol} فقط',
                              onChanged: (v) => setState(() => _idCols = v),
                            ),
                            block: true,
                          ),
                          FormRow(
                            'أعمدة إضافية لكلمة «${_labelText()}» (غير ${c.userInfoTitleCol})',
                            ColumnChips(
                              values: _labelCols,
                              header: _uiHead,
                              exclude: {
                                ..._written(c),
                                c.userInfoUserIdCol,
                                ..._idCols,
                              },
                              emptyText:
                                  'لا يوجد — تُكتب في ${c.userInfoTitleCol} فقط',
                              onChanged: (v) => setState(() => _labelCols = v),
                            ),
                            block: true,
                          ),
                          FormRow(
                            'لون سجلات الإدارة المنقولة',
                            ColorSwatchButton(
                              value: c.unmentionedColor,
                              onChanged:
                                  (v) => setState(
                                    () => _c = _with(unmentionedColor: v),
                                  ),
                            ),
                          ),
                        ],
                      ),
                      after: Caption(
                        'يلوّن به إجراء «٢. نقل سجلات الإدارة غير الملوّنة» الصفوف التي ينقلها، في ورقة الإدارة ونسخها في «${_labelText()}» فقط.',
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
                      child: ErpButton(
                        label: 'حفظ ربط الحقول',
                        loading: _saving,
                        onPressed: _save,
                      ),
                    ),
                  ],
                ),
      ),
    );
  }
}
