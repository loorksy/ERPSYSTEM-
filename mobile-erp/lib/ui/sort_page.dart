// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_services.dart';
import '../data/app_database.dart';
import '../erp/js_compat.dart';
import '../erp/normalize.dart';
import '../google/sheets_client.dart';
import '../services/adjustments_service.dart';
import '../services/user_sheet_tools.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';
import 'help.dart';
import 'shell.dart';
import 'sheet_page.dart' show formatArabicDate;
import 'spreadsheet_link.dart';
import 'ui_kit.dart';

const _draftKey = 'userToolsDraftV1';

/// «فرز» (owner's request, 2026-11-17): tools on the user-info sheet, in
/// tabs — «فرز» (one sheet per value of a column) and «جبر الرواتب»
/// (rounding the salary column, with the difference and its log).
class SortPage extends StatefulWidget {
  const SortPage({super.key, required this.active});
  final bool active;
  @override
  State<SortPage> createState() => _SortPageState();
}

class _SortPageState extends State<SortPage> {
  bool _ready = false;
  String? _ssMessage = 'جاري جلب الملفات…';
  List<SpreadsheetFile> _files = const [];
  String _ssId = '';
  List<String> _sheetNames = const [];
  String? _sheetMessage = 'اختر الجدول أولاً';
  String _sheet = '';

  /// 0 فرز، 1 دمج، 2 جبر الرواتب.
  int _tab = 0;
  String _sortCol = 'E';

  /// Owner's request: the sorted rows are coloured in the sorted sheet.
  String _sortColor = '#a7f3d0';
  final _headerRow = TextEditingController(text: '1');
  String _nameCol = 'A';
  String _mergeSalaryCol = 'L';
  String? _lastMerge;

  /// The first rows of the sheet, for the column names of the pickers.
  List<List<String>> _headRows = const [];
  String _salaryCol = 'L';
  RoundingMode _mode = RoundingMode.floor;
  RoundingMode _defaultMode = RoundingMode.floor;
  WorkspaceColumns _ws = const WorkspaceColumns();

  bool _busy = false;
  String? _progress;
  double? _progressValue;
  SortOutcome? _lastSort;
  List<RoundingLogEntry> _log = const [];
  int _settingsRevision = -1;

  static final _letters = [for (var i = 0; i < 52; i++) columnIndexToLetter(i)];

