// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_services.dart';
import '../data/app_database.dart';
import '../erp/js_compat.dart';
import '../erp/normalize.dart';
import '../google/sheets_client.dart';
import '../services/adjustments_service.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';
import 'help.dart';
import 'shell.dart';
import 'spreadsheet_link.dart';
import 'ui_kit.dart';

const _draftKey = 'adjustmentsDraftV1';

/// ERP «إضافات وخصومات» (`views/partials/member-adjustments.ejs`), bulk
/// only and without the advanced accounting registration (owner's
/// decision, 2026-11-17). Separate from the audit.
class AdjustmentsPage extends StatefulWidget {
  const AdjustmentsPage({super.key, required this.active});
  final bool active;

  @override
  State<AdjustmentsPage> createState() => _AdjustmentsPageState();
}

class _AdjustmentsPageState extends State<AdjustmentsPage> {
  bool _ready = false;
  String? _ssMessage = 'جاري جلب الملفات…';
  List<SpreadsheetFile> _files = const [];
  String _ssId = '';
  List<String> _sheetNames = const [];
  String? _sheetMessage = 'اختر الجدول أولاً';
  String _sheet = '';
  String _idCol = AdjustmentsService.defaultIdCol;
  String _salaryCol = AdjustmentsService.defaultSalaryCol;
  String _statusCol = AdjustmentsService.defaultStatusCol;

  /// Second system (owner, 3.3.0), chosen in the settings: the salary after
  /// the adjustments goes to [_outCol] and the three columns after it.
  bool _columnMode = false;
  String _outCol = '';
  final _bulk = TextEditingController();

  AuditJob? _job;
  Timer? _poll;
  AdjustOutcome? _last;
  int? _lastJobId;
  String _lastSsId = '';

  /// ERP offers columns A–Z.
  static final _letters = [for (var i = 0; i < 26; i++) columnIndexToLetter(i)];

