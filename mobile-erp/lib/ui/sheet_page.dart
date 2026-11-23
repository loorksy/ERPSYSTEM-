// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'dart:async';

import 'package:flutter/material.dart';

import '../app_services.dart';
import '../data/app_database.dart';
import '../data/file_import.dart';
import '../erp/js_compat.dart';
import '../erp/payroll_audit_engine.dart';
import '../google/sheets_client.dart';
import '../services/payroll_models.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';
import 'help.dart';
import 'period_actions.dart';
import 'shell.dart';
import 'spreadsheet_link.dart';
import 'ui_kit.dart';

const _months = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];

String formatArabicDate(DateTime d) {
  final l = d.toLocal();
  return '${l.day} ${_months[l.month - 1]} ${l.year}';
}

/// «الدورات المالية» (ERP «Sheet»), from the owner's mockup: the latest
/// period on top as a card with its status, the outcome strip and one
/// button; the other periods below as rows with a small strip. The create
/// window is [CycleModal].
class SheetPage extends StatefulWidget {
  const SheetPage({super.key, this.onAudit, this.onCount});

  /// Opens the audit screen of a period.
  final ValueChanged<int>? onAudit;

  /// The number of periods (the frame shows «دورة جديدة» when there are
  /// some; the welcome state has its own button).
  final ValueChanged<int>? onCount;

  @override
  State<SheetPage> createState() => SheetPageState();
}

/// Audit state of a period shown on its row.
enum PeriodState { pending, running, audited, closed, failed }

/// What the list shows for a period: its state, its latest job and the
/// outcome of its last finished audit with the colours it was run with.
class _PeriodInfo {
  const _PeriodInfo(
    this.state, {
    this.job,
    this.counts,
    this.agentColor,
    this.mgmtColor,
  });
  final PeriodState state;
  final AuditJob? job;

  /// total, agent, management, notFound, noSalary.
  final List<int>? counts;
  final Color? agentColor;
  final Color? mgmtColor;

  List<StripPart> get parts =>
      counts == null
          ? const []
          : [
            (counts![1], agentColor),
            (counts![2], mgmtColor),
            if (counts!.length > 4) (counts![4], Tw.slate400),
            (counts![3], null),
          ];
}

class SheetPageState extends State<SheetPage> {
  List<Cycle>? _cycles;
  Map<int, _PeriodInfo> _info = const {};
  int _revision = -1;
  Timer? _poll;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final services = AppScope.of(context);
    if (services.cyclesRevision != _revision) {
      _revision = services.cyclesRevision;
      _load();
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final db = AppScope.read(context).db;
    final list = await db.listCycles();
    final info = <int, _PeriodInfo>{};
    var running = false;
    for (final c in list) {
      final jobs = await db.auditJobsOfCycle(c.id);
      final job = jobs.firstOrNull;
      final state =
          job != null && job.active
              ? PeriodState.running
              : c.auditClosedAt != null
              ? PeriodState.closed
              : job?.status == AuditJob.done
              ? PeriodState.audited
              : job?.status == AuditJob.failed
              ? PeriodState.failed
              : PeriodState.pending;
      running |= state == PeriodState.running;
      // The strip shows the last finished audit (not a follow-up tool).
      final audit =
          jobs
              .where(
                (j) =>
                    j.status == AuditJob.done &&
                    JobKind.of(j.request) == JobKind.audit,
              )
              .firstOrNull;
      final counts =
          audit == null ? null : await db.getAuditJobSummaryCounts(audit.id);
      info[c.id] = _PeriodInfo(
        state,
        job: job,
        counts: counts,
        agentColor: hexColor(
          '${audit?.request['agentColor'] ?? defaultAgentColor}',
        ),
        mgmtColor: hexColor(
          '${audit?.request['managementColor'] ?? defaultManagementColor}',
        ),
      );
    }
    if (!mounted) return;
    setState(() {
      _cycles = list;
      _info = info;
    });
    widget.onCount?.call(list.length);
    // Follow a running audit on the card (step label and progress).
    _poll?.cancel();
    if (running) {
      _poll = Timer(const Duration(seconds: 2), () {
        if (mounted) _load();
      });
    }
  }

  /// «دورة جديدة».
  void openCreate() => _openModal();

  /// After returning from a period's audit screen.
  Future<void> refresh() => _load();

