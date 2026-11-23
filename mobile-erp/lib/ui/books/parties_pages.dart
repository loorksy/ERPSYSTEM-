// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/chart.dart';
import '../../accounting/ledger.dart';
import '../../accounting/money.dart';
import '../../accounting/parties.dart';
import '../../app_services.dart';
import '../erp_theme.dart';
import '../erp_widgets.dart';
import '../help.dart';
import '../ui_kit.dart';
import 'books_kit.dart';
import 'accounts_page.dart';
import 'funds_page.dart';

IconData partyIcon(PartyKind k) => switch (k) {
  PartyKind.accreditation => Icons.verified_user_outlined,
  PartyKind.transferCompany => Icons.account_balance_outlined,
  PartyKind.subAgency => Icons.groups_outlined,
  PartyKind.carrier => Icons.local_shipping_outlined,
  PartyKind.member => Icons.person_outline,
  PartyKind.customer => Icons.person_outline,
  PartyKind.supplier => Icons.storefront_outlined,
};

/// «لنا 1,200.00» / «علينا 300.00» / «مسدَّد».
String balanceLabel(int b) =>
    b > 0
        ? 'لنا ${formatCents(b)}'
        : b < 0
        ? 'علينا ${formatCents(-b)}'
        : 'مسدَّد';

/// The balance of a party, green when owed to us, red when we owe.
class PartyBalance extends StatelessWidget {
  const PartyBalance(this.balance, {super.key, this.size = 15});
  final int balance;
  final double size;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.end,
    mainAxisSize: MainAxisSize.min,
    children: [
      Money(
        balance.abs(),
        size: size,
        color: balance > 0 ? Tw.accentInk : (balance < 0 ? Tw.danger : Tw.ink3),
      ),
      Text(
        balance > 0 ? 'لنا' : (balance < 0 ? 'علينا' : 'مسدَّد'),
        style: Ds.secondary.copyWith(fontSize: 12),
      ),
    ],
  );
}

List<HelpItem> partiesHelp(PartyKind k) => [
  HelpItem(
    '',
    'لكل ${k.label} حساب جارٍ واحد في شجرة الحسابات تحت «${k.plural}». الرصيد المدين «لنا» (هو مدين لنا)، والدائن «علينا» (نحن مدينون له).',
  ),
  const HelpItem(
    '',
    'كل عملية قيد متوازن: «دين لنا» و«دين علينا» يطلبان الحساب المقابل (الصندوق الذي دُفع منه أو قُبض فيه، أو إيراد، أو طرف آخر)، فلا يتغير رصيد من لا شيء.',
  ),
  const HelpItem(
    '',
    'الدين لنا والدين علينا للطرف نفسه يتقاصّان تلقائيًا في حسابه؛ الرصيد الظاهر هو الصافي.',
  ),
  if (k == PartyKind.accreditation)
    const HelpItem(
      '',
      '«راتب مع وساطة»: يدخل المبلغ كاملًا إلى الصندوق، ونسبة الوساطة إيراد لنا، والباقي دين علينا للمعتمد.',
    ),
  if (k == PartyKind.subAgency)
    const HelpItem(
      '',
      '«حصة دورة»: أرباح الوكالة من عمود W في الدورة؛ نسبة الشركة إيراد لنا («أرباح الوكالات الفرعية») والباقي للوكالة. «مكافأة» مصروف لنا، تُدفع الآن من صندوق أو تبقى في حساب الوكالة.',
    ),
];

// ------------------------------------------------------------------ list

class PartiesPage extends StatefulWidget {
  const PartiesPage({super.key, required this.kind});
  final PartyKind kind;
  @override
  State<PartiesPage> createState() => _PartiesPageState();
}

