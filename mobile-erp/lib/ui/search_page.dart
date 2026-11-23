// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'dart:async';
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';

import '../app_services.dart';
import '../data/app_database.dart';
import '../erp/js_compat.dart';
import '../erp/payroll_audit_engine.dart';
import '../services/search_service.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';
import 'help.dart';
import 'shell.dart';
import 'ui_kit.dart';

/// ERP «البحث والتدقيق» page (`views/partials/search.ejs`).
class SearchPage extends StatefulWidget {
  const SearchPage({super.key, required this.active});
  final bool active;
  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends State<SearchPage> {
  int _revision = -1;
  List<Cycle> _cycles = const [];
  String _cycleId = '';
  final _userId = TextEditingController();
  final _discount = TextEditingController();
  final _newSheet = TextEditingController();
  bool _global = false;
  Timer? _debounce;

  SearchOutcome? _outcome;
  bool _global0 = false;
  final _cardKey = GlobalKey();

  // Selective audit
  bool _auditOpen = false;
  String _auditMemberId = '';
  String _auditLogical = '';
  List<String> _targetSheets = const [];
  String? _targetMessage;
  String _targetSheet = '';
  String _agentColor = defaultAgentColor;
  String _mgmtColor = defaultManagementColor;
  bool _executing = false;

  AppServices get _s => AppScope.read(context);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final services = AppScope.of(context);
    if (services.cyclesRevision != _revision) {
      _revision = services.cyclesRevision;
      _loadCycles();
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _userId.dispose();
    _discount.dispose();
    _newSheet.dispose();
    super.dispose();
  }

  Future<void> _loadCycles() async {
    final list = await _s.db.listCycles();
    if (!mounted) return;
    setState(() {
      _cycles = list;
      if (!list.any((c) => '${c.id}' == _cycleId)) {
        _cycleId = list.isEmpty ? '' : '${list.first.id}';
      }
    });
  }

  void _debounced() {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), _runSearch);
  }

  Future<void> _paste() async {
    final t = await pasteText();
    if (t == null || t.isEmpty) return;
    _userId.text = t;
    _debounced();
  }

  Future<void> _runSearch() async {
    final userId = _userId.text.trim();
    final rate = jsParseFloat(_discount.text.trim());
    final discount = rate.isNaN ? 0.0 : rate;
    if ((_cycleId.isEmpty && !_global) || userId.isEmpty) return;
    final outcome =
        _global
            ? await _s.search.searchAcrossCycles(userId, discount)
            : await _s.search.searchUser(int.parse(_cycleId), userId, discount);
    if (!mounted) return;
    setState(() {
      _outcome = outcome;
      _global0 = _global;
      _auditOpen = false;
    });
    if (!outcome.success) {
      final msg = outcome.message!;
      showToast(
        context,
        msg,
        msg.contains('غير موجود') ? ToastType.info : ToastType.error,
      );
      return;
    }
    if (!_global && outcome.hits.isNotEmpty && outcome.hits.first.canAudit) {
      _openAudit(outcome.hits.first.memberId, outcome.hits.first.logicalStatus);
    }
    showToast(context, 'تم جلب نتيجة البحث', ToastType.success);
  }

  Future<void> _openAudit(String memberId, String logical) async {
    setState(() {
      _auditOpen = true;
      _auditMemberId = memberId;
      _auditLogical = logical;
      _agentColor = defaultAgentColor;
      _mgmtColor = defaultManagementColor;
      _targetSheet = '';
      _newSheet.clear();
      _targetSheets = const [];
      _targetMessage = '— جاري جلب الأوراق —';
    });
    await _loadTargetSheets();
  }

  /// The sheets of the cycle's management spreadsheet (also «تحديث القوائم»).
  Future<void> _loadTargetSheets() async {
    if (_cycleId.isEmpty) return;
    try {
      final sheets = await _s.search.cycleSheets(int.parse(_cycleId));
      if (!mounted) return;
      setState(() {
        _targetSheets = sheets;
        _targetMessage =
            sheets.isEmpty ? 'لا توجد أوراق في جدول الإدارة لهذه الدورة' : null;
      });
    } catch (e) {
      if (mounted) setState(() => _targetMessage = e.toString());
    }
  }

  Future<void> _execute() async {
    if (_cycleId.isEmpty) {
      showToast(
        context,
        'اختر الدورة التي تريد تدقيق المستخدم فيها',
        ToastType.error,
      );
      return;
    }
    final newTitle = _newSheet.text.trim();
    final target = newTitle.isNotEmpty ? newTitle : _targetSheet;
    if (target.isEmpty) {
      showToast(
        context,
        'اختر ورقة هدف أو اكتب اسماً لورقة جديدة',
        ToastType.error,
      );
      return;
    }
    setState(() => _executing = true);
    final r = await _s.search.executeIndividual(
      cycleId: int.parse(_cycleId),
      memberIdRaw: _auditMemberId,
      targetSheetTitle: target,
      createIfMissing: newTitle.isNotEmpty,
      agentColor: _agentColor,
      managementColor: _mgmtColor,
    );
    if (!mounted) return;
    setState(() => _executing = false);
    showToast(
      context,
      r.message,
      r.success ? ToastType.success : ToastType.error,
    );
    if (r.success) {
      setState(() => _auditOpen = false);
      _s.cyclesChanged();
      _debounced();
    }
  }

  String _cardText() {
    final o = _outcome;
    if (o == null || !o.success) return o?.message ?? '';
    final b = StringBuffer();
    final first = o.hits.first;
    b.writeln('رقم المستخدم: ${first.memberId}');
    final name = o.hits
        .map((h) => h.name)
        .firstWhere((n) => n != null && n.isNotEmpty, orElse: () => null);
    if (name != null) b.writeln('الاسم: $name');
    for (final h in o.hits) {
      if (_global0) b.writeln('— الدورة: ${h.cycleName}');
      b.writeln('التصنيف: ${h.logicalStatus}');
      b.writeln('الراتب قبل الخصم: ${jsNumberToString(h.salaryBefore)}');
      b.writeln('الراتب بعد الخصم: ${jsNumberToString(h.salaryAfter)}');
      b.writeln(
        'حالة التدقيق: ${h.auditStatus}${h.auditSource != null ? ' — ${h.auditSource}' : ''}',
      );
    }
    return b.toString().trim();
  }

  Future<void> _copyCard() async {
    final text = _cardText();
    if (text.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) {
      showToast(context, 'تم نسخ النتائج كبطاقة نصية', ToastType.success);
    }
  }

  Future<void> _downloadImage() async {
    try {
      final boundary =
          _cardKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
      if (boundary == null) return;
      final image = await boundary.toImage(pixelRatio: 3);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) return;
      final saved = await FilePicker.platform.saveFile(
        dialogTitle: 'حفظ البطاقة كصورة',
        fileName: 'بطاقة-${_userId.text.trim()}.png',
        type: FileType.image,
        bytes: data.buffer.asUint8List(),
      );
      if (saved != null && mounted) {
        showToast(context, 'تم حفظ الصورة', ToastType.success);
      }
    } catch (_) {
      if (mounted) showToast(context, 'تعذر حفظ الصورة', ToastType.error);
    }
  }

  // ------------------------------------------------------------------ UI
  //
  // Owner's mockup (`screenSearch`): the search box first, the scope and
  // the % on one line, the period, then the member card. The selective
  // audit opens from the card in a sheet.

  /// The colours of the classification key (the saved audit colours).
  Color _keyAgent = hexColor(defaultAgentColor);
  Color _keyMgmt = hexColor(defaultManagementColor);
  bool _keysLoaded = false;

  Future<void> _loadKeys() async {
    _keysLoaded = true;
    final s = await _s.db.getPayrollSettings();
    if (!mounted) return;
    setState(() {
      _keyAgent = hexColor(s.agentColor);
      _keyMgmt = hexColor(s.managementColor);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!_keysLoaded) _loadKeys();
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        ScreenHeader(title: 'الاستعلام', help: () => inquiryHelp),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 18),
              _searchBox(),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: SegmentedChoice(
                      options: const ['هذه الدورة', 'كل الدورات'],
                      selected: _global ? 1 : 0,
                      onChanged: (i) {
                        setState(() => _global = i == 1);
                        _debounced();
                      },
                    ),
                  ),
                  const SizedBox(width: 8),
                  _percentBox(),
                ],
              ),
              if (!_global) ...[
                const SizedBox(height: 8),
                ErpSelect<String>(
                  thick: true,
                  options:
                      _cycles.isEmpty
                          ? const [SelectOption('', '— لا توجد دورات —')]
                          : [
                            const SelectOption('', '— اختر الدورة —'),
                            for (final c in _cycles)
                              SelectOption(
                                '${c.id}',
                                c.name.isEmpty ? 'دورة #${c.id}' : c.name,
                              ),
                          ],
                  value: _cycleId,
                  onChanged: (v) {
                    setState(() => _cycleId = v);
                    _debounced();
                  },
                ),
              ],
              if (_outcome != null)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: _resultCard(),
                )
              else
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 52, 20, 0),
                  child: Column(
                    children: [
                      Container(
                        width: 64,
                        height: 64,
                        decoration: BoxDecoration(
                          color: Tw.surface,
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Icon(Icons.search, size: 30, color: Tw.ink3),
                      ),
                      const SizedBox(height: 14),
                      Text(
                        'أدخل رقم المستخدم للاستعلام عن حالته وراتبه.',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 15, color: Tw.ink2),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  /// `.searchbox`.
  Widget _searchBox() {
    final r = BorderRadius.circular(20);
    return SizedBox(
      height: 60,
      child: TextField(
        controller: _userId,
        keyboardType: TextInputType.number,
        onChanged: (_) => _debounced(),
        style: TextStyle(
          fontSize: 20,
          fontWeight: FontWeight.w700,
          color: Tw.ink,
        ),
        decoration: InputDecoration(
          hintText: 'رقم المستخدم',
          hintStyle: TextStyle(
            fontSize: 17,
            fontWeight: FontWeight.w500,
            color: Tw.ink3,
          ),
          filled: true,
          fillColor: Tw.surface,
          contentPadding: const EdgeInsets.symmetric(vertical: 18),
          prefixIcon: Icon(Icons.search, size: 22, color: Tw.ink3),
          suffixIcon: IconButton(
            tooltip: 'لصق',
            onPressed: _paste,
            icon: Icon(Icons.content_paste_outlined, size: 20, color: Tw.ink2),
          ),
          border: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide.none,
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide.none,
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide(color: Tw.accent, width: 1.5),
          ),
        ),
      ),
    );
  }

  /// `.mini-input`: the discount applied to the shown salary.
  Widget _percentBox() {
    final r = BorderRadius.circular(13);
    return SizedBox(
      width: 96,
      height: 46,
      child: TextField(
        controller: _discount,
        textDirection: TextDirection.ltr,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        onChanged: (_) => _debounced(),
        style: TextStyle(
          fontSize: 16,
          fontWeight: FontWeight.w700,
          color: Tw.ink,
        ),
        decoration: InputDecoration(
          hintText: '0',
          filled: true,
          fillColor: Tw.surface,
          contentPadding: const EdgeInsets.symmetric(vertical: 12),
          prefixIcon: Icon(Icons.percent, size: 16, color: Tw.ink3),
          prefixIconConstraints: const BoxConstraints(minWidth: 34),
          border: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide.none,
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide.none,
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide(color: Tw.accent, width: 1.5),
          ),
        ),
      ),
    );
  }

  Widget _resultCard() {
    final o = _outcome!;
    if (!o.success) {
      // `.s-msg`.
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: Tw.warnSoft,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.info_outline, size: 20, color: Tw.warn),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                o.message!,
                style: TextStyle(fontSize: 14.5, height: 1.65, color: Tw.warn),
              ),
            ),
          ],
        ),
      );
    }
    // `.rcard`.
    return Container(
      decoration: panelDecoration(radius: Ds.radiusL),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          RepaintBoundary(
            key: _cardKey,
            child: Container(
              color: Tw.surface,
              padding: const EdgeInsets.fromLTRB(18, 18, 18, 4),
              child: _resultBody(o),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                TextButton.icon(
                  onPressed: _copyCard,
                  icon: const Icon(Icons.content_copy_outlined, size: 17),
                  label: const Text('نسخ كبطاقة'),
                ),
                const SizedBox(width: 2),
                TextButton.icon(
                  onPressed: _downloadImage,
                  icon: const Icon(Icons.image_outlined, size: 17),
                  label: const Text('حفظ كصورة'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _kv(String label, Widget value) => ConstrainedBox(
    constraints: const BoxConstraints(minHeight: 42),
    child: Row(
      children: [
        Expanded(
          child: Text(label, style: TextStyle(fontSize: 15, color: Tw.ink2)),
        ),
        value,
      ],
    ),
  );

  Widget _num(double v) => Text(
    jsNumberToString(v),
    textDirection: TextDirection.ltr,
    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Tw.ink),
  );

  Widget _auditBadge(CycleSearchHit h) => StatusBadge(
    h.auditStatus == 'مدقق' ? 'مدقق' : h.auditStatus,
    tone: h.auditStatus == 'مدقق' ? Tone.success : Tone.warning,
    icon: h.auditStatus == 'مدقق' ? Icons.check : Icons.schedule,
  );

  /// `.cls`: the classification with the key of its colour.
  Widget _classification(CycleSearchHit h) {
    final t = h.logicalStatus;
    final Color? key =
        t.startsWith(statusAgent)
            ? _keyAgent
            : t.startsWith(statusManagement)
            ? _keyMgmt
            : null;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        ColorKey(key),
        const SizedBox(width: 7),
        Text(
          t,
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w700,
            color: Tw.ink,
          ),
        ),
      ],
    );
  }

  Widget _hitDetails(CycleSearchHit h, {required VoidCallback? onAudit}) =>
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _kv('التصنيف', _classification(h)),
          _kv('الراتب قبل الخصم', _num(h.salaryBefore)),
          _kv('الراتب بعد الخصم', _num(h.salaryAfter)),
          _kv('حالة التدقيق', _auditBadge(h)),
          if (h.auditSource != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(
                h.auditSource!,
                textAlign: TextAlign.end,
                style: TextStyle(fontSize: 12.5, color: Tw.ink3),
              ),
            ),
          if (h.canAudit && onAudit != null)
            Padding(
              padding: const EdgeInsets.only(top: 8, bottom: 8),
              child: ErpButton(
                label: 'تدقيق انتقائي',
                kind: ErpButtonKind.indigoSoft,
                height: 40,
                onPressed: onAudit,
              ),
            ),
        ],
      );

  Widget _resultBody(SearchOutcome o) {
    final first = o.hits.first;
    final name = o.hits
        .map((h) => h.name)
        .firstWhere((n) => n != null && n.isNotEmpty, orElse: () => null);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: Tw.rule)),
          ),
          child: Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: Tw.accentSoft,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.person_outline,
                  size: 22,
                  color: Tw.accentInk,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      first.memberId,
                      textDirection: TextDirection.ltr,
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w800,
                        height: 1.3,
                        color: Tw.ink,
                      ),
                    ),
                    if (name != null)
                      Text(
                        name,
                        maxLines: 1,
                        style: TextStyle(fontSize: 14, color: Tw.ink2),
                      ),
                  ],
                ),
              ),
              if (_global0) StatusBadge('${o.hits.length} دورة'),
            ],
          ),
        ),
        if (!_global0)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: _hitDetails(
              first,
              onAudit:
                  () => _openSelective(first.memberId, first.logicalStatus),
            ),
          )
        else
          for (final h in o.hits)
            Container(
              padding: const EdgeInsets.only(top: 10, bottom: 4),
              decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: Tw.rule)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    h.cycleName,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: Tw.ink,
                    ),
                  ),
                  _hitDetails(
                    h,
                    onAudit: () {
                      setState(() => _cycleId = '${h.cycleId}');
                      _openSelective(h.memberId, h.logicalStatus);
                    },
                  ),
                ],
              ),
            ),
      ],
    );
  }

  /// `selSheet`: the selective audit of one member.
  Future<void> _openSelective(String memberId, String logical) async {
    if (!_auditOpen || _auditMemberId != memberId) {
      _openAudit(memberId, logical);
    }
    final cycle = _cycles.where((c) => '${c.id}' == _cycleId).firstOrNull;
    await showAppSheet<void>(
      context,
      (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) {
          // Follow the page (target sheets loading, running state).
          void both(VoidCallback f) {
            setState(f);
            setLocal(() {});
          }

          final isAgent = _auditLogical.startsWith(statusAgent);
          final isMgmt = _auditLogical.startsWith(statusManagement);
          final showAgent = isAgent || !isMgmt;
          final showMgmt = isMgmt || !isAgent;
          return AppSheet(
            title: 'التدقيق الانتقائي',
            actions: [
              RefreshAction(
                onRefresh: () async {
                  await _loadTargetSheets();
                  setLocal(() {});
                },
              ),
            ],
            footer: ErpButton(
              label: 'تنفيذ التدقيق الانتقائي',
              loading: _executing,
              loadingLabel: 'جاري التنفيذ…',
              onPressed: () async {
                // `_execute` marks itself running before its first await.
                final run = _execute();
                setLocal(() {});
                await run;
                if (!mounted) return;
                if (!_auditOpen && ctx.mounted) {
                  Navigator.pop(ctx);
                } else {
                  setLocal(() {});
                }
              },
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'للمستخدم ${ltr(memberId)} في «${cycle == null ? '' : (cycle.name.isEmpty ? 'دورة #${cycle.id}' : cycle.name)}». اختر ورقة في جدول الإدارة، أو اكتب اسمًا لإنشاء ورقة جديدة. يُلحق صف الإدارة بها ويُلوَّن.',
                  style: TextStyle(fontSize: 14.5, height: 1.7, color: Tw.ink2),
                ),
                const SizedBox(height: 14),
                FormRows(
                  children: [
                    FormRow(
                      'ورقة الهدف في جدول الإدارة',
                      _TargetSelect(
                        page: this,
                        onChanged: (v) => both(() => _targetSheet = v),
                        tick: setLocal,
                      ),
                      block: true,
                    ),
                    FormRow(
                      'اسم ورقة جديدة (اختياري)',
                      ErpTextField(
                        controller: _newSheet,
                        thick: true,
                        hint: 'مثال: وكالة جديدة',
                      ),
                      block: true,
                    ),
                    if (showAgent)
                      FormRow(
                        'لون سحب الوكيل',
                        ColorSwatchButton(
                          value: _agentColor,
                          onChanged: (v) => both(() => _agentColor = v),
                        ),
                      ),
                    if (showMgmt)
                      FormRow(
                        'لون سحب الإدارة',
                        ColorSwatchButton(
                          value: _mgmtColor,
                          onChanged: (v) => both(() => _mgmtColor = v),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// The target sheet of the selective audit; rebuilds when the sheets of
/// the period arrive.
class _TargetSelect extends StatefulWidget {
  const _TargetSelect({
    required this.page,
    required this.onChanged,
    required this.tick,
  });
  final _SearchPageState page;
  final ValueChanged<String> onChanged;
  final StateSetter tick;
  @override
  State<_TargetSelect> createState() => _TargetSelectState();
}

class _TargetSelectState extends State<_TargetSelect> {
  Timer? _t;

  @override
  void initState() {
    super.initState();
    // The list loads in the background: refresh until it is there.
    _t = Timer.periodic(const Duration(milliseconds: 400), (_) {
      if (!mounted) return;
      setState(() {});
      if (widget.page._targetMessage == null ||
          !widget.page._targetMessage!.contains('جاري')) {
        _t?.cancel();
      }
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.page;
    return ErpSelect<String>(
      muted: true,
      options: [
        SelectOption('', p._targetMessage ?? '— اختر ورقة أو أنشئ جديدة —'),
        for (final s in p._targetSheets) SelectOption(s, s),
      ],
      value: p._targetSheet,
      onChanged: widget.onChanged,
    );
  }
}