  Future<void> _openModal([Cycle? edit]) async {
    final saved = await showAppSheet<bool>(
      context,
      (_) => CycleModal(edit: edit),
    );
    if (saved == true && mounted) AppScope.read(context).cyclesChanged();
  }

  Future<void> _action(Cycle c, PeriodAction a) async {
    if (a == PeriodAction.audit) {
      widget.onAudit?.call(c.id);
      return;
    }
    await runPeriodAction(context, c, a);
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final cycles = _cycles;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.only(bottom: 96),
        children: [
          ScreenHeader(title: 'الدورات المالية', help: () => periodsHelp),
          if (cycles == null)
            const Padding(
              padding: EdgeInsets.all(48),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (cycles.isEmpty)
            EmptyState(
              icon: Icons.calendar_today_outlined,
              leading: Image.asset(
                'assets/brand/logo.png',
                width: 84,
                height: 84,
              ),
              title: 'لا دورات مالية بعد',
              message:
                  'ابدأ بإنشاء دورة مالية: اربط جدول الإدارة (أو «بدون جدول الإدارة» مع جدول بيانات المستخدمين) وجدول الوكيل من Google Sheets أو من ملفات Excel / CSV، ثم دقّقها من هنا.',
              action: ErpButton(
                label: 'إنشاء دورة مالية',
                icon: Icons.add,
                expand: false,
                onPressed: _openModal,
              ),
            )
          else ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 0),
              child: _hero(cycles.first),
            ),
            if (cycles.length > 1)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SectionLabel('الدورات السابقة'),
                    GroupList(
                      inset: 70,
                      children: [for (final c in cycles.skip(1)) _row(c)],
                    ),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }

  _PeriodInfo _of(Cycle c) =>
      _info[c.id] ?? const _PeriodInfo(PeriodState.pending);

  String _source(Cycle c) =>
      c.linkedToGoogle ? ltr('Google Sheets') : 'ملفات ${ltr('Excel / CSV')}';

  /// The strip of a period: the last outcome, or the running sweep.
  Widget _strip(_PeriodInfo i, {double height = 8}) {
    final job = i.job;
    if (i.state == PeriodState.running && job != null) {
      final p = job.stepTotal > 0 ? job.stepNext / job.stepTotal : 0.0;
      return ResultStrip(parts: i.parts, height: height, progress: p);
    }
    return ResultStrip(parts: i.parts, height: height);
  }

  /// `.hero`: the latest period.
  Widget _hero(Cycle c) {
    final i = _of(c);
    final bold = TextStyle(fontWeight: FontWeight.w700, color: Tw.ink);
    final (InlineSpan foot, String cta) = switch (i.state) {
      PeriodState.running => (
        TextSpan(text: '${i.job?.progress ?? 'جاري التدقيق'}…'),
        'متابعة التدقيق',
      ),
      PeriodState.failed => (
        TextSpan(text: i.job?.error ?? 'تعذّر التدقيق'),
        'إعادة التدقيق',
      ),
      _ when i.counts != null => (
        TextSpan(
          children: [
            const TextSpan(text: 'السجلات المدققة '),
            TextSpan(text: formatCount(i.counts![0]), style: bold),
          ],
        ),
        'عرض النتائج',
      ),
      _ => (
        TextSpan(
          children: [
            const TextSpan(text: 'سجلات الإدارة '),
            TextSpan(text: formatCount(c.managementCount), style: bold),
            const TextSpan(text: '، سجلات الوكيل '),
            TextSpan(text: formatCount(c.agentCount), style: bold),
          ],
        ),
        i.state == PeriodState.audited ? 'عرض النتائج' : 'تدقيق الدورة',
      ),
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
      decoration: panelDecoration(radius: Ds.radiusL),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              periodBadge(i.state),
              const Spacer(),
              Transform.translate(
                offset: const Offset(-10, 0),
                child: PeriodMenu(cycle: c, onSelected: (a) => _action(c, a)),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            periodName(c),
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w800,
              height: 1.35,
              color: Tw.ink,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            '${_source(c)}، ${formatArabicDate(c.createdAt)}',
            style: TextStyle(fontSize: 14.5, color: Tw.ink2),
          ),
          const SizedBox(height: 18),
          _strip(i),
          const SizedBox(height: 10),
          Text.rich(foot, style: TextStyle(fontSize: 14, color: Tw.ink2)),
          const SizedBox(height: 18),
          ErpButton(
            label: cta,
            onPressed:
                widget.onAudit == null ? null : () => widget.onAudit!(c.id),
          ),
        ],
      ),
    );
  }

  /// `.prow`: a previous period.
  Widget _row(Cycle c) {
    final i = _of(c);
    final (label, tone) = periodStatus(i.state);
    final (_, color) = toneColors(tone);
    return ListRow(
      title: periodName(c),
      onTap: widget.onAudit == null ? null : () => widget.onAudit!(c.id),
      leading: IconChip(
        c.linkedToGoogle
            ? Icons.table_chart_outlined
            : Icons.description_outlined,
        size: 40,
      ),
      subtitle: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: label,
              style: TextStyle(fontWeight: FontWeight.w700, color: color),
            ),
            TextSpan(text: '، ${formatArabicDate(c.createdAt)}'),
          ],
        ),
      ),
      below: Padding(
        padding: const EdgeInsets.only(top: 9),
        child: _strip(i, height: 4),
      ),
      trailing: PeriodMenu(cycle: c, onSelected: (a) => _action(c, a)),
    );
  }
}