  AppServices get _s => AppScope.read(context);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final services = AppScope.of(context);
    if (!_ready) {
      _ready = true;
      _settingsRevision = services.columnsRevision;
      _init();
    } else if (services.columnsRevision != _settingsRevision) {
      // The default rounding or the workspace columns changed in Settings.
      _settingsRevision = services.columnsRevision;
      _loadSettings();
    }
  }

  @override
  void dispose() {
    _headerRow.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(SortPage old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) {
      // The default rounding may have been changed in Settings.
      _loadSettings();
      if (_files.isEmpty) _loadFiles();
    }
  }

  Future<void> _init() async {
    await _loadSettings(first: true);
    await _restoreDraft();
    await _loadFiles();
    final log = await _s.userTools.log();
    if (mounted) setState(() => _log = log);
  }

  Future<void> _loadSettings({bool first = false}) async {
    final ws = await _s.db.getWorkspaceColumns();
    final mode = await _s.userTools.defaultMode();
    if (!mounted) return;
    setState(() {
      _ws = ws;
      if (first) _salaryCol = ws.userInfoSalaryCol;
      if (first || _mode == _defaultMode) _mode = mode;
      _defaultMode = mode;
    });
  }

  // --------------------------------------------------------------- draft

  Future<void> _saveDraft() => _s.db.setValue(
    _draftKey,
    jsonEncode({
      'ssId': _ssId,
      'sheet': _sheet,
      'sortCol': _sortCol,
      'sortColor': _sortColor,
      'salaryCol': _salaryCol,
      'headerRow': _headerRow.text,
      'nameCol': _nameCol,
      'mergeSalaryCol': _mergeSalaryCol,
      'tab': _tab,
    }),
  );

  Future<void> _restoreDraft() async {
    var raw = await _s.db.getValue(_draftKey);
    Map<String, dynamic> d = const {};
    try {
      if (raw != null) d = Map<String, dynamic>.from(jsonDecode(raw) as Map);
    } catch (_) {}
    if (raw == null) {
      // First time: the user-info spreadsheet of the audit, if any.
      raw = await _s.db.getValue('payrollAuditDraftV1');
      try {
        final a = Map<String, dynamic>.from(jsonDecode(raw ?? '{}') as Map);
        d = {'ssId': a['spreadsheetId'], 'sheet': a['userInfoSheetName']};
      } catch (_) {}
    }
    if (!mounted) return;
    String col(Object? v, String fallback) =>
        _letters.contains('$v') ? '$v' : fallback;
    setState(() {
      _ssId = '${d['ssId'] ?? ''}';
      _sheet = '${d['sheet'] ?? ''}';
      _sortCol = col(d['sortCol'], 'E');
      final sc = '${d['sortColor'] ?? ''}';
      if (RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(sc)) _sortColor = sc;
      _salaryCol = col(d['salaryCol'], _ws.userInfoSalaryCol);
      _nameCol = col(d['nameCol'], 'A');
      _mergeSalaryCol = col(d['mergeSalaryCol'], _ws.userInfoSalaryCol);
      final hr = int.tryParse('${d['headerRow'] ?? ''}');
      if (hr != null && hr > 0) _headerRow.text = '$hr';
      final tab = d['tab'];
      _tab = tab is int && tab >= 0 && tab <= 2 ? tab : 0;
    });
    if (_ssId.isNotEmpty) await _loadSheets(keep: true);
  }

  // -------------------------------------------------------------- google

  Future<void> _loadFiles() async {
    if (!_s.auth.isConnected) {
      setState(() => _ssMessage = 'لم يتم تسجيل الدخول بـ Google');
      return;
    }
    setState(() => _ssMessage = 'جاري جلب الملفات…');
    try {
      final list = await _s.sheets.listSpreadsheets();
      if (!mounted) return;
      setState(() {
        _files = [
          ...list,
          for (final f in _files)
            if (!list.any((x) => x.id == f.id)) f,
        ];
        _ssMessage = list.isEmpty ? 'لا توجد ملفات — تحقق من ربط Google' : null;
      });
    } catch (e) {
      if (mounted) setState(() => _ssMessage = '$e');
    }
  }

  Future<void> _onSpreadsheet(String picked) async {
    var v = picked;
    if (v == pasteLinkValue) {
      final f = await askSpreadsheetLink(context, _s.sheets);
      if (f == null || !mounted) return;
      setState(() {
        _files = [f, ..._files.where((x) => x.id != f.id)];
        _ssMessage = null;
      });
      v = f.id;
    }
    setState(() {
      _ssId = v;
      _sheet = '';
      _sheetNames = const [];
    });
    await _loadSheets();
    _saveDraft();
  }

  Future<void> _loadSheets({bool keep = false}) async {
    if (_ssId.isEmpty) {
      setState(() => _sheetMessage = 'اختر الجدول أولاً');
      return;
    }
    setState(() => _sheetMessage = 'جاري جلب الأوراق…');
    try {
      final meta = await _s.sheets.getSpreadsheet(_ssId);
      if (!mounted) return;
      final names = [for (final s in meta.sheets) s.title];
      setState(() {
        _sheetNames = names;
        _sheetMessage = names.isEmpty ? 'لا توجد أوراق' : null;
        if (!keep || (_sheet.isNotEmpty && !names.contains(_sheet))) {
          _sheet = names.isEmpty ? '' : names.first;
        }
        if (!_files.any((f) => f.id == _ssId)) {
          _files = [SpreadsheetFile(_ssId, meta.title ?? _ssId), ..._files];
        }
      });
      await _loadHeaders();
    } catch (e) {
      if (mounted) setState(() => _sheetMessage = '$e');
    }
  }

  /// Reads the header rows (up to the merge's header row) so the column
  /// pickers show «A - رقم المستخدم» like ERPSYSTEM.
  Future<void> _loadHeaders() async {
    final title = _sheet.isNotEmpty ? _sheet : _sheetNames.firstOrNull;
    if (_ssId.isEmpty || title == null) return;
    final n = (int.tryParse(_headerRow.text.trim()) ?? 1).clamp(1, 50);
    try {
      final rows = await _s.sheets.valuesGet(
        _ssId,
        "'${escapeSheetTitleForRange(title)}'!1:$n",
      );
      if (mounted) setState(() => _headRows = rows);
    } catch (_) {
      // Letters only.
    }
  }

  String get _tableName =>
      _files.where((f) => f.id == _ssId).map((f) => f.name).firstOrNull ??
      (_ssId.isEmpty ? 'اختر جدول بيانات المستخدمين' : _ssId);

  bool _ensureSource() {
    if (_ssId.isEmpty) {
      showToast(context, 'اختر جدول بيانات المستخدمين أولاً', ToastType.error);
      return false;
    }
    return true;
  }

  String _error(Object e) =>
      e is StateError
          ? e.message
          : (e is ArgumentError ? '${e.message}' : '$e');

  // ---------------------------------------------------------------- sort

  Future<void> _previewSort() async {
    if (!_ensureSource() || _busy) return;
    setState(() {
      _busy = true;
      _progress = 'جاري قراءة الورقة…';
      _progressValue = null;
    });
    SortPlan? plan;
    try {
      plan = await _s.userTools.previewSort(
        spreadsheetId: _ssId,
        sheetName: _sheet,
        column: _sortCol,
        emptyLabel: _ws.unmentionedLabel,
      );
    } catch (e) {
      if (mounted) showToast(context, _error(e), ToastType.error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (plan == null || !mounted) return;
    if (plan.groups.isEmpty) {
      showToast(context, 'لا توجد صفوف في الورقة للفرز', ToastType.info);
      return;
    }
    final go = await showAppSheet<bool>(
      context,
      (ctx) => _SortPreview(plan: plan!),
    );
    if (go == true && mounted) await _runSort(plan);
  }

  Future<void> _runSort(SortPlan plan) async {
    setState(() {
      _busy = true;
      _progress = 'جاري الفرز…';
      _progressValue = 0;
    });
    try {
      final out = await _s.userTools.runSort(
        spreadsheetId: _ssId,
        plan: plan,
        idColumn: _ws.userInfoUserIdCol,
        color: _sortColor,
        onProgress: (sheet, done, total) {
          if (!mounted) return;
          setState(() {
            _progress = sheet.isEmpty ? 'اكتمل الفرز' : 'ورقة «$sheet»';
            _progressValue = total == 0 ? null : done / total;
          });
        },
      );
      if (!mounted) return;
      setState(() => _lastSort = out);
      await _showSortResult(out);
    } catch (e) {
      if (mounted) {
        showToast(
          context,
          'تعذّر إكمال الفرز: ${_error(e)} — أعد المحاولة؛ لن تُنسخ الصفوف التي نُسخت مرة أخرى.',
          ToastType.error,
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _showSortResult(SortOutcome out) => showAppSheet<void>(
    context,
    (ctx) => AppSheet(
      title: 'نتيجة الفرز',
      footer: ErpButton(label: 'تم', onPressed: () => Navigator.pop(ctx)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FigsRow(
            flat: true,
            figs: [
              (formatCount(out.created.length), 'أوراق جديدة', null),
              (formatCount(out.total), 'صفوف منسوخة', null),
              (formatCount(out.skipped), 'موجودة من قبل', null),
            ],
          ),
          if (out.colored > 0)
            Caption(
              'لُوّن ${formatCount(out.colored)} صفًا في الورقة المفروزة.',
            ),
          const SheetLabel('الأوراق'),
          FormRows(
            children: [
              for (final e in out.copied.entries)
                FormRow(
                  e.key,
                  Text(
                    '${formatCount(e.value)} صف${out.created.contains(e.key) ? ' · جديدة' : ''}',
                    style: TextStyle(fontSize: 14, color: Tw.ink2),
                  ),
                ),
            ],
          ),
        ],
      ),
    ),
  );

  // --------------------------------------------------------------- merge

  Future<void> _previewMerge() async {
    if (!_ensureSource() || _busy) return;
    final headerRow = int.tryParse(_headerRow.text.trim()) ?? 0;
    if (headerRow < 1) {
      showToast(context, 'اكتب رقم صف العناوين (1 أو أكثر).', ToastType.error);
      return;
    }
    setState(() {
      _busy = true;
      _progress = 'جاري قراءة الورقة…';
      _progressValue = null;
    });
    MergePlan? plan;
    try {
      plan = await _s.userTools.previewMerge(
        spreadsheetId: _ssId,
        sheetName: _sheet,
        headerRow: headerRow,
        nameColumn: _nameCol,
        salaryColumn: _mergeSalaryCol,
      );
    } catch (e) {
      if (mounted) showToast(context, _error(e), ToastType.error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (plan == null || !mounted) return;
    if (plan.message != null) {
      showToast(context, plan.message!, ToastType.info);
      return;
    }
    final go = await showAppSheet<bool>(
      context,
      (ctx) => _MergePreview(plan: plan!),
    );
    if (go != true || !mounted) return;
    setState(() {
      _busy = true;
      _progress = 'جاري كتابة ورقة «${plan!.resultTitle}»…';
    });
    try {
      final msg = await _s.userTools.runMerge(spreadsheetId: _ssId, plan: plan);
      if (!mounted) return;
      setState(() => _lastMerge = msg);
      await showDialog<void>(
        context: context,
        builder:
            (ctx) => Directionality(
              textDirection: TextDirection.rtl,
              child: AlertDialog(
                title: const Text('دمج الرواتب'),
                content: Text(msg),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(ctx),
                    child: const Text('تم'),
                  ),
                ],
              ),
            ),
      );
    } catch (e) {
      if (mounted) {
        showToast(context, 'حدث خطأ: ${_error(e)}', ToastType.error);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ------------------------------------------------------------ rounding

  Future<void> _round() async {
    if (!_ensureSource() || _busy) return;
    setState(() {
      _busy = true;
      _progress = 'جاري قراءة الرواتب…';
      _progressValue = null;
    });
    RoundingPlan? plan;
    try {
      plan = await _s.userTools.previewRounding(
        spreadsheetId: _ssId,
        sheetName: _sheet,
        column: _salaryCol,
        idColumn: _ws.userInfoUserIdCol,
        mode: _mode,
      );
    } catch (e) {
      if (mounted) showToast(context, _error(e), ToastType.error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (plan == null || !mounted) return;
    if (plan.changes.isEmpty) {
      showToast(
        context,
        plan.salaries == 0
            ? 'لا توجد رواتب في العمود $_salaryCol'
            : 'لا يوجد ما يُجبر: كل الرواتب (${formatCount(plan.salaries)}) أعداد صحيحة.',
        ToastType.info,
      );
      return;
    }
    final ok = await confirmDialog(
      context,
      icon: Icons.calculate_outlined,
      title: 'جبر الرواتب',
      body:
          'سيُجبر ${formatCount(plan.changes.length)} راتبًا من ${formatCount(plan.salaries)} في العمود $_salaryCol من ورقة «${plan.sheetTitle}» بطريقة «${_mode.label}». تُكتب الرواتب الجديدة في Google.',
      confirmLabel: 'جبر',
    );
    if (!ok || !mounted) return;
    setState(() {
      _busy = true;
      _progress = 'جاري كتابة الرواتب…';
    });
    try {
      final entry = await _s.userTools.applyRounding(
        spreadsheetId: _ssId,
        spreadsheetName: _tableName,
        plan: plan,
      );
      final log = await _s.userTools.log();
      if (!mounted) return;
      setState(() => _log = log);
      await _showDifference(entry);
    } catch (e) {
      if (mounted) showToast(context, _error(e), ToastType.error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The popup after a rounding: the difference first.
  Future<void> _showDifference(RoundingLogEntry e) => showDialog<void>(
    context: context,
    builder:
        (ctx) => Directionality(
          textDirection: TextDirection.rtl,
          child: Dialog(
            insetPadding: const EdgeInsets.symmetric(horizontal: 22),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(22, 24, 22, 14),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    e.difference >= 0
                        ? 'الفرق (نقص من الرواتب)'
                        : 'الفرق (زيادة على الرواتب)',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 15, color: Tw.ink2),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    AdjustmentsService.money(e.difference.abs()),
                    textAlign: TextAlign.center,
                    textDirection: TextDirection.ltr,
                    style: TextStyle(
                      fontSize: 44,
                      fontWeight: FontWeight.w800,
                      color: Tw.ink,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'جُبر ${formatCount(e.count)} راتبًا بطريقة «${e.mode.label}». المجموع ${AdjustmentsService.money(e.totalBefore)} ← ${AdjustmentsService.money(e.totalAfter)}.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 14, height: 1.7, color: Tw.ink2),
                  ),
                  const SizedBox(height: 18),
                  ErpButton(label: 'تم', onPressed: () => Navigator.pop(ctx)),
                ],
              ),
            ),
          ),
        ),
  );

  Future<void> _openLogEntry(RoundingLogEntry e) async {
    final changes = await _s.userTools.logDetails(e.id);
    if (!mounted) return;
    String n(double v) => jsNumberToString(v);
    await showAppSheet<void>(
      context,
      (ctx) => AppSheet(
        title: 'تفاصيل الجبر',
        scroll: false,
        actions: [
          IconButton(
            tooltip: 'نسخ التفاصيل',
            onPressed: () async {
              final text = [
                'رقم المستخدم\tقبل\tبعد\tالفرق',
                for (final c in changes)
                  '${c.id}\t${n(c.before)}\t${n(c.after)}\t${n(AdjustmentsService.round2(c.diff))}',
                '',
                'الفرق\t${n(e.difference)}',
              ].join('\n');
              await Clipboard.setData(ClipboardData(text: text));
              if (ctx.mounted) {
                showToast(
                  ctx,
                  'نُسخت التفاصيل — الصقها في Excel.',
                  ToastType.success,
                );
              }
            },
            icon: Icon(Icons.content_copy_outlined, color: Tw.ink2),
          ),
        ],
        child: SizedBox(
          height: MediaQuery.of(ctx).size.height * 0.72,
          child: ListView.builder(
            itemCount: changes.length + 1,
            itemBuilder: (_, i) {
              if (i == 0) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      '${_date(e.at)} · ${e.sheet} · العمود ${e.column} · ${e.mode.label}',
                      style: Ds.secondary,
                    ),
                    const SizedBox(height: 12),
                    FigsRow(
                      flat: true,
                      figs: [
                        (AdjustmentsService.money(e.totalBefore), 'قبل', null),
                        (AdjustmentsService.money(e.totalAfter), 'بعد', null),
                        (AdjustmentsService.money(e.difference), 'الفرق', null),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _tableRow(const [
                      'رقم المستخدم',
                      'قبل',
                      'بعد',
                      'الفرق',
                    ], head: true),
                  ],
                );
              }
              final c = changes[i - 1];
              return _tableRow([
                c.id.isEmpty ? 'الصف ${c.row}' : c.id,
                n(c.before),
                n(c.after),
                n(AdjustmentsService.round2(c.diff)),
              ]);
            },
          ),
        ),
      ),
    );
  }

  Widget _tableRow(List<String> cells, {bool head = false}) => Container(
    padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 2),
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: Tw.rule)),
    ),
    child: Row(
      children: [
        for (var i = 0; i < cells.length; i++)
          Expanded(
            flex: i == 0 ? 4 : 3,
            child: Text(
              cells[i],
              // Numbers and their titles both at the left of their column.
              textAlign:
                  i == 0
                      ? TextAlign.start
                      : (head ? TextAlign.end : TextAlign.left),
              textDirection: !head && i > 0 ? TextDirection.ltr : null,
              style: TextStyle(
                fontSize: head ? 12.5 : 14.5,
                fontWeight: head || i == 0 ? FontWeight.w700 : FontWeight.w500,
                color: head ? Tw.ink2 : Tw.ink,
              ),
            ),
          ),
      ],
    ),
  );

  String _date(DateTime t) {
    final l = t.toLocal();
    final h = l.hour % 12 == 0 ? 12 : l.hour % 12;
    return '${formatArabicDate(l)}، $h:${l.minute.toString().padLeft(2, '0')} ${l.hour < 12 ? 'ص' : 'م'}';
  }

  // ------------------------------------------------------------------ UI

  /// The spreadsheet and sheet (shared by the tabs).
  Future<void> _openTableSheet() => showAppSheet<void>(
    context,
    (ctx) => StatefulBuilder(
      builder:
          (ctx, setLocal) => AppSheet(
            title: 'جدول بيانات المستخدمين',
            actions: [
              RefreshAction(
                onRefresh: () async {
                  await _loadFiles();
                  await _loadSheets(keep: true);
                  setLocal(() {});
                },
              ),
            ],
            footer: ErpButton(label: 'تم', onPressed: () => Navigator.pop(ctx)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'الجدول والورقة التي فيها بيانات المستخدمين. الفرز يقرأ منها وينسخ إلى أوراق أخرى في نفس الجدول، والجبر يعدّل عمود الراتب فيها فقط.',
                  style: TextStyle(fontSize: 14.5, height: 1.7, color: Tw.ink2),
                ),
                const SizedBox(height: 14),
                FormRows(
                  children: [
                    FormRow(
                      'الجدول',
                      ErpSelect<String>(
                        muted: true,
                        options: [
                          SelectOption('', _ssMessage ?? '— اختر الجدول —'),
                          const SelectOption(pasteLinkValue, pasteLinkLabel),
                          for (final f in _files) SelectOption(f.id, f.name),
                          if (_ssId.isNotEmpty &&
                              !_files.any((f) => f.id == _ssId))
                            SelectOption(_ssId, _ssId),
                        ],
                        value: _ssId,
                        onChanged: (v) async {
                          await _onSpreadsheet(v);
                          setLocal(() {});
                        },
                      ),
                      block: true,
                    ),
                    FormRow(
                      'الورقة',
                      ErpSelect<String>(
                        muted: true,
                        options: [
                          if (_sheetNames.isEmpty)
                            SelectOption('', _sheetMessage ?? 'لا توجد أوراق'),
                          for (final n in _sheetNames) SelectOption(n, n),
                          if (_sheet.isNotEmpty &&
                              !_sheetNames.contains(_sheet))
                            SelectOption(_sheet, _sheet),
                        ],
                        value: _sheet,
                        onChanged: (v) {
                          setState(() => _sheet = v);
                          setLocal(() {});
                          _saveDraft();
                          _loadHeaders();
                        },
                      ),
                      block: true,
                    ),
                  ],
                ),
              ],
            ),
          ),
    ),
  );

  Widget _section(String? title, Widget child, {Widget? trailing}) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null) SectionLabel(title, trailing: trailing),
        child,
      ],
    ),
  );

  Widget _colPicker(
    String value,
    ValueChanged<String> onChanged, {
    int headerRow = 1,
  }) => CompactSelect<String>(
    options: columnOptions(
      headerRow - 1 < _headRows.length ? _headRows[headerRow - 1] : const [],
    ),
    shown: (v) => v,
    value: value,
    maxWidth: 96,
    onChanged:
        _busy
            ? null
            : (v) {
              setState(() => onChanged(v));
              _saveDraft();
            },
  );

  @override
  Widget build(BuildContext context) {
    final connected = AppScope.of(context).auth.isConnected;
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        ScreenHeader(title: 'فرز', help: () => sortToolsHelp),
        _section(
          'جدول بيانات المستخدمين',
          GroupList(
            children: [
              if (connected)
                ListRow(
                  enabled: !_busy,
                  leading: IconChip(Icons.table_chart_outlined),
                  title: _tableName,
                  subtitle: Text(
                    _sheet.isNotEmpty ? _sheet : (_sheetMessage ?? ''),
                  ),
                  trailing: const RowChevron(),
                  onTap: _openTableSheet,
                )
              else
                ListRow(
                  leading: IconChip(Icons.cloud_outlined),
                  title: 'لم يتم تسجيل الدخول بـ Google',
                  subtitle: Text(
                    'اربط حسابك من الإعدادات',
                    style: TextStyle(color: Tw.warn),
                  ),
                  trailing: const RowChevron(),
                  onTap:
                      () => ShellScope.maybeOf(context)?.goTo(AppTabs.settings),
                ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 22, 16, 0),
          child: SegmentedChoice(
            options: const ['فرز', 'دمج', 'جبر الرواتب'],
            icons: const [
              Icons.call_split,
              Icons.merge_type,
              Icons.calculate_outlined,
            ],
            selected: _tab,
            onChanged: (i) {
              setState(() => _tab = i);
              _saveDraft();
            },
          ),
        ),
        if (_busy) _section(null, _progressCard()),
        if (_tab == 0)
          ..._sortTab()
        else if (_tab == 1)
          ..._mergeTab()
        else
          ..._roundTab(),
      ],
    );
  }

  Widget _progressCard() => Container(
    margin: const EdgeInsets.only(top: 6),
    padding: const EdgeInsets.fromLTRB(20, 16, 20, 18),
    decoration: panelDecoration(radius: Ds.radiusL),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(_progress ?? '', style: TextStyle(fontSize: 15, color: Tw.ink)),
        const SizedBox(height: 12),
        ProgressLine(value: _progressValue),
      ],
    ),
  );

  List<Widget> _sortTab() => [
    _section(
      'الفرز حسب',
      GroupList(
        children: [
          ListRow(
            leading: IconChip(Icons.view_column_outlined),
            title: 'عمود الفرز',
            subtitle: Text(
              'كل قيمة تصبح ورقة بنفس الاسم، والفارغ إلى «${_ws.unmentionedLabel}»',
            ),
            trailing: _colPicker(_sortCol, (v) => _sortCol = v),
          ),
          ListRow(
            leading: IconChip(Icons.format_color_fill),
            title: 'لون الصفوف المفروزة',
            subtitle: const Text('تُلوَّن في ورقة بيانات المستخدمين نفسها'),
            trailing: ColorSwatchButton(
              value: _sortColor,
              onChanged: (v) {
                setState(() => _sortColor = v);
                _saveDraft();
              },
            ),
          ),
        ],
      ),
    ),
    _section(
      null,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 4),
          ErpButton(
            label: 'معاينة الفرز',
            icon: Icons.call_split,
            onPressed: _busy ? null : _previewSort,
          ),
          const Caption(
            'تُنشأ الأوراق الناقصة في نفس الجدول، ولا يُنسخ صف موجود في ورقته من قبل. في ورقة بيانات المستخدمين تُلوَّن الصفوف المفروزة فقط، ولا تتغير قيمها.',
            center: true,
          ),
        ],
      ),
    ),
    if (_lastSort != null)
      _section(
        'آخر فرز',
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FigsRow(
              figs: [
                (formatCount(_lastSort!.created.length), 'أوراق جديدة', null),
                (formatCount(_lastSort!.total), 'صفوف منسوخة', null),
                (formatCount(_lastSort!.skipped), 'موجودة من قبل', null),
              ],
            ),
            const SizedBox(height: 8),
            ErpButton(
              label: 'عرض الأوراق',
              icon: Icons.format_list_bulleted,
              kind: ErpButtonKind.outline,
              onPressed: () => _showSortResult(_lastSort!),
            ),
          ],
        ),
      ),
  ];

  List<Widget> _mergeTab() => [
    _section(
      'الدمج حسب الاسم',
      GroupList(
        children: [
          ListRow(
            leading: IconChip(Icons.title),
            title: 'صف العناوين',
            subtitle: const Text('الصفوف تحته هي البيانات'),
            trailing: SizedBox(
              width: 84,
              child: NumberBox(
                controller: _headerRow,
                onChanged: (_) {
                  setState(() {});
                  _saveDraft();
                  _loadHeaders();
                },
              ),
            ),
          ),
          ListRow(
            leading: IconChip(Icons.badge_outlined),
            title: 'عمود الاسم',
            subtitle: const Text('الصفوف بنفس الاسم تُدمج'),
            trailing: _colPicker(
              _nameCol,
              (v) => _nameCol = v,
              headerRow: int.tryParse(_headerRow.text.trim()) ?? 1,
            ),
          ),
          ListRow(
            leading: IconChip(Icons.payments_outlined),
            title: 'عمود الراتب',
            subtitle: const Text('تُجمع رواتب الاسم الواحد'),
            trailing: _colPicker(
              _mergeSalaryCol,
              (v) => _mergeSalaryCol = v,
              headerRow: int.tryParse(_headerRow.text.trim()) ?? 1,
            ),
          ),
        ],
      ),
    ),
    _section(
      null,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 4),
          ErpButton(
            label: 'معاينة الدمج',
            icon: Icons.merge_type,
            onPressed: _busy ? null : _previewMerge,
          ),
          const Caption(
            'الصفوف بنفس الاسم تصبح صفًا واحدًا: تُجمع الرواتب، والقيم المختلفة في الأعمدة الأخرى تُضم بـ « / ». النتيجة في ورقة «اسم الورقة_دمج»، والورقة الأصلية لا تتغير.',
            center: true,
          ),
        ],
      ),
    ),
    if (_lastMerge != null)
      _section(
        'آخر دمج',
        NoticeBox(
          bg: Tw.accentSoft,
          child: Text(_lastMerge!, style: TextStyle(color: Tw.accentInk)),
        ),
      ),
  ];

  List<Widget> _roundTab() => [
    _section(
      'الراتب',
      GroupList(
        children: [
          ListRow(
            leading: IconChip(Icons.payments_outlined),
            title: 'عمود الراتب',
            subtitle: const Text('في ورقة بيانات المستخدمين'),
            trailing: _colPicker(_salaryCol, (v) => _salaryCol = v),
          ),
        ],
      ),
    ),
    _section(
      'طريقة الجبر',
      GroupList(
        children: [
          for (final m in RoundingMode.values)
            ListRow(
              enabled: !_busy,
              selected: m == _mode,
              leading: IconChip(
                m == _mode ? Icons.check : Icons.circle_outlined,
                color: m == _mode ? Tw.accentInk : Tw.ink3,
                bg: m == _mode ? Tw.surface : Tw.surface2,
              ),
              title: m.label + (m == _defaultMode ? ' (الافتراضي)' : ''),
              subtitle: Text('${m.term}\n${m.example}'),
              onTap: () => setState(() => _mode = m),
            ),
        ],
      ),
    ),
    _section(
      null,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 4),
          ErpButton(
            label: 'جبر الرواتب',
            icon: Icons.calculate_outlined,
            onPressed: _busy ? null : _round,
          ),
          const Caption(
            'تُعرض المعاينة للتأكيد، ثم يظهر الفرق بعد الجبر ويُحفظ في سجل الفروقات. الافتراضي يُغيَّر من الإعدادات.',
            center: true,
          ),
        ],
      ),
    ),
    if (_log.isNotEmpty)
      _section(
        'سجل الفروقات',
        GroupList(
          children: [
            for (final e in _log.take(50))
              ListRow(
                leading: IconChip(Icons.receipt_long_outlined),
                title:
                    '${e.difference >= 0 ? '' : '+'}${AdjustmentsService.money(e.difference.abs())} · ${e.mode.label}',
                subtitle: Text(
                  '${_date(e.at)} · ${formatCount(e.count)} راتب · ${e.sheet}',
                ),
                trailing: const RowChevron(),
                onTap: () => _openLogEntry(e),
              ),
          ],
        ),
      ),
  ];
}

