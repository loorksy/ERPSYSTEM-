// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/chart.dart';
import '../../accounting/cycle_posting.dart';
import '../../accounting/money.dart';
import '../../accounting/parties.dart';
import '../../app_services.dart';
import '../../data/app_database.dart';
import '../erp_theme.dart';
import '../erp_widgets.dart';
import '../help.dart';
import '../ui_kit.dart';
import 'books_kit.dart';
import 'trading_pages.dart';

const cyclePostingHelp = [
  HelpItem(
    '',
    'ترحيل الدورة يحوّل أرقام جداولها إلى قيود في الدفاتر، فتظهر أرباحها في قائمة الدخل وأرصدتها عند الأطراف.',
  ),
  HelpItem(
    '',
    'رواتب جدول الوكيل: تدخل الصندوق، ويُسجَّل للمعتمد الذي يدفعها ما بعد خصم التحويل، والخصم ربح لنا («أرباح خصم التحويل»).',
  ),
  HelpItem(
    '',
    'جدول الإدارة: عمود W «إيرادات الإدارة»، وY+Z «أرباح التدقيق»، ويدخلان الصندوق.',
  ),
  HelpItem(
    '',
    'حصص الوكالات الفرعية: مجموع W في ورقة كل وكالة؛ نسبة الشركة لنا والباقي للوكالة، ويُخرج من «إيرادات الإدارة».',
  ),
  HelpItem(
    '',
    'كل جزء يُرحَّل مرة واحدة. «إعادة الترحيل» تلغي القيد السابق بقيد عكسي ثم تسجّل الجديد، فلا يتكرر شيء. (نظام الويب كان يرحّل بعض الأرباح إلى الصندوق دون الدفتر، وبعضها مرتين.)',
  ),
];

class CyclePostingPage extends StatefulWidget {
  const CyclePostingPage({super.key, required this.cycleId});
  final int cycleId;
  @override
  State<CyclePostingPage> createState() => _CyclePostingPageState();
}

typedef _Data =
    ({
      CycleFigures f,
      JournalEntry? agent,
      JournalEntry? mgmt,
      List<Party> agencies,
      Map<int, JournalEntry?> shares,
    });