class _PartiesPageState extends State<PartiesPage> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final k = widget.kind;
    return BooksPage(
      title: k.plural,
      help: partiesHelp(k),
      load: (s) => s.parties.list(k),
      fab:
          (context, _) => FloatingActionButton.extended(
            heroTag: 'party',
            onPressed: () => showNewPartySheet(context, k),
            icon: const Icon(Icons.add),
            label: Text('${k.label} جديد'),
          ),
      build: (context, data, reload) {
        final all = data as List<Party>;
        final toUs = all.fold(0, (n, p) => n + p.toUs);
        final toThem = all.fold(0, (n, p) => n + p.toThem);
        final q = _q.trim();
        final shown = [
          for (final p in all)
            if (q.isEmpty || p.name.contains(q) || p.code.contains(q)) p,
        ];
        return [
          FigsRow(
            figs: [
              (formatCentsShort(toUs), 'لنا', Tw.accentInk),
              (
                formatCentsShort(toThem),
                'علينا',
                toThem > 0 ? Tw.danger : null,
              ),
              (formatCentsShort(toUs - toThem), 'الصافي', null),
            ],
          ),
          gap,
          if (all.length > 6) ...[
            SheetSearch(
              hint: 'ابحث بالاسم أو الرمز',
              onChanged: (v) => setState(() => _q = v),
            ),
            gap,
          ],
          SectionLabel(
            '${all.length} ${k.label}',
            trailing: TextButton.icon(
              onPressed: () => showImportSheet(context, k),
              icon: const Icon(Icons.upload_outlined, size: 17),
              label: const Text('رفع أرصدة'),
            ),
          ),
          if (shown.isEmpty)
            EmptyState(
              icon: partyIcon(k),
              title: all.isEmpty ? 'لا ${k.plural} بعد' : 'لا نتائج',
              message:
                  all.isEmpty
                      ? 'أضف أول ${k.label} من الزر في الأسفل، أو ارفع الأرصدة دفعة واحدة.'
                      : 'جرّب اسمًا آخر.',
            )
          else
            GroupList(
              children: [
                for (final p in shown)
                  ListRow(
                    title: p.name,
                    leading: IconChip(
                      partyIcon(k),
                      color: Tw.accentInk,
                      bg: Tw.accentSoft,
                    ),
                    subtitle: Text(
                      [
                        if (p.pinned) 'مثبّت',
                        if (p.code.isNotEmpty) p.code,
                        if (p.percentBp > 0) '${formatPercent(p.percentBp)}٪',
                        p.account.code,
                      ].join(' · '),
                    ),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [PartyBalance(p.balance), const RowChevron()],
                    ),
                    onTap:
                        () => openPage(
                          context,
                          PartyPage(accountId: p.account.id),
                        ),
                  ),
              ],
            ),
        ];
      },
    );
  }
}

// ---------------------------------------------------------------- detail

enum PartyOp {
  salary,
  share,
  debtToThem,
  debtToUs,
  receive,
  pay,
  transfer,
  reward,
  returned,
}

extension PartyOpX on PartyOp {
  String get label => switch (this) {
    PartyOp.salary => 'راتب مع وساطة',
    PartyOp.share => 'حصة دورة',
    PartyOp.debtToThem => 'دين علينا',
    PartyOp.debtToUs => 'دين لنا',
    PartyOp.receive => 'قبض منه',
    PartyOp.pay => 'دفع له',
    PartyOp.transfer => 'تحويل إلى طرف',
    PartyOp.reward => 'مكافأة',
    PartyOp.returned => 'مرتجع',
  };

  IconData get icon => switch (this) {
    PartyOp.salary => Icons.payments_outlined,
    PartyOp.share => Icons.pie_chart_outline,
    PartyOp.debtToThem => Icons.call_received,
    PartyOp.debtToUs => Icons.call_made,
    PartyOp.receive => Icons.south_west,
    PartyOp.pay => Icons.north_east,
    PartyOp.transfer => Icons.swap_horiz,
    PartyOp.reward => Icons.card_giftcard_outlined,
    PartyOp.returned => Icons.undo,
  };
}