/// The preview of a sort: the sheets it will fill, before anything is
/// written.
class _SortPreview extends StatelessWidget {
  const _SortPreview({required this.plan});
  final SortPlan plan;

  @override
  Widget build(BuildContext context) {
    final fresh = plan.groups.where((g) => !g.exists).length;
    return AppSheet(
      title: 'معاينة الفرز',
      footer: Row(
        children: [
          ErpButton(
            label: 'إلغاء',
            kind: ErpButtonKind.outline,
            expand: false,
            onPressed: () => Navigator.pop(context, false),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: ErpButton(
              label: 'فرز إلى الأوراق',
              icon: Icons.call_split,
              onPressed: () => Navigator.pop(context, true),
            ),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '${formatCount(plan.rowCount)} صفًا من «${plan.sheetTitle}» حسب العمود ${plan.column} إلى ${formatCount(plan.groups.length)} ورقة: ${formatCount(fresh)} جديدة و${formatCount(plan.groups.length - fresh)} موجودة.',
            style: TextStyle(fontSize: 14.5, height: 1.7, color: Tw.ink2),
          ),
          const SizedBox(height: 12),
          FormRows(
            children: [
              for (final g in plan.groups)
                FormRow(
                  g.sheetName,
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        '${formatCount(g.rows.length)} صف',
                        style: TextStyle(fontSize: 14, color: Tw.ink2),
                      ),
                      const SizedBox(width: 8),
                      StatusBadge(
                        g.exists ? 'موجودة' : 'جديدة',
                        tone: g.exists ? Tone.neutral : Tone.success,
                        small: true,
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The preview of a merge, before the result sheet is written.
class _MergePreview extends StatelessWidget {
  const _MergePreview({required this.plan});
  final MergePlan plan;

  @override
  Widget build(BuildContext context) {
    final dups =
        plan.duplicates.entries.toList()..sort((a, b) => b.value - a.value);
    return AppSheet(
      title: 'معاينة الدمج',
      footer: Row(
        children: [
          ErpButton(
            label: 'إلغاء',
            kind: ErpButtonKind.outline,
            expand: false,
            onPressed: () => Navigator.pop(context, false),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: ErpButton(
              label: 'دمج الرواتب',
              icon: Icons.merge_type,
              onPressed: () => Navigator.pop(context, true),
            ),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '${formatCount(plan.sourceRows)} صفًا من «${plan.sheetTitle}» ← ${formatCount(plan.rows.length)} اسمًا، منها ${formatCount(dups.length)} مكرر يُدمج. تُكتب النتيجة في ورقة «${plan.resultTitle}»${plan.resultExists ? ' (موجودة: تُستبدل محتوياتها)' : ' (جديدة)'}.',
            style: TextStyle(fontSize: 14.5, height: 1.7, color: Tw.ink2),
          ),
          if (dups.isNotEmpty) ...[
            const SheetLabel('الأسماء المكررة'),
            FormRows(
              children: [
                for (final e in dups.take(100))
                  FormRow(
                    e.key,
                    Text(
                      '${formatCount(e.value)} صفوف',
                      style: TextStyle(fontSize: 14, color: Tw.ink2),
                    ),
                  ),
              ],
            ),
            if (dups.length > 100)
              Caption('و${formatCount(dups.length - 100)} اسمًا آخر.'),
          ],
        ],
      ),
    );
  }
}