  AppServices get _s => AppScope.read(context);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_ready) return;
    _ready = true;
    _init();
  }

  @override
  void didUpdateWidget(AdjustmentsPage old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) {
      if (_files.isEmpty) _loadFiles();
      _loadSystem();
    }
  }

  /// The system chosen in the settings (it may change while this tab is
  /// hidden).
  Future<void> _loadSystem() async {
    final on = await _s.adjustments.columnSystem();
    if (mounted && on != _columnMode) setState(() => _columnMode = on);
  }

  @override
  void dispose() {
    _poll?.cancel();
    _bulk.dispose();
    super.dispose();
  }

  Future<void> _init() async {
    await _loadSystem();
    await _restoreDraft();
    await _loadFiles();
    await _watchJob();
  }

  // --------------------------------------------------------------- draft

  Future<void> _saveDraft() => _s.db.setValue(
    _draftKey,
    jsonEncode({
      'ssId': _ssId,
      'sheet': _sheet,
      'idCol': _idCol,
      'salaryCol': _salaryCol,
      'statusCol': _statusCol,
      'outCol': _outCol,
      'bulk': _bulk.text,
    }),
  );

  Future<void> _restoreDraft() async {
    final raw = await _s.db.getValue(_draftKey);
    if (raw == null || !mounted) return;
    try {
      final d = Map<String, dynamic>.from(jsonDecode(raw) as Map);
      String col(String key, String fallback) {
        final v = d[key]?.toString() ?? '';
        return _letters.contains(v) ? v : fallback;
      }

      setState(() {
        _ssId = d['ssId']?.toString() ?? '';
        _sheet = d['sheet']?.toString() ?? '';
        _idCol = col('idCol', _idCol);
        _salaryCol = col('salaryCol', _salaryCol);
        _statusCol = col('statusCol', _statusCol);
        final out = d['outCol']?.toString() ?? '';
        _outCol = columnLetterToIndex(out) == null ? '' : out;
        _bulk.text = d['bulk']?.toString() ?? '';
      });
      if (_ssId.isNotEmpty) await _loadSheets(keep: true);
    } catch (_) {}
  }

  // -------------------------------------------------------------- google

  Future<void> _loadFiles() async {
    setState(() => _ssMessage = 'جاري جلب الملفات…');
    try {
      final list = await _s.sheets.listSpreadsheets();
      if (!mounted) return;
      setState(() {
        _files = list;
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
        if (!keep || !names.contains(_sheet)) {
          _sheet = names.isEmpty ? '' : names.first;
        }
        if (!_files.any((f) => f.id == _ssId)) {
          _files = [SpreadsheetFile(_ssId, meta.title ?? _ssId), ..._files];
        }
      });
      await _loadHeader();
    } catch (e) {
      if (mounted) setState(() => _sheetMessage = '$e');
    }
  }

  /// The header row of the salaries sheet: the column pickers show
  /// «C - رقم المستخدم» like ERPSYSTEM.
  List<String> _header = const [];

  Future<void> _loadHeader() async {
    if (_ssId.isEmpty || _sheet.isEmpty) return;
    try {
      final rows = await _s.sheets.valuesGet(
        _ssId,
        "'${escapeSheetTitleForRange(_sheet)}'!1:1",
      );
      if (mounted) {
        setState(() => _header = rows.isEmpty ? const [] : rows.first);
      }
    } catch (_) {
      // Letters only.
    }
  }

  // ----------------------------------------------------------------- run

  Future<void> _run() async {
    if (_ssId.isEmpty || _sheet.isEmpty || _bulk.text.trim().isEmpty) {
      showToast(context, 'اختر الجدول والورقة وأدخل القائمة', ToastType.error);
      return;
    }
    if (_job?.active ?? false) {
      showToast(
        context,
        'يوجد تطبيق تسويات قيد التنفيذ. انتظر انتهاءه.',
        ToastType.warning,
      );
      return;
    }
    if (_columnMode && _outCol.isEmpty) {
      showToast(context, 'اختر عمود الراتب بعد التسوية', ToastType.error);
      await _openColumnsSheet();
      return;
    }
    await _saveDraft();
    await _s.startAdjustments(
      AdjustRequest(
        spreadsheetId: _ssId,
        sheetName: _sheet,
        idCol: _idCol,
        salaryCol: _salaryCol,
        statusCol: _statusCol,
        bulkData: _bulk.text,
        outputCol: _columnMode ? _outCol : '',
      ),
    );
    await _watchJob();
  }

  Future<void> _watchJob() async {
    _poll?.cancel();
    final job = await _s.db.latestCyclelessJob();
    if (!mounted) return;
    setState(() => _job = job);
    if (job == null) return;
    if (job.active) {
      _poll = Timer.periodic(const Duration(seconds: 1), (_) => _pollJob());
    } else {
      await _settle(job);
    }
  }

  Future<void> _pollJob() async {
    final current = _job;
    if (current == null) return;
    final job = await _s.db.getAuditJob(current.id);
    if (!mounted || job == null) return;
    setState(() => _job = job);
    if (!job.active) {
      _poll?.cancel();
      await _settle(job);
    } else if (job.status == AuditJob.queued &&
        DateTime.now().difference(job.updatedAt).inSeconds > 20) {
      await _s.resumeAuditJobs();
    }
  }

  /// A finished job: ERP opens the results window; here once per job.
  Future<void> _settle(AuditJob job) async {
    final json = await _s.db.getAuditJobResult(job.id);
    if (!mounted) return;
    final out = json == null ? null : AdjustOutcome.fromJson(json);
    if (out != null && out.success) {
      setState(() {
        _last = out;
        _lastJobId = job.id;
        _lastSsId = (job.request['spreadsheetId'] ?? '').toString();
      });
    }
    if (job.seen) return;
    await _s.db.updateAuditJob(job.id, {'seen': 1});
    if (!mounted) return;
    if (out == null || !out.success) {
      showToast(context, out?.message ?? job.error ?? 'فشل', ToastType.error);
      return;
    }
    // The list was applied: clear it so it is not sent twice.
    _bulk.clear();
    _saveDraft();
    await _showResults(out);
  }

  Future<void> _showResults(AdjustOutcome out) => showAppSheet<void>(
    context,
    (_) => _ResultsDialog(
      out,
      jobId: _lastJobId,
      spreadsheetId: _lastSsId,
      onChanged: (o) {
        if (mounted) setState(() => _last = o);
      },
    ),
  );

  // ------------------------------------------------------------------ UI
  //
  // Owner's mockup (`screenAdjust`): «جدول الرواتب» as two rows that open
  // sheets (the table and sheet, the field mapping), the list editor with
  // live counters, one primary action (or the run card), and «آخر تطبيق»
  // as three figures with «عرض التقرير».

  /// ERP offers A–Z; named from the sheet's header when it is known.
  List<SelectOption<String>> get _letterOptions =>
      columnOptions(_header, minColumns: 26).take(26).toList();

  Future<void> _paste() async {
    final t = await pasteText();
    if (t == null || t.isEmpty || !mounted) return;
    setState(() => _bulk.text = t);
    _saveDraft();
  }

  String get _tableName =>
      _files.where((f) => f.id == _ssId).map((f) => f.name).firstOrNull ??
      (_ssId.isEmpty ? 'اختر الجدول' : _ssId);

  /// `adjTableSheet`: the spreadsheet and the sheet of the salaries.
  Future<void> _openTableSheet() => showAppSheet<void>(
    context,
    (ctx) => StatefulBuilder(
      builder:
          (ctx, setLocal) => AppSheet(
            title: 'جدول الرواتب',
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
                  _columnMode
                      ? 'الجدول والورقة التي فيها رواتب المستخدمين، وعادة تكون بيانات المستخدمين. يُقرأ منها الراتب ولا يتغير، ويُكتب الراتب بعد التسوية في عمود تختاره.'
                      : 'الجدول والورقة التي فيها رواتب المستخدمين، وعادة تكون بيانات المستخدمين. يُعدَّل فيها عمودا الراتب والحالة.',
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
                          SelectOption(
                            '',
                            _ssMessage ?? '— اختر جدول البيانات —',
                          ),
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
                          _loadHeader();
                          setLocal(() {});
                          _saveDraft();
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

  /// The four columns of the second system, as «M، N، O، P».
  String get _outRange {
    final i = columnLetterToIndex(_outCol);
    if (i == null) return '';
    return '${columnIndexToLetter(i)}–${columnIndexToLetter(i + 3)}';
  }

  /// `adjColsSheet`: the id, salary and status columns (first system), or
  /// the id, salary and output columns (second system).
  Future<void> _openColumnsSheet() => showAppSheet<void>(
    context,
    (ctx) => StatefulBuilder(
      builder: (ctx, setLocal) {
        Widget col(
          String label,
          String value,
          void Function(String) set, {
          List<SelectOption<String>>? options,
        }) => FormRow(
          label,
          CompactSelect<String>(
            options: options ?? _letterOptions,
            shown: (v) => v.isEmpty ? '—' : v,
            value: value,
            onChanged: (v) {
              setState(() => set(v));
              setLocal(() {});
              _saveDraft();
            },
          ),
        );
        final i = columnLetterToIndex(_outCol);
        String l(int k) => i == null ? '' : columnIndexToLetter(i + k);
        return AppSheet(
          title: 'ربط الحقول',
          actions: [
            RefreshAction(
              onRefresh: () async {
                await _loadHeader();
                setLocal(() {});
              },
            ),
          ],
          footer: ErpButton(label: 'تم', onPressed: () => Navigator.pop(ctx)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FormRows(
                children: [
                  col('المعرّف', _idCol, (v) => _idCol = v),
                  col('الراتب', _salaryCol, (v) => _salaryCol = v),
                  if (_columnMode)
                    col(
                      'الراتب بعد التسوية',
                      _outCol,
                      (v) => _outCol = v,
                      options: [
                        const SelectOption('', '— اختر العمود —'),
                        ...columnOptions(_header),
                      ],
                    )
                  else
                    col('الحالة', _statusCol, (v) => _statusCol = v),
                ],
              ),
              Caption(
                _columnMode
                    ? i == null
                        ? 'عمود الراتب لا يتغير. اختر عمودًا فارغًا للراتب بعد التسوية؛ تُكتب بعده ثلاثة أعمدة (على يساره في الورقة العربية): الحالة، وحالة المستخدم، والعملية الحسابية.'
                        : 'يُكتب الراتب بعد التسوية في $_outCol ملوّنًا (أخضر للإضافة، أحمر للخصم)، و«الحالة» في ${l(1)}، و«حالة المستخدم» في ${l(2)} (مديون أو له)، و«العملية الحسابية» في ${l(3)} لمن له أكثر من سطر. عمود الراتب لا يتغير.'
                    : 'أعمدة جدول الرواتب: رقم المستخدم، والراتب الذي يُعدَّل، والحالة التي يُكتب فيها «تم خصم» أو «تم اضافة».',
              ),
            ],
          ),
        );
      },
    ),
  );

  @override
  Widget build(BuildContext context) {
    final job = _job;
    final busy = job?.active ?? false;
    final lines = AdjustmentsService.parseLines(_bulk.text);
    final adds = lines.where((l) => !l.full && !l.isDeduction).length;
    final deds = lines.where((l) => l.isDeduction).length;
    final full = lines.where((l) => l.full).length;
    final byId = <String, Set<bool>>{};
    final perId = <String, int>{};
    for (final l in lines.where((l) => !l.full)) {
      final id = normalizeUserId(l.userId);
      byId.putIfAbsent(id, () => {}).add(l.isDeduction);
      perId[id] = (perId[id] ?? 0) + 1;
    }
    final netted = byId.values.where((s) => s.length == 2).length;
    final merged =
        [
          for (final e in byId.entries)
            if (e.value.length == 1 && perId[e.key]! > 1) e.key,
        ].length;
    final connected = AppScope.of(context).auth.isConnected;
    Widget section(String title, Widget child, {Widget? trailing}) => Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [SectionLabel(title, trailing: trailing), child],
      ),
    );
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        ScreenHeader(title: 'تسويات الرواتب', help: () => adjustmentsHelp),
        section(
          'جدول الرواتب',
          trailing:
              _columnMode
                  ? StatusBadge('عمود منفصل', tone: Tone.info, small: true)
                  : null,
          GroupList(
            children: [
              if (connected)
                ListRow(
                  enabled: !busy,
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
              ListRow(
                enabled: !busy,
                leading: IconChip(Icons.view_column_outlined),
                title: 'ربط الحقول',
                subtitle:
                    !_columnMode
                        ? Text(
                          'المعرّف $_idCol، الراتب $_salaryCol، الحالة $_statusCol',
                        )
                        : _outCol.isEmpty
                        ? Text(
                          'اختر عمود الراتب بعد التسوية',
                          style: TextStyle(color: Tw.warn),
                        )
                        : Text(
                          'المعرّف $_idCol، الراتب $_salaryCol، بعد التسوية $_outRange',
                        ),
                trailing: const RowChevron(),
                onTap: _openColumnsSheet,
              ),
            ],
          ),
        ),
        section(
          'قائمة التسويات',
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextButton.icon(
                onPressed: busy ? null : _paste,
                icon: const Icon(Icons.content_paste_outlined, size: 17),
                label: const Text('لصق'),
              ),
              TextButton.icon(
                onPressed:
                    busy || _bulk.text.isEmpty
                        ? null
                        : () {
                          setState(_bulk.clear);
                          _saveDraft();
                        },
                icon: const Icon(Icons.close, size: 17),
                label: const Text('مسح'),
              ),
            ],
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _editor(lines.length, adds, deds, full, netted, merged, busy),
              const Caption(
                'كل سطر: رقم المستخدم، ثم النوع، ثم المبلغ، كما تُنسخ من Excel.',
              ),
              const SizedBox(height: 12),
              if (job != null && job.active)
                _jobBox(job)
              else
                ErpButton(
                  label: 'تطبيق التسويات',
                  icon: Icons.play_arrow_rounded,
                  onPressed: lines.isEmpty ? null : _run,
                ),
            ],
          ),
        ),
        if (_last != null && !busy) _lastCard(_last!),
      ],
    );
  }

  /// `.editor`: the list with its counters.
  Widget _editor(
    int n,
    int adds,
    int deds,
    int full,
    int netted,
    int merged,
    bool busy,
  ) {
    Widget cnt(String t, {bool lead = false}) => Container(
      height: 28,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: lead ? Tw.neutralSoft : Tw.surface2,
        borderRadius: BorderRadius.circular(99),
      ),
      child: Center(
        widthFactor: 1,
        child: Text(
          t,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w700,
            color: lead ? Tw.ink : Tw.ink2,
          ),
        ),
      ),
    );
    return Container(
      decoration: BoxDecoration(
        color: Tw.surface,
        borderRadius: BorderRadius.circular(22),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _bulk,
            readOnly: busy,
            minLines: 7,
            maxLines: 14,
            keyboardType: TextInputType.multiline,
            onChanged: (_) {
              setState(() {});
              _saveDraft();
            },
            style: TextStyle(fontSize: 16.5, height: 1.95, color: Tw.ink),
            decoration: InputDecoration(
              hintText: '12345   خصم   50',
              filled: true,
              fillColor: Tw.surface,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 18,
                vertical: 14,
              ),
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: OutlineInputBorder(
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(22),
                ),
                borderSide: BorderSide(color: Tw.accent, width: 1.5),
              ),
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              border: Border(top: BorderSide(color: Tw.rule)),
            ),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                cnt('$n سطر', lead: true),
                if (adds > 0) cnt('إضافة $adds'),
                if (deds > 0) cnt('خصم $deds'),
                if (full > 0) cnt('خصم كامل $full'),
                if (netted > 0) cnt('مقاصة $netted'),
                if (merged > 0) cnt('دمج $merged'),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// `آخر تطبيق`.
  Widget _lastCard(AdjustOutcome out) {
    final s = out.summary ?? AdjustmentsService.summarize(out.results);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SectionLabel(
            'آخر تطبيق',
            trailing: Text(
              '${out.results.length} عملية${out.pushed ? '، مُصدّرة إلى «${out.pushedSheet}»' : ''}',
            ),
          ),
          FigsRow(
            figs: [
              (AdjustmentsService.money(s.totalAdded), 'الإضافات', null),
              (
                AdjustmentsService.money(s.totalDeducted),
                'الخصومات المنفّذة',
                null,
              ),
              (AdjustmentsService.money(s.totalDebt), 'المبالغ المستحقة', null),
            ],
          ),
          const SizedBox(height: 8),
          ErpButton(
            label: 'عرض التقرير',
            icon: Icons.format_list_bulleted,
            kind: ErpButtonKind.outline,
            onPressed: () => _showResults(out),
          ),
        ],
      ),
    );
  }

  /// `.run-card` of the adjustments.
  Widget _jobBox(AuditJob job) {
    final waiting = job.status == AuditJob.waiting;
    final total = job.stepTotal;
    final done = job.stepNext.clamp(0, total);
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
      decoration: panelDecoration(radius: Ds.radiusL),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            waiting ? 'بانتظار الاتصال' : 'جاري تطبيق التسويات…',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w800,
              color: Tw.ink,
            ),
          ),
          const SizedBox(height: 14),
          ProgressLine(value: total > 0 ? done / total : null),
          if ((job.progress ?? '').isNotEmpty) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                if (waiting) ...[
                  Icon(Icons.wifi_off, size: 18, color: Tw.warn),
                  const SizedBox(width: 6),
                ],
                Expanded(
                  child: Text(
                    job.progress!,
                    style: TextStyle(
                      fontSize: 15,
                      color: waiting ? Tw.warn : Tw.ink,
                    ),
                  ),
                ),
              ],
            ),
          ],
          if (waiting) ...[
            const SizedBox(height: 12),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: ErpButton(
                label: 'استئناف الآن',
                icon: Icons.sync,
                kind: ErpButtonKind.indigoSoft,
                height: 40,
                expand: false,
                onPressed: () => _s.resumeAuditJobs(now: true),
              ),
            ),
          ],
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              'يمكنك إغلاق التطبيق: يكمل العمل في الخلفية، وإذا انقطع الإنترنت يُستأنف دون تكرار أي خصم أو إضافة.',
              style: Ds.caption,
            ),
          ),
        ],
      ),
    );
  }
}