List<PartyOp> opsOf(PartyKind k) => [
  if (k == PartyKind.accreditation) PartyOp.salary,
  if (k == PartyKind.subAgency) PartyOp.share,
  PartyOp.receive,
  PartyOp.pay,
  PartyOp.debtToUs,
  PartyOp.debtToThem,
  PartyOp.transfer,
  if (k == PartyKind.subAgency || k == PartyKind.member) PartyOp.reward,
  if (k == PartyKind.transferCompany || k == PartyKind.accreditation)
    PartyOp.returned,
];

class PartyPage extends StatelessWidget {
  const PartyPage({super.key, required this.accountId});
  final int accountId;

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'ملف الطرف',
    actions: (context, data) {
      final d =
          data
              as ({
                Party? party,
                ({int opening, List<StatementLine> lines}) st,
              });
      final p = d.party;
      if (p == null) return const [];
      return [
        PdfButton(
          name: 'كشف ${p.name}',
          build:
              (pdf, s) => pdf.statement(
                workspace: s.workspace.name,
                account: p.account,
                from: null,
                to: Ledger.today(),
                opening: d.st.opening,
                lines: d.st.lines,
              ),
        ),
      ];
    },
    help: const [
      HelpItem(
        '',
        'الرصيد والحركات من القيود مباشرة. اضغط أي حركة لعرض قيدها أو إلغائه بقيد عكسي.',
      ),
      HelpItem(
        '',
        'الأزرار في الأعلى تسجّل العمليات على هذا الطرف؛ كل واحدة قيد واحد متوازن.',
      ),
    ],
    load:
        (s) async => (
          party: await s.parties.ofAccount(accountId),
          st: await s.ledger.statement(accountId),
        ),
    build: (context, data, reload) {
      final d =
          data
              as ({
                Party? party,
                ({int opening, List<StatementLine> lines}) st,
              });
      final p = d.party;
      if (p == null) {
        return const [
          EmptyState(
            icon: Icons.person_off_outlined,
            title: 'غير موجود',
            message: '',
          ),
        ];
      }
      final lines = d.st.lines.reversed.toList();
      return [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: panelDecoration(radius: Ds.radiusL),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  IconChip(
                    partyIcon(p.kind),
                    color: Tw.accentInk,
                    bg: Tw.accentSoft,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          p.name,
                          style: Ds.body.copyWith(
                            fontSize: 18,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        Text(
                          [
                            p.kind.label,
                            if (p.code.isNotEmpty) p.code,
                            if (p.phone.isNotEmpty) p.phone,
                            if (p.percentBp > 0)
                              '${formatPercent(p.percentBp)}٪',
                          ].join(' · '),
                          style: Ds.secondary,
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: p.pinned ? 'إلغاء التثبيت' : 'تثبيت في الأعلى',
                    onPressed:
                        () => runPosting(
                          context,
                          (s) => s.parties.update(p, pinned: !p.pinned),
                        ),
                    icon: Icon(
                      p.pinned ? Icons.push_pin : Icons.push_pin_outlined,
                      color: Tw.ink2,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Text(
                p.balance > 0
                    ? 'لنا عنده'
                    : (p.balance < 0 ? 'علينا له' : 'الرصيد'),
                style: Ds.secondary,
              ),
              Money(
                p.balance.abs(),
                size: 30,
                weight: FontWeight.w800,
                color:
                    p.balance > 0
                        ? Tw.accentInk
                        : (p.balance < 0 ? Tw.danger : null),
              ),
              const SizedBox(height: 14),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final op in opsOf(p.kind))
                    ActionChip(
                      avatar: Icon(op.icon, size: 18, color: Tw.accentInk),
                      label: Text(op.label),
                      onPressed: () => showPartyOpSheet(context, p, op),
                    ),
                ],
              ),
            ],
          ),
        ),
        gap,
        GroupList(
          children: [
            HubRow(
              icon: Icons.edit_outlined,
              title: 'تعديل البيانات',
              subtitle: p.note.isEmpty ? null : p.note,
              onTap: () => showEditPartySheet(context, p),
            ),
            HubRow(
              icon: Icons.receipt_long_outlined,
              title: 'كشف حساب بفترة',
              onTap: () => openPage(context, StatementPage(account: p.account)),
            ),
            HubRow(
              icon:
                  p.account.archived
                      ? Icons.unarchive_outlined
                      : Icons.archive_outlined,
              title: p.account.archived ? 'إعادة من الأرشيف' : 'أرشفة',
              subtitle: p.account.archived ? null : 'عندما يصبح رصيده صفرًا',
              onTap:
                  () => runPosting(
                    context,
                    (s) =>
                        s.ledger.setArchived(p.account.id, !p.account.archived),
                    done: 'تم',
                  ),
            ),
          ],
        ),
        gap,
        SectionLabel('الحركات', trailing: Text('${lines.length}')),
        if (lines.isEmpty)
          const EmptyState(
            icon: Icons.receipt_long_outlined,
            title: 'لا حركات',
            message: 'العمليات على هذا الطرف تظهر هنا.',
          )
        else
          GroupList(
            children: [for (final l in lines.take(300)) StatementRow(line: l)],
          ),
      ];
    },
  );
}