/// The label and tone of a period state (`statusOf` in the mockup).
(String, Tone) periodStatus(PeriodState s) => switch (s) {
  PeriodState.running => ('قيد التنفيذ', Tone.info),
  PeriodState.audited => ('مدققة', Tone.success),
  PeriodState.closed => ('مُقفلة', Tone.neutral),
  PeriodState.failed => ('تعذّر التدقيق', Tone.danger),
  PeriodState.pending => ('بانتظار التدقيق', Tone.warning),
};

/// `.pill` of a period state.
StatusBadge periodBadge(PeriodState s) {
  final (label, tone) = periodStatus(s);
  return StatusBadge(
    label,
    tone: tone,
    icon: switch (s) {
      PeriodState.running => Icons.sync,
      PeriodState.audited => Icons.check,
      PeriodState.closed => Icons.lock_outline,
      PeriodState.failed => Icons.error_outline,
      PeriodState.pending => Icons.schedule,
    },
  );
}

class CycleModal extends StatefulWidget {
  const CycleModal({super.key, this.edit});
  final Cycle? edit;
  @override
  State<CycleModal> createState() => _CycleModalState();
}

class _CycleModalState extends State<CycleModal> {
  bool _googleTab = true;
  bool _showSave = false;
  bool _busy = false;
  bool _saving = false;
  String? _listMessage = 'جاري التحميل...';
  List<SpreadsheetFile> _files = const [];
  String _mgmtSs = '';
  String _mgmtSheet = '';
  String _agentSs = '';
  String _agentSheet = '';
  List<String> _mgmtSheets = const [];
  List<String> _agentSheets = const [];

  /// «بدون جدول الإدارة» in the management list (owner's request
  /// 2026-11-23, 3.4.0): the cycle is audited with the user-info and agent
  /// sheets only, and its user-info sheet is chosen here.
  static const _noMgmtValue = '__no_management__';
  bool get _noMgmt => _mgmtSs == _noMgmtValue;
  String _uiSs = '';
  String _uiSheet = '';
  List<String> _uiSheets = const [];
  ImportedFile? _mgmtFile;
  ImportedFile? _agentFile;
  Rows _currentMgmt = const [];
  Rows _currentAgent = const [];
  String _mgmtCount = '0';
  String _agentCount = '0';
  final _name = TextEditingController();
  final _discount = TextEditingController();