class _CyclePostingPageState extends State<CyclePostingPage> {
  final _salaries = TextEditingController();
  final _discount = TextEditingController();
  final _w = TextEditingController();
  final _yz = TextEditingController();
  final _bases = <int, TextEditingController>{};
  Account? _fund;
  Account? _acc;
  bool _filled = false;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_salaries, _discount, _w, _yz, ..._bases.values]) {
      c.dispose();
    }
    super.dispose();
  }

  String _num(int c) => c == 0 ? '' : formatCentsShort(c).replaceAll(',', '');

  TextEditingController _base(int id) =>
      _bases.putIfAbsent(id, TextEditingController.new);

  void _fill(_Data d) {
    if (_filled) return;
    _filled = true;
    _salaries.text = _num(
      (d.agent?.meta['salaries'] as num?)?.toInt() ?? d.f.agentSalaries,
    );
    _discount.text = _num(
      (d.agent?.meta['discount'] as num?)?.toInt() ?? d.f.discount,
    );
    _w.text = _num((d.mgmt?.meta['w'] as num?)?.toInt() ?? d.f.mgmtW);
    _yz.text = _num((d.mgmt?.meta['yz'] as num?)?.toInt() ?? d.f.mgmtYZ);
    for (final p in d.agencies) {
      final e = d.shares[p.account.id];
      if (e != null) {
        _base(p.account.id).text = _num((e.meta['base'] as num?)?.toInt() ?? 0);
      }
    }
  }

  Future<void> _run(
    Future<void> Function(AppServices s) op,
    String done,
  ) async {
    setState(() => _busy = true);
    await runPosting(context, op, done: done);
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _readGoogle(CycleFigures f, List<Party> agencies) async {
    setState(() => _busy = true);
    final s = AppScope.read(context);
    try {
      final totals = await CyclePosting.agencyTotals(f.cycle, s.sheets);
      var created = 0;
      for (final e in totals.entries) {
        var p = agencies.where((a) => a.name.trim() == e.key).firstOrNull;
        if (p == null) {
          p = await s.parties.add(
            PartyKind.subAgency,
            e.key,
            note: 'أُضيفت من جدول الإدارة — عدّل نسبة الشركة',
          );
          created++;
        }
        _base(p.account.id).text = _num(e.value);
      }
      if (created > 0) s.booksChanged();
      if (mounted) {
        showToast(
          context,
          'قُرئت ${totals.length} ورقة وكالة${created > 0 ? '، وأُضيفت $created وكالة بنسبة 0٪ (عدّلها قبل الترحيل)' : ''}',
          ToastType.success,
        );
      }
    } catch (e) {
      if (mounted) showToast(context, '$e', ToastType.error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _postedBadge(JournalEntry? e) =>
      e == null
          ? const StatusBadge('لم يُرحَّل', small: true)
          : StatusBadge(
            'مُرحَّل #${e.number}',
            tone: Tone.success,
            icon: Icons.check,
            small: true,
          );

  Widget _amount(String label, TextEditingController c) => FormRow(
    label,
    SizedBox(
      width: 140,
      child: ErpTextField(
        controller: c,
        hint: '0',
        ltr: true,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'ترحيل الدورة',
    help: cyclePostingHelp,
    load: (s) async {
      final p = s.cyclePosting;
      final f = await p.figures(widget.cycleId);
      final agencies = await s.parties.list(PartyKind.subAgency);
      final agentEntry = await p.posted(widget.cycleId, CyclePart.agent);
      final accId = (agentEntry?.meta['accreditation'] as num?)?.toInt();
      if (_acc == null && accId != null) _acc = await s.ledger.account(accId);
      final fundId = (agentEntry?.meta['fund'] as num?)?.toInt();
      if (_fund == null && fundId != null) {
        _fund = await s.ledger.account(fundId);
      }
      _fund ??= await s.ledger.byRole(Roles.mainFund);
      return (
        f: f,
        agent: await p.posted(widget.cycleId, CyclePart.agent),
        mgmt: await p.posted(widget.cycleId, CyclePart.management),
        agencies: agencies,
        shares: {
          for (final a in agencies)
            a.account.id: await p.posted(
              widget.cycleId,
              CyclePart.share(a.account.id),
            ),
        },
      );
    },
    build: (context, data, reload) {
      final d = data as _Data;
      _fill(d);
      final c = d.f.cycle;
      return [
        Container(
          padding: const EdgeInsets.all(18),
          decoration: panelDecoration(radius: Ds.radiusL),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                d.f.name,
                style: Ds.body.copyWith(
                  fontSize: 18,
                  fontWeight: FontWeight.w800,
                ),
              ),
              Text(
                d.f.hasData
                    ? 'خصم التحويل ${c.transferDiscountPct.toString().replaceAll(RegExp(r'\.0$'), '')}٪ · ${c.agentCount} صف وكيل · ${c.managementCount} صف إدارة'
                    : 'لا جداول محفوظة لهذه الدورة: زامنها أو دقّقها، أو اكتب المبالغ يدويًا.',
                style: Ds.secondary,
              ),
            ],
          ),
        ),
        gap,
        FormRows(
          onSurface: false,
          children: [
            FormRow(
              'يُقبض في',
              PickerValue(
                text: _fund?.name ?? 'اختر الصندوق',
                placeholder: _fund == null,
                onTap: () async {
                  final a = await pickFund(context, selectedId: _fund?.id);
                  if (a != null) setState(() => _fund = a);
                },
              ),
            ),
          ],
        ),
        gap,
        SectionLabel('رواتب جدول الوكيل', trailing: _postedBadge(d.agent)),
        FormRows(
          onSurface: false,
          children: [
            _amount('مجموع الرواتب', _salaries),
            _amount('خصم التحويل', _discount),
            FormRow(
              'المعتمد الدافع',
              PickerValue(
                text: _acc?.name ?? 'اختر المعتمد',
                placeholder: _acc == null,
                onTap: () async {
                  final a = await pickPartyAccount(
                    context,
                    title: 'المعتمد',
                    kinds: {PartyKind.accreditation},
                    selectedId: _acc?.id,
                  );
                  if (a != null) setState(() => _acc = a);
                },
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ErpButton(
          label: d.agent == null ? 'ترحيل الرواتب' : 'إعادة ترحيل الرواتب',
          icon: Icons.menu_book_outlined,
          kind: ErpButtonKind.indigoSoft,
          loading: _busy,
          onPressed: () {
            if (_fund == null || _acc == null) {
              showToast(context, 'اختر الصندوق والمعتمد', ToastType.warning);
              return;
            }
            _run(
              (s) => s.cyclePosting.postAgent(
                widget.cycleId,
                receivedInId: _fund!.id,
                accreditationId: _acc!.id,
                salaries: parseCents(_salaries.text) ?? 0,
                discount: parseCents(_discount.text) ?? 0,
              ),
              'رُحّلت الرواتب',
            );
          },
        ),
        gap,
        SectionLabel('جدول الإدارة', trailing: _postedBadge(d.mgmt)),
        FormRows(
          onSurface: false,
          children: [_amount('عمود W', _w), _amount('Y + Z', _yz)],
        ),
        const SizedBox(height: 8),
        ErpButton(
          label:
              d.mgmt == null
                  ? 'ترحيل جدول الإدارة'
                  : 'إعادة ترحيل جدول الإدارة',
          icon: Icons.menu_book_outlined,
          kind: ErpButtonKind.indigoSoft,
          loading: _busy,
          onPressed: () {
            if (_fund == null) {
              showToast(context, 'اختر الصندوق', ToastType.warning);
              return;
            }
            _run(
              (s) => s.cyclePosting.postManagement(
                widget.cycleId,
                receivedInId: _fund!.id,
                w: parseCents(_w.text) ?? 0,
                yz: parseCents(_yz.text) ?? 0,
              ),
              'رُحّل جدول الإدارة',
            );
          },
        ),
        gap,
        SectionLabel(
          'حصص الوكالات الفرعية',
          trailing:
              c.managementSpreadsheetId == null
                  ? null
                  : TextButton.icon(
                    onPressed:
                        _busy ? null : () => _readGoogle(d.f, d.agencies),
                    icon: const Icon(Icons.cloud_download_outlined, size: 17),
                    label: const Text('من Google'),
                  ),
        ),
        if (d.agencies.isEmpty)
          const Caption(
            'لا وكالات فرعية بعد. أضفها من العمليات ← الوكالات الفرعية، أو اقرأها من جدول الإدارة في Google.',
          )
        else
          FormRows(
            onSurface: false,
            children: [
              for (final p in d.agencies)
                FormRow(
                  '${p.name} (${formatPercent(p.percentBp)}٪)${d.shares[p.account.id] == null ? '' : ' ✓'}',
                  SizedBox(
                    width: 130,
                    child: ErpTextField(
                      controller: _base(p.account.id),
                      hint: 'W',
                      ltr: true,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        if (d.agencies.isNotEmpty) ...[
          const SizedBox(height: 8),
          ErpButton(
            label: 'ترحيل الحصص',
            icon: Icons.menu_book_outlined,
            kind: ErpButtonKind.indigoSoft,
            loading: _busy,
            onPressed:
                () => _run(
                  (s) => s.cyclePosting.postShares(widget.cycleId, {
                    for (final p in d.agencies)
                      if ((parseCents(_base(p.account.id).text) ?? 0) > 0)
                        p.account.id: parseCents(_base(p.account.id).text)!,
                  }),
                  'رُحّلت الحصص',
                ),
          ),
        ],
        const Caption(
          'الأرقام مقترحة من جداول الدورة ويمكن تعديلها قبل الترحيل. إعادة الترحيل تلغي القيد السابق بقيد عكسي.',
        ),
      ];
    },
  );
}

/// The cycles with what of each is posted (for the operations hub).
class CyclesPostingList extends StatelessWidget {
  const CyclesPostingList({super.key});

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'ترحيل الدورات',
    help: cyclePostingHelp,
    load: (s) async {
      final cycles = await s.db.listCycles();
      return [
        for (final c in cycles)
          (
            cycle: c,
            agent: await s.cyclePosting.posted(c.id, CyclePart.agent) != null,
            mgmt:
                await s.cyclePosting.posted(c.id, CyclePart.management) != null,
          ),
      ];
    },
    build: (context, data, reload) {
      final list = data as List<({Cycle cycle, bool agent, bool mgmt})>;
      if (list.isEmpty) {
        return const [
          EmptyState(
            icon: Icons.calendar_today_outlined,
            title: 'لا دورات مالية',
            message: 'أنشئ دورة من تبويب «الدورات» أولًا.',
          ),
        ];
      }
      return [
        GroupList(
          children: [
            for (final x in list)
              ListRow(
                title:
                    x.cycle.name.isEmpty ? 'دورة #${x.cycle.id}' : x.cycle.name,
                leading: IconChip(
                  Icons.calendar_today_outlined,
                  color: Tw.accentInk,
                  bg: Tw.accentSoft,
                ),
                subtitle: Text(
                  x.agent && x.mgmt
                      ? 'مُرحّلة'
                      : x.agent || x.mgmt
                      ? 'مُرحّلة جزئيًا'
                      : 'لم تُرحَّل',
                ),
                trailing: const RowChevron(),
                onTap:
                    () => openPage(
                      context,
                      CyclePostingPage(cycleId: x.cycle.id),
                    ),
              ),
          ],
        ),
      ];
    },
  );
}