// ------------------------------------------------------------- op sheet

Future<void> showPartyOpSheet(BuildContext context, Party party, PartyOp op) =>
    showAppSheet<void>(context, (_) => _PartyOpSheet(party: party, op: op));

class _PartyOpSheet extends StatefulWidget {
  const _PartyOpSheet({required this.party, required this.op});
  final Party party;
  final PartyOp op;
  @override
  State<_PartyOpSheet> createState() => _PartyOpSheetState();
}

class _PartyOpSheetState extends State<_PartyOpSheet> {
  final _amount = TextEditingController();
  final _pct = TextEditingController();
  final _memo = TextEditingController();
  final _cycle = TextEditingController();
  String _date = Ledger.today();
  Account? _fund;
  Account? _counter;
  Account? _target;
  bool _payNow = false;
  bool _busy = false;

  PartyOp get op => widget.op;
  Party get party => widget.party;

  bool get _usesFund =>
      op == PartyOp.salary ||
      op == PartyOp.receive ||
      op == PartyOp.pay ||
      op == PartyOp.returned ||
      (op == PartyOp.reward && _payNow);
  bool get _usesCounter =>
      op == PartyOp.debtToUs || op == PartyOp.debtToThem || op == PartyOp.share;
  bool get _usesPct =>
      op == PartyOp.salary || op == PartyOp.share || op == PartyOp.debtToThem;

  @override
  void initState() {
    super.initState();
    if (op == PartyOp.salary || op == PartyOp.share) {
      _pct.text = party.percentBp == 0 ? '' : formatPercent(party.percentBp);
    }
    _init();
  }

  Future<void> _init() async {
    final s = AppScope.read(context);
    final funds = await s.books.funds();
    final main = await s.ledger.byRole(Roles.mainFund);
    if (!mounted) return;
    setState(() {
      _fund = funds.isEmpty ? null : funds.first.account;
      if (op == PartyOp.debtToUs || op == PartyOp.debtToThem) _counter = main;
    });
  }

  @override
  void dispose() {
    _amount.dispose();
    _pct.dispose();
    _memo.dispose();
    _cycle.dispose();
    super.dispose();
  }

  Future<void> _pickFund() async {
    final s = AppScope.read(context);
    final ids = {for (final f in await s.books.funds()) f.account.id};
    if (!mounted) return;
    final a = await pickAccount(
      context,
      title: 'الصندوق',
      selectedId: _fund?.id,
      where: (a) => ids.contains(a.id),
    );
    if (a != null) setState(() => _fund = a);
  }

  String get _counterTitle => switch (op) {
    PartyOp.debtToUs => 'مقابل (ما أعطيناه أو كسبناه)',
    PartyOp.debtToThem => 'مقابل (ما استلمناه)',
    _ => 'من حساب (مصدر المبلغ)',
  };