  AppServices get _s => AppScope.read(context);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _init());
  }

  @override
  void dispose() {
    _name.dispose();
    _discount.dispose();
    super.dispose();
  }

  Future<void> _init() async {
    await _loadSpreadsheets();
    final e = widget.edit;
    if (e == null || !mounted) return;
    _name.text = e.name;
    _discount.text =
        e.transferDiscountPct == 0
            ? ''
            : jsNumberToString(e.transferDiscountPct);
    if (e.managementSpreadsheetId != null) {
      _mgmtSs = e.managementSpreadsheetId!;
      await _loadSheets(true, _mgmtSs);
      _mgmtSheet = e.managementSheetName ?? '';
    } else if (e.agentSpreadsheetId != null) {
      _mgmtSs = _noMgmtValue;
      final ui = e.userInfoSpreadsheetId;
      if (ui != null) {
        _uiSs = ui;
        await _loadUiSheets(ui);
        _uiSheet = e.userInfoSheetName ?? '';
      }
    }
    if (e.agentSpreadsheetId != null) {
      _agentSs = e.agentSpreadsheetId!;
      await _loadSheets(false, _agentSs);
      _agentSheet = e.agentSheetName ?? '';
    }
    if (!mounted) return;
    setState(() {
      _showSave = true;
      _mgmtCount = '—';
      _agentCount = '—';
    });
  }

  Future<void> _loadSpreadsheets() async {
    setState(() => _listMessage = 'جاري التحميل...');
    try {
      final files = await _s.sheets.listSpreadsheets();
      if (!mounted) return;
      setState(() {
        _files = [
          ...files,
          for (final f in _files)
            if (!files.any((x) => x.id == f.id)) f,
        ];
        _listMessage = null;
      });
    } catch (e) {
      if (mounted) setState(() => _listMessage = e.toString());
    }
  }

  Future<void> _loadUiSheets(String id) async {
    if (id.isEmpty) {
      setState(() => _uiSheets = const []);
      return;
    }
    try {
      final meta = await _s.sheets.getSpreadsheet(id);
      if (!mounted) return;
      setState(() => _uiSheets = [for (final s in meta.sheets) s.title]);
    } catch (_) {}
  }

  Future<void> _loadSheets(bool mgmt, String id) async {
    if (id.isEmpty || id == _noMgmtValue) {
      setState(() => mgmt ? _mgmtSheets = const [] : _agentSheets = const []);
      return;
    }
    try {
      final meta = await _s.sheets.getSpreadsheet(id);
      if (!mounted) return;
      setState(() {
        final titles = [for (final s in meta.sheets) s.title];
        if (mgmt) {
          _mgmtSheets = titles;
        } else {
          _agentSheets = titles;
        }
      });
    } catch (_) {}
  }

  List<SelectOption<String>> _ssOptions({bool mgmt = false}) {
    final msg = _listMessage;
    if (msg != null) {
      return [
        SelectOption('', msg),
        const SelectOption(pasteLinkValue, pasteLinkLabel),
      ];
    }
    final known = {for (final f in _files) f.id};
    return [
      const SelectOption('', '— اختر الجدول —'),
      if (mgmt) const SelectOption(_noMgmtValue, 'بدون جدول الإدارة'),
      const SelectOption(pasteLinkValue, pasteLinkLabel),
      for (final f in _files) SelectOption(f.id, f.name),
      if (_mgmtSs.isNotEmpty && !_noMgmt && !known.contains(_mgmtSs))
        SelectOption(_mgmtSs, _mgmtSs),
      if (_uiSs.isNotEmpty &&
          !known.contains(_uiSs) &&
          _uiSs != _mgmtSs &&
          _uiSs != _agentSs)
        SelectOption(_uiSs, _uiSs),
      if (_agentSs.isNotEmpty &&
          !known.contains(_agentSs) &&
          _agentSs != _mgmtSs)
        SelectOption(_agentSs, _agentSs),
    ];
  }

  List<SelectOption<String>> _sheetOptions(
    List<String> titles,
    String current,
  ) => [
    const SelectOption('', 'أول ورقة تلقائياً'),
    for (final t in titles) SelectOption(t, t),
    if (current.isNotEmpty && !titles.contains(current))
      SelectOption(current, current),
  ];

  void _showSavePanel(Rows m, Rows a) {
    setState(() {
      _currentMgmt = m;
      _currentAgent = a;
      _mgmtCount = '${m.length}';
      _agentCount = '${a.length}';
      _showSave = true;
    });
  }

  Future<void> _primary() async {
    if (_googleTab) {
      await _fetchFromGoogle();
    } else {
      _uploadFiles();
    }
  }

  Future<void> _fetchFromGoogle() async {
    final problem =
        _mgmtSs.isEmpty
            ? 'اختر جدول الإدارة، أو «بدون جدول الإدارة»'
            : _agentSs.isEmpty
            ? 'اختر جدول الوكيل من القائمة'
            : _noMgmt && _uiSs.isEmpty
            ? 'اختر جدول بيانات المستخدمين'
            : null;
    if (problem != null) {
      showToast(context, problem, ToastType.error);
      return;
    }
    setState(() => _busy = true);
    try {
      final (m, a) = await _s.cycles.importFromGoogle(
        managementSpreadsheetId: _noMgmt ? null : _mgmtSs,
        managementSheetName: _mgmtSheet,
        agentSpreadsheetId: _agentSs,
        agentSheetName: _agentSheet,
      );
      if (!mounted) return;
      _showSavePanel(m, a);
      showToast(context, 'تم جلب البيانات', ToastType.success);
    } catch (e) {
      if (mounted) showToast(context, e.toString(), ToastType.error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pick(bool mgmt) async {
    try {
      final f = await pickSpreadsheetFile();
      if (f == null || !mounted) return;
      setState(() => mgmt ? _mgmtFile = f : _agentFile = f);
      final m = _mgmtFile;
      final a = _agentFile;
      if (_showSave && a != null) {
        _showSavePanel(m?.firstSheetRows ?? const [], a.firstSheetRows);
      }
    } catch (e) {
      if (mounted) showToast(context, e.toString(), ToastType.error);
    }
  }

  void _uploadFiles() {
    final m = _mgmtFile;
    final a = _agentFile;
    if (a == null) {
      showToast(
        context,
        'اختر ملف الوكيل (ملف الإدارة اختياري)',
        ToastType.error,
      );
      return;
    }
    _showSavePanel(m?.firstSheetRows ?? const [], a.firstSheetRows);
    showToast(context, 'تم قراءة الملفات', ToastType.success);
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      showToast(context, 'أدخل اسم الدورة', ToastType.error);
      return;
    }
    setState(() => _saving = true);
    try {
      final tdpRaw = _discount.text.trim();
      final tdp = tdpRaw.isEmpty ? null : jsParseFloat(tdpRaw);
      var mSs = _mgmtSs.isEmpty || _noMgmt ? null : _mgmtSs;
      // The user-info sheet is saved with a cycle without management.
      final uiSs = _googleTab && _noMgmt && _uiSs.isNotEmpty ? _uiSs : null;
      final uiSheet = uiSs == null ? null : _uiSheet;
      var aSs = _agentSs.isEmpty ? null : _agentSs;
      Rows? mRows;
      Rows? aRows;
      final haveRows = _currentMgmt.isNotEmpty || _currentAgent.isNotEmpty;
      // A Google period needs its agent sheet; the management sheet is
      // optional (3.4.0). Without an agent sheet the rows are from files.
      if ((aSs == null || !_googleTab) && haveRows) {
        mRows = _currentMgmt;
        aRows = _currentAgent;
        mSs = null;
        aSs = null;
      } else if (aSs != null && _googleTab && haveRows) {
        mRows = _currentMgmt;
        aRows = _currentAgent;
      }
      final edit = widget.edit;
      if (edit == null) {
        await _s.cycles.createCycle(
          name: name,
          managementRows: mRows,
          agentRows: aRows,
          managementSpreadsheetId: mSs,
          managementSheetName: mSs == null ? null : _mgmtSheet,
          agentSpreadsheetId: aSs,
          agentSheetName: aSs == null ? null : _agentSheet,
          transferDiscountPct: tdp == null || tdp.isNaN ? 0 : tdp,
          userInfoSpreadsheetId: uiSs,
          userInfoSheetName: uiSheet,
        );
      } else {
        await _s.cycles.updateCycle(
          edit.id,
          name: name,
          managementRows: mRows,
          agentRows: aRows,
          managementSpreadsheetId: mSs,
          managementSheetName: mSs == null ? null : _mgmtSheet,
          agentSpreadsheetId: aSs,
          agentSheetName: aSs == null ? null : _agentSheet,
          transferDiscountPct: tdp == null || tdp.isNaN ? null : tdp,
          userInfoSpreadsheetId: uiSs,
          userInfoSheetName: uiSheet,
        );
      }
      if (!mounted) return;
      showToast(
        context,
        edit == null ? 'حُفظت الدورة المالية' : 'حُدّثت الدورة المالية',
        ToastType.success,
      );
      Navigator.pop(context, true);
    } catch (e) {
      if (mounted) showToast(context, e.toString(), ToastType.error);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // ------------------------------------------------------------------ UI
  // Owner's mockup (`npSheet`): the source as a segmented choice, the two
  // table / sheet pairs (or the two files), «جلب البيانات», then the record
  // counts, the name and the transfer discount, with «إلغاء» / «حفظ».

  @override
  Widget build(BuildContext context) {
    final failed =
        _googleTab && _listMessage != null && !_listMessage!.contains('جاري');
    return AppSheet(
      title: widget.edit == null ? 'دورة مالية جديدة' : 'تعديل الدورة المالية',
      actions: [
        if (_googleTab)
          RefreshAction(
            onRefresh: () async {
              await _loadSpreadsheets();
              await _loadSheets(true, _mgmtSs);
              await _loadSheets(false, _agentSs);
              if (_noMgmt) await _loadUiSheets(_uiSs);
            },
          ),
        HelpButton(title: 'الدورة المالية', items: () => newPeriodHelp),
      ],
      footer:
          _showSave
              ? Row(
                children: [
                  ErpButton(
                    label: 'إلغاء',
                    kind: ErpButtonKind.outline,
                    expand: false,
                    onPressed: () => Navigator.pop(context),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: ErpButton(
                      label: 'حفظ',
                      loadingLabel: 'جاري الحفظ...',
                      loading: _saving,
                      onPressed: _save,
                    ),
                  ),
                ],
              )
              : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SegmentedChoice(
            options: const ['Google Sheets', 'ملفات Excel / CSV'],
            selected: _googleTab ? 0 : 1,
            onChanged: (i) {
              if (i == 0) {
                setState(() => _googleTab = true);
                _loadSpreadsheets();
              } else {
                setState(() => _googleTab = false);
              }
            },
          ),
          if (_googleTab) ...[
            if (failed)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: NoticeBox(
                  bg: Tw.warnSoft,
                  child: Text(
                    'سجّل الدخول بحساب Google من الإعدادات لاختيار الجداول، أو استخدم ملفات Excel / CSV. ($_listMessage)',
                    style: TextStyle(color: Tw.warn),
                  ),
                ),
              ),
            const SheetLabel('جدول الإدارة'),
            _ssPair(true),
            if (_noMgmt) ...[
              const SheetLabel('جدول بيانات المستخدمين'),
              _uiPair(),
              const Caption(
                'بدون جدول الإدارة: تُدقق الدورة بجدولي بيانات المستخدمين والوكيل فقط. من له راتب في الوكيل «سحب وكالة»، ومن رقمه في الوكيل وراتبه 0 «بدون راتب»، ومن ليس في الوكيل «غير موجود»، ولا يُنسخ شيء إلى أوراق الوكالات.',
              ),
            ],
            const SheetLabel('جدول الوكيل'),
            _ssPair(false),
          ] else ...[
            const SheetLabel('ملف جدول الإدارة (اختياري)'),
            _filePicker(true),
            const SheetLabel('ملف جدول الوكيل'),
            _filePicker(false),
          ],
          const SizedBox(height: 16),
          if (!_showSave)
            ErpButton(
              label: _googleTab ? 'جلب البيانات' : 'تحميل الملفات',
              loadingLabel: _googleTab ? 'جاري الجلب…' : 'جاري القراءة…',
              icon:
                  _googleTab
                      ? Icons.cloud_outlined
                      : Icons.description_outlined,
              kind: ErpButtonKind.indigoSoft,
              loading: _busy,
              onPressed: _primary,
            )
          else
            _savePanel(),
        ],
      ),
    );
  }

  /// `.pair`: the spreadsheet (1.4) and its sheet (1).
  Widget _ssPair(bool mgmt) {
    final ss = mgmt ? _mgmtSs : _agentSs;
    final sheet = mgmt ? _mgmtSheet : _agentSheet;
    final sheets = mgmt ? _mgmtSheets : _agentSheets;
    return Row(
      children: [
        Expanded(
          flex: 14,
          child: ErpSelect<String>(
            options: _ssOptions(mgmt: mgmt),
            value: ss,
            onChanged: (picked) async {
              var v = picked;
              if (v == pasteLinkValue) {
                final f = await askSpreadsheetLink(context, _s.sheets);
                if (f == null || !mounted) return;
                setState(() {
                  _files = [f, ..._files.where((x) => x.id != f.id)];
                  _listMessage = null;
                });
                v = f.id;
              }
              setState(() {
                if (mgmt) {
                  _mgmtSs = v;
                  _mgmtSheet = '';
                } else {
                  _agentSs = v;
                  _agentSheet = '';
                }
              });
              _loadSheets(mgmt, v);
            },
          ),
        ),
        if (!(mgmt && _noMgmt)) ...[
          const SizedBox(width: 8),
          Expanded(
            flex: 10,
            child: ErpSelect<String>(
              options: _sheetOptions(sheets, sheet),
              value: sheet,
              onChanged:
                  (v) =>
                      setState(() => mgmt ? _mgmtSheet = v : _agentSheet = v),
            ),
          ),
        ],
      ],
    );
  }

  /// The user-info spreadsheet and sheet of a cycle without management.
  Widget _uiPair() => Row(
    children: [
      Expanded(
        flex: 14,
        child: ErpSelect<String>(
          options: _ssOptions(),
          value: _uiSs,
          onChanged: (picked) async {
            var v = picked;
            if (v == pasteLinkValue) {
              final f = await askSpreadsheetLink(context, _s.sheets);
              if (f == null || !mounted) return;
              setState(() {
                _files = [f, ..._files.where((x) => x.id != f.id)];
                _listMessage = null;
              });
              v = f.id;
            }
            setState(() {
              _uiSs = v;
              _uiSheet = '';
            });
            _loadUiSheets(v);
          },
        ),
      ),
      const SizedBox(width: 8),
      Expanded(
        flex: 10,
        child: ErpSelect<String>(
          options: _sheetOptions(_uiSheets, _uiSheet),
          value: _uiSheet,
          onChanged: (v) => setState(() => _uiSheet = v),
        ),
      ),
    ],
  );

  /// `.filepick`.
  Widget _filePicker(bool mgmt) {
    final f = mgmt ? _mgmtFile : _agentFile;
    final on = f != null;
    return Material(
      color: on ? Tw.accentSoft : Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: on ? Tw.accentSoft : Tw.surface3, width: 1.5),
      ),
      child: InkWell(
        onTap: () => _pick(mgmt),
        borderRadius: BorderRadius.circular(16),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 64),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                Icon(
                  Icons.description_outlined,
                  size: 22,
                  color: on ? Tw.accentInk : Tw.ink2,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        on ? f.fileName : 'اختيار ملف',
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          color: Tw.ink,
                        ),
                      ),
                      Text(
                        on
                            ? '${formatCount(f.firstSheetRows.length)} صف في الورقة الأولى'
                            : 'لم يتم اختيار ملف (.xlsx, .csv)',
                        style: TextStyle(fontSize: 13, color: Tw.ink2),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// `.fetched` + the name and the transfer discount.
  Widget _savePanel() {
    final b = TextStyle(fontSize: 15, fontWeight: FontWeight.w700);
    String n(String v) =>
        int.tryParse(v) == null ? v : formatCount(int.parse(v));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: Tw.accentSoft,
            borderRadius: BorderRadius.circular(14),
          ),
          child: DefaultTextStyle.merge(
            style: TextStyle(fontSize: 14, color: Tw.accentInk),
            child: Wrap(
              spacing: 14,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Icon(Icons.check, size: 18, color: Tw.accentInk),
                Text.rich(
                  TextSpan(
                    children: [
                      const TextSpan(text: 'سجلات الإدارة '),
                      TextSpan(text: n(_mgmtCount), style: b),
                    ],
                  ),
                ),
                Text.rich(
                  TextSpan(
                    children: [
                      const TextSpan(text: 'سجلات الوكيل '),
                      TextSpan(text: n(_agentCount), style: b),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        const FieldHeader('اسم الدورة'),
        ErpTextField(controller: _name, hint: 'مثال: رواتب يناير 2026'),
        const SizedBox(height: 12),
        const FieldHeader('نسبة خصم التحويل (%)'),
        ErpTextField(
          controller: _discount,
          hint: '0',
          ltr: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
        ),
        const Caption(
          'تُحفظ مع الدورة. خصم التدقيق نفسه يُحدَّد من «إعداد التدقيق».',
        ),
      ],
    );
  }
}