/// ERP «نتائج المعالجة»: totals, debtors, the table and «نسخ»; plus the
/// owner's «دفع إلى الشيت».
class _ResultsDialog extends StatefulWidget {
  const _ResultsDialog(
    this.out, {
    required this.jobId,
    required this.spreadsheetId,
    required this.onChanged,
  });
  final AdjustOutcome out;
  final int? jobId;
  final String spreadsheetId;
  final ValueChanged<AdjustOutcome> onChanged;

  @override
  State<_ResultsDialog> createState() => _ResultsDialogState();
}

class _ResultsDialogState extends State<_ResultsDialog> {
  late AdjustOutcome out = widget.out;
  bool _pushing = false;

  /// Owner's request: the pasted lines, the results, the totals and the
  /// settled users in a new sheet «إضافات وخصومات» of the same spreadsheet.
  Future<void> _push() async {
    final services = AppScope.read(context);
    final jobId = widget.jobId;
    if (jobId == null || widget.spreadsheetId.isEmpty) return;
    setState(() => _pushing = true);
    try {
      final done = await services.adjustments.pushResults(
        widget.spreadsheetId,
        out,
        (o) => services.db.updateAuditJob(jobId, {
          'result_json': jsonEncode(o.toJson()),
        }),
      );
      if (!mounted) return;
      setState(() => out = done);
      widget.onChanged(done);
      showToast(
        context,
        'تمت الكتابة في ورقة «${done.pushedSheet}»',
        ToastType.success,
      );
    } catch (e) {
      if (mounted) {
        showToast(
          context,
          'تعذّر الدفع إلى الشيت: $e — أعد المحاولة (لن تُنشأ ورقة ثانية).',
          ToastType.error,
        );
      }
    } finally {
      if (mounted) setState(() => _pushing = false);
    }
  }