  String get _caption => switch (op) {
    PartyOp.salary =>
      'يدخل المبلغ كاملًا إلى الصندوق، والوساطة إيراد لنا، والباقي دين علينا للمعتمد.',
    PartyOp.share =>
      'المبلغ (عمود W) من الحساب المختار؛ نسبة الشركة إيراد لنا والباقي حصة الوكالة (علينا).',
    PartyOp.debtToUs =>
      'من حـ/ ${party.name} إلى حـ/ المقابل. اختر الصندوق إن دفعنا له نقدًا، أو إيرادًا إن كان المبلغ ربحًا لنا عليه.',
    PartyOp.debtToThem =>
      'من حـ/ المقابل إلى حـ/ ${party.name}. اختر الصندوق إن أودع لدينا نقدًا. نسبة الخصم (اختيارية) ربح لنا ويبقى علينا الصافي.',
    PartyOp.receive => 'من حـ/ الصندوق إلى حـ/ ${party.name}.',
    PartyOp.returned => 'مرتجع: مبلغ عاد من ${party.name} إلى الصندوق.',
    PartyOp.pay => 'من حـ/ ${party.name} إلى حـ/ الصندوق.',
    PartyOp.transfer => 'ينقص ما لنا عند ${party.name} ويزيد عند الطرف الآخر.',
    PartyOp.reward =>
      'مصروف مكافأة يُضاف لحساب ${party.name}، ويُدفع الآن من صندوق إن اخترت.',
  };

  Widget? _preview() {
    final a = AmountField.cents(_amount) ?? 0;
    final bp = parsePercentBp(_pct.text) ?? 0;
    if (a <= 0 || bp <= 0) return null;
    final cut = percentOf(a, bp);
    final (l1, l2) = switch (op) {
      PartyOp.salary => ('وساطة لنا', 'علينا للمعتمد'),
      PartyOp.share => ('حصة الشركة', 'حصة الوكالة'),
      _ => ('ربح الخصم', 'علينا (الصافي)'),
    };
    return FigsRow(
      flat: true,
      figs: [
        (formatCentsShort(cut), l1, Tw.accentInk),
        (formatCentsShort(a - cut), l2, null),
      ],
    );
  }

  Future<void> _save() async {
    final amount = AmountField.cents(_amount);
    if (amount == null || amount <= 0) {
      showToast(context, 'اكتب المبلغ', ToastType.warning);
      return;
    }
    final bp = _pct.text.trim().isEmpty ? 0 : parsePercentBp(_pct.text);
    if (bp == null) {
      showToast(context, 'النسبة بين 0 و100', ToastType.warning);
      return;
    }
    if (_usesFund && _fund == null) {
      showToast(context, 'اختر الصندوق', ToastType.warning);
      return;
    }
    if (_usesCounter && _counter == null) {
      showToast(context, 'اختر الحساب المقابل', ToastType.warning);
      return;
    }
    if (op == PartyOp.transfer && _target == null) {
      showToast(context, 'اختر الطرف المحوَّل إليه', ToastType.warning);
      return;
    }
    final id = party.account.id;
    final memo = _memo.text;
    setState(() => _busy = true);
    final ok = await runPosting(context, (s) {
      final p = s.parties;
      return switch (op) {
        PartyOp.salary => p.salaryWithBrokerage(
          id,
          amount,
          fundId: _fund!.id,
          brokerageBp: bp,
          memo: memo,
          date: _date,
        ),
        PartyOp.share => p.cycleShare(
          id,
          amount,
          counterId: _counter!.id,
          companyBp: bp,
          cycle: _cycle.text.trim(),
          memo: memo,
          date: _date,
        ),
        PartyOp.debtToUs => p.debtToUs(
          id,
          amount,
          counterId: _counter!.id,
          memo: memo,
          date: _date,
        ),
        PartyOp.debtToThem => p.debtToThem(
          id,
          amount,
          counterId: _counter!.id,
          discountBp: bp,
          memo: memo,
          date: _date,
        ),
        PartyOp.receive => p.receive(
          id,
          amount,
          fundId: _fund!.id,
          memo: memo,
          date: _date,
        ),
        PartyOp.returned => p.receive(
          id,
          amount,
          fundId: _fund!.id,
          memo: memo,
          date: _date,
          returned: true,
        ),
        PartyOp.pay => p.pay(
          id,
          amount,
          fundId: _fund!.id,
          memo: memo,
          date: _date,
        ),
        PartyOp.transfer => p.transfer(
          id,
          _target!.id,
          amount,
          memo: memo,
          date: _date,
        ),
        PartyOp.reward => p.reward(
          id,
          amount,
          fundId: _payNow ? _fund?.id : null,
          memo: memo,
          date: _date,
        ),
      };
    }, done: 'سُجّلت العملية');
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final preview = _usesPct ? _preview() : null;
    return AppSheet(
      title: '${op.label} — ${party.name}',
      footer: ErpButton(
        label: 'تسجيل',
        icon: Icons.check,
        loading: _busy,
        onPressed: _save,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SheetLabel(
            op == PartyOp.share ? 'المبلغ (عمود W)' : 'المبلغ',
            first: true,
          ),
          AmountField(
            controller: _amount,
            autofocus: true,
            onChanged: (_) => setState(() {}),
          ),
          if (_usesPct) ...[
            SheetLabel(switch (op) {
              PartyOp.salary => 'نسبة الوساطة ٪',
              PartyOp.share => 'نسبة الشركة ٪',
              _ => 'نسبة الخصم ٪ (اختياري)',
            }),
            ErpTextField(
              controller: _pct,
              hint: '0',
              ltr: true,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              onChanged: (_) => setState(() {}),
            ),
          ],
          if (preview != null) ...[const SizedBox(height: 10), preview],
          const SheetLabel('التفاصيل'),
          FormRows(
            children: [
              if (op == PartyOp.reward)
                FormRow(
                  'ادفعها الآن من صندوق',
                  Switch(
                    value: _payNow,
                    onChanged: (v) => setState(() => _payNow = v),
                  ),
                ),
              if (_usesFund)
                FormRow(
                  op == PartyOp.pay
                      ? 'من الصندوق'
                      : (op == PartyOp.reward ? 'من الصندوق' : 'إلى الصندوق'),
                  PickerValue(
                    text: _fund?.name ?? 'اختر',
                    placeholder: _fund == null,
                    onTap: _pickFund,
                  ),
                ),
              if (_usesCounter)
                FormRow(
                  _counterTitle,
                  PickerValue(
                    text: _counter?.name ?? 'اختر الحساب',
                    placeholder: _counter == null,
                    onTap: () async {
                      final a = await pickAccount(
                        context,
                        title: _counterTitle,
                        selectedId: _counter?.id,
                        where: (a) => a.id != party.account.id,
                      );
                      if (a != null) setState(() => _counter = a);
                    },
                  ),
                ),
              if (op == PartyOp.transfer)
                FormRow(
                  'إلى',
                  PickerValue(
                    text: _target?.name ?? 'اختر الطرف',
                    placeholder: _target == null,
                    onTap: () async {
                      final s = AppScope.read(context);
                      final ids = {
                        for (final x in await s.reports.partyBalances())
                          x.account.id,
                      };
                      if (!context.mounted) return;
                      final a = await pickAccount(
                        context,
                        title: 'الطرف المحوَّل إليه',
                        selectedId: _target?.id,
                        where:
                            (a) =>
                                a.id != party.account.id && ids.contains(a.id),
                      );
                      if (a != null) setState(() => _target = a);
                    },
                  ),
                ),
              if (op == PartyOp.share)
                FormRow(
                  'الدورة',
                  ErpTextField(
                    controller: _cycle,
                    hint: 'اسم الدورة (اختياري)',
                  ),
                  block: true,
                ),
              FormRow(
                'التاريخ',
                DateValue(
                  value: _date,
                  onChanged: (v) => setState(() => _date = v),
                ),
              ),
            ],
          ),
          const SheetLabel('البيان'),
          MemoField(controller: _memo, hint: 'اختياري'),
          Caption(_caption),
        ],
      ),
    );
  }
}

// ------------------------------------------------------ new / edit party

Future<void> showNewPartySheet(BuildContext context, PartyKind kind) =>
    showAppSheet<void>(context, (_) => _PartyFormSheet(kind: kind));