  void _open() {
    final base = out.spreadsheetUrl;
    if (base == null) return;
    launchUrl(
      Uri.parse('$base#gid=${out.pushedSheetId ?? 0}'),
      mode: LaunchMode.externalApplication,
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = out.summary ?? AdjustmentsService.summarize(out.results);
    final head = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FigsRow(
          flat: true,
          figs: [
            (AdjustmentsService.money(s.totalAdded), 'الإضافات', null),
            (
              AdjustmentsService.money(s.totalDeducted),
              'الخصومات المنفّذة',
              null,
            ),
            (AdjustmentsService.money(s.totalDebt), 'المبالغ المستحقة', null),
          ],
        ),
        if (s.debtUsers.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 12, 4, 14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.warning_amber_outlined, size: 18, color: Tw.warn),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'مستحقات على: ${s.debtUsers.join('، ')}',
                    style: TextStyle(fontSize: 14, color: Tw.warn),
                  ),
                ),
              ],
            ),
          )
        else
          const SizedBox(height: 12),
        out.pushed
            ? ErpButton(
              label: 'فتح ورقة «${out.pushedSheet}»',
              icon: Icons.open_in_new,
              kind: ErpButtonKind.outline,
              onPressed: _open,
            )
            : ErpButton(
              label: 'تصدير إلى ورقة «إضافات وخصومات»',
              icon: Icons.file_download_outlined,
              kind: ErpButtonKind.indigoSoft,
              loading: _pushing,
              loadingLabel: 'جاري التصدير…',
              onPressed: widget.jobId == null ? null : _push,
            ),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: Tw.rule)),
          ),
          child: const Row(
            children: [
              Expanded(flex: 4, child: _Head('رقم المستخدم')),
              Expanded(flex: 5, child: _Head('الحالة')),
              Expanded(flex: 3, child: _Head('المبلغ', end: true)),
            ],
          ),
        ),
      ],
    );
    return AppSheet(
      title: 'تقرير تطبيق التسويات',
      scroll: false,
      actions: [
        IconButton(
          tooltip: 'نسخ الجدول والملخص',
          onPressed: () async {
            await Clipboard.setData(
              ClipboardData(text: AdjustmentsService.copyText(out.results, s)),
            );
            if (context.mounted) {
              showToast(
                context,
                'نُسخ الجدول والملخص — الصقه في Excel.',
                ToastType.success,
              );
            }
          },
          icon: Icon(Icons.content_copy_outlined, color: Tw.ink2),
        ),
      ],
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.74,
        child: ListView.builder(
          // The results, then «خلاصة التسوية»: the netted users (like the
          // bottom of the exported sheet).
          itemCount:
              out.results.length +
              1 +
              (out.settlements.isEmpty ? 0 : out.settlements.length + 1),
          itemBuilder: (_, i) {
            if (i == 0) return head;
            final r = i - 1;
            if (r < out.results.length) return _ResultRow(out.results[r]);
            final k = r - out.results.length;
            if (k == 0) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SheetLabel('خلاصة التسوية (المقاصة)'),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      vertical: 8,
                      horizontal: 4,
                    ),
                    decoration: BoxDecoration(
                      border: Border(bottom: BorderSide(color: Tw.rule)),
                    ),
                    child: const Row(
                      children: [
                        Expanded(flex: 4, child: _Head('رقم المستخدم')),
                        Expanded(flex: 3, child: _Head('الإضافة', end: true)),
                        Expanded(flex: 3, child: _Head('الخصم', end: true)),
                        Expanded(flex: 3, child: _Head('الصافي', end: true)),
                      ],
                    ),
                  ),
                ],
              );
            }
            final x = out.settlements[k - 1];
            String n(double v) => jsNumberToString(v);
            Widget num(String t) => Expanded(
              flex: 3,
              child: Text(
                ltr(t),
                textAlign: TextAlign.left,
                textDirection: TextDirection.ltr,
                style: TextStyle(fontSize: 14.5, color: Tw.ink),
              ),
            );
            return Container(
              padding: const EdgeInsets.symmetric(vertical: 11, horizontal: 4),
              decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: Tw.rule)),
              ),
              child: Row(
                children: [
                  Expanded(
                    flex: 4,
                    child: Text(
                      x.id,
                      textDirection: TextDirection.ltr,
                      textAlign: TextAlign.right,
                      style: TextStyle(
                        fontSize: 14.5,
                        fontWeight: FontWeight.w700,
                        color: Tw.ink,
                      ),
                    ),
                  ),
                  num(n(x.added)),
                  num(n(x.deducted)),
                  num(n(x.net)),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}

class _Head extends StatelessWidget {
  const _Head(this.text, {this.end = false});
  final String text;
  final bool end;
  @override
  Widget build(BuildContext context) => Text(
    text,
    textAlign: end ? TextAlign.end : TextAlign.start,
    style: TextStyle(
      fontSize: 12.5,
      fontWeight: FontWeight.w700,
      color: Tw.ink2,
    ),
  );
}

/// `.rtable` row: id, the status pill (and the netting), the amount.
class _ResultRow extends StatelessWidget {
  const _ResultRow(this.r);
  final AdjustResult r;

  @override
  Widget build(BuildContext context) {
    final st = r.status;
    // ERP badge colours: debt amber, not found / zero salary red, else green.
    final tone =
        st.contains('باقي')
            ? Tone.warning
            : st.contains('غير موجود') ||
                st.contains('سحب ادارة') ||
                st.contains('خطأ')
            ? Tone.danger
            : Tone.success;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: Tw.rule)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 4,
            child: Text(
              r.id,
              textDirection: TextDirection.ltr,
              textAlign: TextAlign.right,
              style: TextStyle(
                fontSize: 14.5,
                fontWeight: FontWeight.w700,
                color: Tw.ink,
              ),
            ),
          ),
          Expanded(
            flex: 5,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                StatusBadge(st, tone: tone, small: true),
                if (r.settlement != null || r.merged != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 5),
                    child: Text(
                      r.merged != null
                          ? 'دمج: ${ltr(r.merged!)}'
                          : 'مقاصة: ${r.settlement}',
                      style: TextStyle(fontSize: 12, color: Tw.ink2),
                    ),
                  ),
              ],
            ),
          ),
          Expanded(
            flex: 3,
            child: Text(
              AdjustmentsService.money(r.amount),
              textAlign: TextAlign.left,
              textDirection: TextDirection.ltr,
              style: TextStyle(fontSize: 14.5, color: Tw.ink),
            ),
          ),
        ],
      ),
    );
  }
}