Future<void> showEditPartySheet(BuildContext context, Party p) =>
    showAppSheet<void>(context, (_) => _PartyFormSheet(kind: p.kind, party: p));

class _PartyFormSheet extends StatefulWidget {
  const _PartyFormSheet({required this.kind, this.party});
  final PartyKind kind;
  final Party? party;
  @override
  State<_PartyFormSheet> createState() => _PartyFormSheetState();
}

class _PartyFormSheetState extends State<_PartyFormSheet> {
  late final _name = TextEditingController(text: widget.party?.name ?? '');
  late final _code = TextEditingController(text: widget.party?.code ?? '');
  late final _phone = TextEditingController(text: widget.party?.phone ?? '');
  late final _pct = TextEditingController(
    text:
        (widget.party?.percentBp ?? 0) == 0
            ? ''
            : formatPercent(widget.party!.percentBp),
  );
  late final _note = TextEditingController(text: widget.party?.note ?? '');
  final _opening = TextEditingController();
  bool _openingToUs = false;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_name, _code, _phone, _pct, _note, _opening]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final bp = _pct.text.trim().isEmpty ? 0 : parsePercentBp(_pct.text);
    if (bp == null) {
      showToast(context, 'النسبة بين 0 و100', ToastType.warning);
      return;
    }
    final opening =
        _opening.text.trim().isEmpty ? 0 : AmountField.cents(_opening);
    if (opening == null || opening < 0) {
      showToast(context, 'الرصيد الافتتاحي غير صحيح', ToastType.warning);
      return;
    }
    setState(() => _busy = true);
    final p = widget.party;
    final ok = await runPosting(
      context,
      (s) =>
          p == null
              ? s.parties.add(
                widget.kind,
                _name.text,
                code: _code.text,
                phone: _phone.text,
                percentBp: bp,
                note: _note.text,
                opening: _openingToUs ? opening : -opening,
              )
              : s.parties.update(
                p,
                name: _name.text,
                code: _code.text,
                phone: _phone.text,
                percentBp: bp,
                note: _note.text,
              ),
      done: p == null ? 'أُضيف' : 'حُفظ',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final k = widget.kind;
    final pctLabel = k.percentLabel;
    return AppSheet(
      title:
          widget.party == null
              ? '${k.label} جديد'
              : 'تعديل ${widget.party!.name}',
      footer: ErpButton(
        label: 'حفظ',
        icon: Icons.check,
        loading: _busy,
        onPressed: _save,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SheetLabel('الاسم', first: true),
          ErpTextField(controller: _name, hint: 'الاسم'),
          const SheetLabel('بيانات (اختيارية)'),
          FormRows(
            children: [
              FormRow(
                'الرمز',
                SizedBox(
                  width: 160,
                  child: ErpTextField(controller: _code, hint: '—', ltr: true),
                ),
              ),
              FormRow(
                'الهاتف',
                SizedBox(
                  width: 160,
                  child: ErpTextField(
                    controller: _phone,
                    hint: '—',
                    ltr: true,
                    keyboardType: TextInputType.phone,
                  ),
                ),
              ),
              if (pctLabel != null)
                FormRow(
                  '$pctLabel ٪',
                  SizedBox(
                    width: 100,
                    child: ErpTextField(
                      controller: _pct,
                      hint: '0',
                      ltr: true,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SheetLabel('ملاحظة'),
          MemoField(controller: _note, hint: 'اختياري'),
          if (widget.party == null) ...[
            const SheetLabel('الرصيد الافتتاحي (اختياري)'),
            AmountField(controller: _opening),
            const SizedBox(height: 8),
            SegmentedChoice(
              options: const ['علينا له', 'لنا عنده'],
              selected: _openingToUs ? 1 : 0,
              onChanged: (i) => setState(() => _openingToUs = i == 1),
            ),
            const Caption(
              'يُقيَّد الرصيد الافتتاحي مقابل «أرصدة افتتاحية» في حقوق الملكية.',
            ),
          ],
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------- import

Future<void> showImportSheet(BuildContext context, PartyKind kind) =>
    showAppSheet<void>(context, (_) => _ImportSheet(kind: kind));

class _ImportSheet extends StatefulWidget {
  const _ImportSheet({required this.kind});
  final PartyKind kind;
  @override
  State<_ImportSheet> createState() => _ImportSheetState();
}

class _ImportSheetState extends State<_ImportSheet> {
  final _text = TextEditingController();
  bool _toUs = false;
  String _date = Ledger.today();
  bool _busy = false;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final rows = Parties.parseLines(_text.text);
    final total = rows.fold(0, (n, r) => n + r.$2);
    return AppSheet(
      title: 'رفع أرصدة ${widget.kind.plural}',
      footer: ErpButton(
        label: rows.isEmpty ? 'تسجيل' : 'تسجيل ${rows.length} رصيدًا',
        icon: Icons.check,
        loading: _busy,
        onPressed:
            rows.isEmpty
                ? null
                : () async {
                  setState(() => _busy = true);
                  final ok = await runPosting(
                    context,
                    (s) => s.parties.importBalances(
                      widget.kind,
                      rows,
                      toUs: _toUs,
                      date: _date,
                    ),
                    done: 'سُجّلت الأرصدة',
                  );
                  if (!context.mounted) return;
                  setState(() => _busy = false);
                  if (ok) Navigator.pop(context);
                },
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SheetLabel('سطر لكل طرف: الاسم ثم المبلغ', first: true),
          TextField(
            controller: _text,
            minLines: 5,
            maxLines: 10,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              hintText: 'أحمد\t1200\nمكتب النور\t350.5',
              filled: true,
              fillColor: Tw.surface2,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: BorderSide.none,
              ),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: ErpButton(
                  label: 'لصق',
                  icon: Icons.content_paste,
                  kind: ErpButtonKind.indigoSoft,
                  height: 40,
                  onPressed: () async {
                    final t = await pasteText();
                    if (t != null) setState(() => _text.text = t);
                  },
                ),
              ),
            ],
          ),
          const SheetLabel('المبالغ'),
          SegmentedChoice(
            options: const ['علينا لهم', 'لنا عندهم'],
            selected: _toUs ? 1 : 0,
            onChanged: (i) => setState(() => _toUs = i == 1),
          ),
          const SizedBox(height: 8),
          FormRows(
            children: [
              FormRow(
                'التاريخ',
                DateValue(
                  value: _date,
                  onChanged: (v) => setState(() => _date = v),
                ),
              ),
            ],
          ),
          if (rows.isNotEmpty)
            Caption(
              '${rows.length} سطرًا بمجموع ${formatCents(total)}. الأسماء غير الموجودة تُضاف، ويُسجَّل قيد افتتاحي واحد.',
            ),
          const Caption(
            'يمكن النسخ من Excel أو Google Sheets مباشرة (عمودا الاسم والمبلغ).',
          ),
        ],
      ),
    );
  }
}

/// Picks any party account (for registering a debt from the debts page).
Future<Party?> pickParty(BuildContext context, {String title = 'الطرف'}) async {
  final s = AppScope.read(context);
  final ids = {for (final x in await s.reports.partyBalances()) x.account.id};
  if (!context.mounted) return null;
  final a = await pickAccount(
    context,
    title: title,
    where: (a) => ids.contains(a.id),
  );
  if (a == null) return null;
  return s.parties.ofAccount(a.id);
}

/// For a new party picked by a debt form when none exist yet.
Future<void> askNewParty(BuildContext context) async {
  final kind = await showAppSheet<PartyKind>(
    context,
    (ctx) => AppSheet(
      title: 'نوع الطرف',
      child: Column(
        children: [
          for (final k in PartyKind.values)
            ChoiceTile(
              icon: partyIcon(k),
              label: k.label,
              onTap: () => Navigator.pop(ctx, k),
            ),
        ],
      ),
    ),
  );
  if (kind == null || !context.mounted) return;
  await showNewPartySheet(context, kind);
}
