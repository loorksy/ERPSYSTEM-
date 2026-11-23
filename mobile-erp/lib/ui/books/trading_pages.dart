// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/chart.dart';
import '../../accounting/ledger.dart';
import '../../accounting/money.dart';
import '../../accounting/parties.dart';
import '../../accounting/trading.dart';
import '../../app_services.dart';
import '../erp_theme.dart';
import '../erp_widgets.dart';
import '../help.dart';
import '../ui_kit.dart';
import 'books_kit.dart';
import 'forms.dart';

/// Picks a fund (null when cancelled).
Future<Account?> pickFund(BuildContext context, {int? selectedId}) async {
  final s = AppScope.read(context);
  final ids = {for (final f in await s.books.funds()) f.account.id};
  if (!context.mounted) return null;
  return pickAccount(
    context,
    title: 'الصندوق',
    selectedId: selectedId,
    where: (a) => ids.contains(a.id),
  );
}

/// Picks a party account, optionally of some kinds only.
Future<Account?> pickPartyAccount(
  BuildContext context, {
  String title = 'الطرف',
  Set<PartyKind>? kinds,
  int? selectedId,
}) async {
  final s = AppScope.read(context);
  final roles = kinds?.map((k) => k.groupRole).toSet();
  final ids = {
    for (final x in await s.reports.partyBalances())
      if (roles == null || roles.contains(x.groupRole)) x.account.id,
  };
  if (!context.mounted) return null;
  return pickAccount(
    context,
    title: title,
    selectedId: selectedId,
    where: (a) => ids.contains(a.id),
  );
}

/// «صندوق» / «طرف» choice with its picker, for forms that take either.
class FundOrParty extends StatelessWidget {
  const FundOrParty({
    super.key,
    required this.label,
    required this.party,
    required this.account,
    required this.onMode,
    required this.onAccount,
    this.partyLabel = 'دين على طرف',
    this.kinds,
  });
  final String label;
  final bool party;
  final Account? account;
  final ValueChanged<bool> onMode;
  final ValueChanged<Account> onAccount;
  final String partyLabel;
  final Set<PartyKind>? kinds;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      SegmentedChoice(
        options: ['نقدًا من/إلى صندوق', partyLabel],
        selected: party ? 1 : 0,
        onChanged: (i) => onMode(i == 1),
      ),
      const SizedBox(height: 8),
      FormRows(
        children: [
          FormRow(
            label,
            PickerValue(
              text: account?.name ?? 'اختر',
              placeholder: account == null,
              onTap: () async {
                final a =
                    party
                        ? await pickPartyAccount(
                          context,
                          kinds: kinds,
                          selectedId: account?.id,
                        )
                        : await pickFund(context, selectedId: account?.id);
                if (a != null) onAccount(a);
              },
            ),
          ),
        ],
      ),
    ],
  );
}

// -------------------------------------------------------------- shipping

const shippingHelp = [
  HelpItem(
    '',
    'الشحن: أصناف (ذهب، كرستال…) تُشترى وتُباع. قيمة المخزون بمتوسط التكلفة المرجّح: كل شراء يضيف كميته وكلفته، وكل بيع يُخرج تكلفة كميته بالمتوسط.',
  ),
  HelpItem(
    '',
    'ربح البيع = سعر البيع − تكلفة الكمية المباعة، ويظهر في قائمة الدخل (مبيعات الشحن ناقص تكلفة البضاعة المباعة).',
  ),
  HelpItem(
    '',
    'البيع نقدًا يدخل صندوقًا، أو دينًا على المشتري (عضو، معتمد، وكالة فرعية، وكالة شحن…): يُسجَّل في حسابه «لنا». الخصم من الراتب أو من نسبة الوكالة دينٌ على العضو أو الوكالة.',
  ),
  HelpItem(
    '',
    'تبديل راتب: شركة تحويل تأخذ الراتب مقابل الصافي بعد نسبة خصم؛ الخصم مصروف، والصافي يدخل الصندوق الآن أو يبقى دينًا لنا على الشركة.',
  ),
  HelpItem(
    '',
    'إلغاء أي عملية من سجلها بقيد عكسي يعيد الكمية والقيمة. لا يُلغى شراء بيع جزء منه قبل إلغاء البيع.',
  ),
];

class ShippingPage extends StatelessWidget {
  const ShippingPage({super.key});

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'الشحن',
    help: shippingHelp,
    load:
        (s) async => (
          items: await s.trading.items(),
          moves: await s.trading.moves(limit: 60),
        ),
    build: (context, data, reload) {
      final d = data as ({List<StockItem> items, List<StockMove> moves});
      final value = d.items.fold(0, (n, i) => n + i.value);
      final profit = d.moves
          .where((m) => !m.entry.reversed)
          .fold(0, (n, m) => n + m.profit);
      return [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: panelDecoration(radius: Ds.radiusL),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('قيمة المخزون (بالتكلفة)', style: Ds.secondary),
              Money(value, size: 30, weight: FontWeight.w800),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: ErpButton(
                      label: 'بيع',
                      icon: Icons.sell_outlined,
                      height: 42,
                      kind: ErpButtonKind.indigoSoft,
                      onPressed:
                          () => showAppSheet<void>(
                            context,
                            (_) => _StockSheet(items: d.items, selling: true),
                          ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ErpButton(
                      label: 'شراء',
                      icon: Icons.add_shopping_cart,
                      height: 42,
                      kind: ErpButtonKind.indigoSoft,
                      onPressed:
                          () => showAppSheet<void>(
                            context,
                            (_) => _StockSheet(items: d.items, selling: false),
                          ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ErpButton(
                      label: 'تبديل',
                      icon: Icons.currency_exchange,
                      height: 42,
                      kind: ErpButtonKind.indigoSoft,
                      onPressed:
                          () => showAppSheet<void>(
                            context,
                            (_) => const _SalarySwapSheet(),
                          ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        gap,
        SectionLabel(
          'الأصناف',
          trailing: TextButton.icon(
            onPressed: () async {
              final name = await askName(
                context,
                'صنف جديد',
                hint: 'اسم الصنف',
              );
              if (name == null || !context.mounted) return;
              await runPosting(
                context,
                (s) => s.trading.addItem(name, unit: 'وحدة'),
                done: 'أُضيف الصنف',
              );
            },
            icon: const Icon(Icons.add, size: 17),
            label: const Text('صنف'),
          ),
        ),
        GroupList(
          children: [
            for (final i in d.items)
              ListRow(
                title: i.name,
                leading: IconChip(
                  Icons.diamond_outlined,
                  color: Tw.accentInk,
                  bg: Tw.accentSoft,
                ),
                subtitle: Text(
                  'الكمية ${formatQty(i.qty)} · متوسط ${formatCents(i.average)}',
                ),
                trailing: Money(i.value),
              ),
          ],
        ),
        gap,
        SectionLabel(
          'آخر العمليات',
          trailing: Text('ربح المبيعات ${formatCentsShort(profit)}'),
        ),
        if (d.moves.isEmpty)
          const EmptyState(
            icon: Icons.local_shipping_outlined,
            title: 'لا عمليات',
            message: 'سجّل أول شراء ثم البيع.',
          )
        else
          GroupList(
            children: [
              for (final m in d.moves)
                ListRow(
                  title:
                      '${m.isSale ? 'بيع' : 'شراء'} ${formatQty(m.qty.abs())} ${m.itemName}',
                  titleColor: m.entry.reversed ? Tw.ink3 : null,
                  leading: IconChip(
                    m.isSale ? Icons.sell_outlined : Icons.add_shopping_cart,
                    color: m.entry.reversed ? Tw.ink3 : Tw.accentInk,
                    bg: m.entry.reversed ? Tw.surface2 : Tw.accentSoft,
                  ),
                  subtitle: Text(
                    [
                      dateLabel(m.entry.date),
                      if (m.partyName != null) m.partyName!,
                      if (m.isSale) 'ربح ${formatCents(m.profit)}',
                      if (m.entry.reversed) 'مُلغى',
                    ].join(' · '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  trailing: Money(
                    m.amount,
                    color: m.entry.reversed ? Tw.ink3 : null,
                  ),
                  onTap: () => showEntrySheet(context, m.entry.id),
                ),
            ],
          ),
      ];
    },
  );
}

class _StockSheet extends StatefulWidget {
  const _StockSheet({required this.items, required this.selling});
  final List<StockItem> items;
  final bool selling;
  @override
  State<_StockSheet> createState() => _StockSheetState();
}

class _StockSheetState extends State<_StockSheet> {
  final _qty = TextEditingController();
  final _total = TextEditingController();
  final _memo = TextEditingController();
  String _date = Ledger.today();
  int _item = 0;
  bool _party = false;
  Account? _account;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final s = AppScope.read(context);
      final main = await s.ledger.byRole(Roles.mainFund);
      if (mounted) setState(() => _account = main);
    });
  }

  @override
  void dispose() {
    _qty.dispose();
    _total.dispose();
    _memo.dispose();
    super.dispose();
  }

  StockItem? get _it => widget.items.isEmpty ? null : widget.items[_item];

  Future<void> _save() async {
    final it = _it;
    final qty = parseQty(_qty.text);
    final total = AmountField.cents(_total);
    if (it == null || qty == null || qty <= 0) {
      showToast(context, 'اكتب الكمية', ToastType.warning);
      return;
    }
    if (total == null || total < 0 || (!widget.selling && total == 0)) {
      showToast(context, 'اكتب المبلغ الإجمالي', ToastType.warning);
      return;
    }
    if (_account == null) {
      showToast(
        context,
        _party ? 'اختر الطرف' : 'اختر الصندوق',
        ToastType.warning,
      );
      return;
    }
    setState(() => _busy = true);
    final ok = await runPosting(
      context,
      (s) =>
          widget.selling
              ? s.trading.sell(
                it.id,
                qty,
                total,
                receiveIntoId: _account!.id,
                memo: _memo.text,
                date: _date,
              )
              : s.trading.buy(
                it.id,
                qty,
                total,
                payFromId: _account!.id,
                memo: _memo.text,
                date: _date,
              ),
      done: widget.selling ? 'سُجّل البيع' : 'سُجّل الشراء',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final it = _it;
    final qty = parseQty(_qty.text) ?? 0;
    final total = AmountField.cents(_total) ?? 0;
    final cost =
        it == null || it.qty <= 0 || qty <= 0
            ? 0
            : (qty >= it.qty ? it.value : (it.value * qty / it.qty).round());
    return AppSheet(
      title: widget.selling ? 'بيع' : 'شراء',
      footer: ErpButton(
        label: widget.selling ? 'تسجيل البيع' : 'تسجيل الشراء',
        icon: Icons.check,
        loading: _busy,
        onPressed: _save,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SheetLabel('الصنف', first: true),
          SegmentedChoice(
            options: [for (final i in widget.items) i.name],
            selected: _item,
            onChanged: (i) => setState(() => _item = i),
          ),
          if (it != null)
            Caption(
              'المتوفر ${formatQty(it.qty)} · متوسط التكلفة ${formatCents(it.average)}',
            ),
          const SheetLabel('الكمية'),
          ErpTextField(
            controller: _qty,
            hint: '0',
            ltr: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (_) => setState(() {}),
          ),
          const SheetLabel('المبلغ الإجمالي'),
          AmountField(controller: _total, onChanged: (_) => setState(() {})),
          if (widget.selling && qty > 0 && total > 0) ...[
            const SizedBox(height: 10),
            FigsRow(
              flat: true,
              figs: [
                (formatCentsShort(cost), 'التكلفة', null),
                (
                  formatCentsShort(total - cost),
                  total >= cost ? 'الربح' : 'الخسارة',
                  total >= cost ? Tw.accentInk : Tw.danger,
                ),
              ],
            ),
          ],
          SheetLabel(widget.selling ? 'القبض' : 'الدفع'),
          FundOrParty(
            label:
                widget.selling
                    ? (_party ? 'المشتري' : 'إلى الصندوق')
                    : (_party ? 'المورد' : 'من الصندوق'),
            party: _party,
            account: _account,
            partyLabel: widget.selling ? 'دين على المشتري' : 'دين علينا للبائع',
            onMode:
                (v) => setState(() {
                  _party = v;
                  _account = null;
                }),
            onAccount: (a) => setState(() => _account = a),
          ),
          if (widget.selling && _party)
            const Caption(
              'الخصم من راتب عضو أو من نسبة وكالة: اختر العضو أو الوكالة هنا، فيُسجَّل المبلغ دينًا لنا في حسابه.',
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
          const SheetLabel('البيان'),
          MemoField(controller: _memo, hint: 'اختياري'),
        ],
      ),
    );
  }
}

class _SalarySwapSheet extends StatefulWidget {
  const _SalarySwapSheet();
  @override
  State<_SalarySwapSheet> createState() => _SalarySwapSheetState();
}

class _SalarySwapSheetState extends State<_SalarySwapSheet> {
  final _gross = TextEditingController();
  final _pct = TextEditingController();
  final _first = TextEditingController();
  final _memo = TextEditingController();
  String _date = Ledger.today();
  int _mode = 0; // cash, instalments, credit
  Account? _company;
  Account? _from;
  Account? _fund;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_gross, _pct, _first, _memo]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final gross = AmountField.cents(_gross);
    final bp = _pct.text.trim().isEmpty ? 0 : parsePercentBp(_pct.text);
    if (gross == null || gross <= 0 || bp == null) {
      showToast(context, 'اكتب المبلغ والنسبة', ToastType.warning);
      return;
    }
    if (_company == null || _from == null || (_mode < 2 && _fund == null)) {
      showToast(
        context,
        'أكمل الشركة والصندوق وحساب الراتب',
        ToastType.warning,
      );
      return;
    }
    final first = _mode == 1 ? (AmountField.cents(_first) ?? 0) : null;
    setState(() => _busy = true);
    final ok = await runPosting(
      context,
      (s) => s.trading.salarySwap(
        companyId: _company!.id,
        gross: gross,
        discountBp: bp,
        salaryFromId: _from!.id,
        fundId: _mode == 2 ? null : _fund!.id,
        firstPayment: first,
        memo: _memo.text,
        date: _date,
      ),
      done: 'سُجّل تبديل الراتب',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final gross = AmountField.cents(_gross) ?? 0;
    final bp = parsePercentBp(_pct.text) ?? 0;
    final disc = percentOf(gross, bp);
    return AppSheet(
      title: 'تبديل راتب',
      footer: ErpButton(
        label: 'تسجيل',
        icon: Icons.check,
        loading: _busy,
        onPressed: _save,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SheetLabel('الراتب الإجمالي', first: true),
          AmountField(
            controller: _gross,
            autofocus: true,
            onChanged: (_) => setState(() {}),
          ),
          const SheetLabel('نسبة الخصم ٪'),
          ErpTextField(
            controller: _pct,
            hint: '0',
            ltr: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (_) => setState(() {}),
          ),
          if (gross > 0) ...[
            const SizedBox(height: 10),
            FigsRow(
              flat: true,
              figs: [
                (formatCentsShort(disc), 'الخصم (مصروف)', Tw.danger),
                (formatCentsShort(gross - disc), 'الصافي', null),
              ],
            ),
          ],
          const SheetLabel('طريقة القبض'),
          SegmentedChoice(
            options: const ['كاش', 'تقسيط', 'دين'],
            selected: _mode,
            onChanged: (i) => setState(() => _mode = i),
          ),
          const SizedBox(height: 8),
          FormRows(
            children: [
              FormRow(
                'شركة التحويل',
                PickerValue(
                  text: _company?.name ?? 'اختر',
                  placeholder: _company == null,
                  onTap: () async {
                    final a = await pickPartyAccount(
                      context,
                      title: 'شركة التحويل',
                      kinds: {PartyKind.transferCompany},
                      selectedId: _company?.id,
                    );
                    if (a != null) setState(() => _company = a);
                  },
                ),
              ),
              if (_mode < 2)
                FormRow(
                  'إلى الصندوق',
                  PickerValue(
                    text: _fund?.name ?? 'اختر',
                    placeholder: _fund == null,
                    onTap: () async {
                      final a = await pickFund(context, selectedId: _fund?.id);
                      if (a != null) setState(() => _fund = a);
                    },
                  ),
                ),
              if (_mode == 1)
                FormRow(
                  'الدفعة الأولى',
                  SizedBox(
                    width: 130,
                    child: ErpTextField(
                      controller: _first,
                      hint: '0.00',
                      ltr: true,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                    ),
                  ),
                ),
              FormRow(
                'الراتب من حساب',
                PickerValue(
                  text: _from?.name ?? 'اختر',
                  placeholder: _from == null,
                  onTap: () async {
                    final a = await pickAccount(
                      context,
                      title: 'حساب الراتب المحوَّل',
                      selectedId: _from?.id,
                    );
                    if (a != null) setState(() => _from = a);
                  },
                ),
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
          const Caption(
            '«الراتب من حساب»: الحساب الذي يخرج منه الراتب الإجمالي (مثلًا المعتمد الذي يحمل الرواتب). باقي الصافي غير المقبوض يبقى دينًا لنا على الشركة.',
          ),
          const SheetLabel('البيان'),
          MemoField(controller: _memo, hint: 'اختياري'),
        ],
      ),
    );
  }
}

// ------------------------------------------------------------- FX spread

/// 340000.0 → «340,000», 32.5 → «32.5».
String plainNumber(Object? v) {
  if (v is! num) return '${v ?? ''}';
  final whole = v.truncate();
  final frac = (v - whole).abs();
  final w = whole.toString().replaceAllMapped(
    RegExp(r'\B(?=(\d{3})+(?!\d))'),
    (_) => ',',
  );
  if (frac < 1e-9) return w;
  return '$w${v.toStringAsFixed(4).substring(v.toStringAsFixed(4).indexOf('.')).replaceAll(RegExp(r'0+$'), '')}';
}

const fxHelp = [
  HelpItem(
    '',
    'فرق التصريف = |المبلغ ÷ السعر الداخلي − المبلغ ÷ سعر التسوية|، كما في نظام الويب.',
  ),
  HelpItem(
    '',
    'الفرق إيراد في «أرباح فرق التصريف» محفوظ عند الصندوق أو الطرف المختار، أو خسارة إن اخترت ذلك.',
  ),
  HelpItem(
    '',
    'حذف عملية = إلغاؤها بقيد عكسي يعيد الربح والرصيد. (في نظام الويب كان الحذف يمسح السطر ويترك الربح والصندوق كما هما.)',
  ),
];

class FxSpreadPage extends StatelessWidget {
  const FxSpreadPage({super.key});

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'فرق التصريف',
    help: fxHelp,
    fab:
        (context, _) => FloatingActionButton.extended(
          heroTag: 'fx',
          onPressed: () => showAppSheet<void>(context, (_) => const _FxSheet()),
          icon: const Icon(Icons.add),
          label: const Text('فرق تصريف'),
        ),
    load: (s) => s.trading.entriesOf(EntryKind.fx),
    build: (context, data, reload) {
      final list = data as List<JournalEntry>;
      final total = list.where((e) => !e.reversed).fold(0, (n, e) {
        final v = (e.meta['spread'] as num?)?.toInt() ?? 0;
        return n + (e.meta['loss'] == true ? -v : v);
      });
      return [
        FigsRow(
          figs: [
            (
              formatCentsShort(total),
              'صافي فرق التصريف',
              total < 0 ? Tw.danger : Tw.accentInk,
            ),
            ('${list.length}', 'عملية', null),
          ],
        ),
        gap,
        if (list.isEmpty)
          const EmptyState(
            icon: Icons.currency_exchange,
            title: 'لا عمليات',
            message: 'سجّل أول فرق تصريف من الزر في الأسفل.',
          )
        else
          GroupList(
            children: [
              for (final e in list)
                ListRow(
                  title: e.memo,
                  titleColor: e.reversed ? Tw.ink3 : null,
                  leading: IconChip(
                    Icons.currency_exchange,
                    color: Tw.accentInk,
                    bg: Tw.accentSoft,
                  ),
                  subtitle: Text(
                    '${e.meta['currency'] ?? ''} ${plainNumber(e.meta['foreign'])} · ${plainNumber(e.meta['internalRate'])} / ${plainNumber(e.meta['settlementRate'])} · ${dateLabel(e.date)}${e.reversed ? ' · مُلغى' : ''}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  trailing: Money(
                    (e.meta['spread'] as num?)?.toInt() ?? 0,
                    color:
                        e.reversed
                            ? Tw.ink3
                            : (e.meta['loss'] == true
                                ? Tw.danger
                                : Tw.accentInk),
                  ),
                  onTap: () => showEntrySheet(context, e.id),
                ),
            ],
          ),
      ];
    },
  );
}

class _FxSheet extends StatefulWidget {
  const _FxSheet();
  @override
  State<_FxSheet> createState() => _FxSheetState();
}

class _FxSheetState extends State<_FxSheet> {
  final _currency = TextEditingController(text: 'TRY');
  final _foreign = TextEditingController();
  final _internal = TextEditingController();
  final _settle = TextEditingController();
  final _cycle = TextEditingController();
  final _memo = TextEditingController();
  String _date = Ledger.today();
  bool _loss = false;
  bool _party = false;
  Account? _entity;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final main = await AppScope.read(context).ledger.byRole(Roles.mainFund);
      if (mounted) setState(() => _entity = main);
    });
  }

  @override
  void dispose() {
    for (final c in [_currency, _foreign, _internal, _settle, _cycle, _memo]) {
      c.dispose();
    }
    super.dispose();
  }

  static double? _num(String t) {
    final c = parseCents(t);
    return c == null ? double.tryParse(t.trim()) : c / centsPerUnit;
  }

  Future<void> _save() async {
    final f = _num(_foreign.text);
    final ir = double.tryParse(_internal.text.trim().replaceAll('٫', '.'));
    final sr = double.tryParse(_settle.text.trim().replaceAll('٫', '.'));
    if (f == null || ir == null || sr == null || _entity == null) {
      showToast(context, 'أكمل المبلغ والسعرين والحساب', ToastType.warning);
      return;
    }
    setState(() => _busy = true);
    final ok = await runPosting(
      context,
      (s) => s.trading.fxSpread(
        currency: _currency.text,
        foreign: f,
        internalRate: ir,
        settlementRate: sr,
        entityId: _entity!.id,
        loss: _loss,
        cycle: _cycle.text.trim(),
        memo: _memo.text,
        date: _date,
      ),
      done: 'سُجّل فرق التصريف',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final f = _num(_foreign.text) ?? 0;
    final ir = double.tryParse(_internal.text.trim().replaceAll('٫', '.')) ?? 0;
    final sr = double.tryParse(_settle.text.trim().replaceAll('٫', '.')) ?? 0;
    final spread = Trading.spreadOf(f, ir, sr);
    Widget num(TextEditingController c, String hint) => ErpTextField(
      controller: c,
      hint: hint,
      ltr: true,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      onChanged: (_) => setState(() {}),
    );
    return AppSheet(
      title: 'فرق تصريف',
      footer: ErpButton(
        label: 'حفظ',
        icon: Icons.check,
        loading: _busy,
        onPressed: _save,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FormRows(
            children: [
              FormRow(
                'العملة',
                SizedBox(
                  width: 120,
                  child: ErpTextField(
                    controller: _currency,
                    hint: 'TRY',
                    ltr: true,
                  ),
                ),
              ),
              FormRow(
                'المبلغ بالعملة',
                SizedBox(width: 150, child: num(_foreign, '0')),
              ),
              FormRow(
                'السعر الداخلي',
                SizedBox(width: 150, child: num(_internal, '0')),
              ),
              FormRow(
                'سعر التسوية',
                SizedBox(width: 150, child: num(_settle, '0')),
              ),
            ],
          ),
          const SizedBox(height: 10),
          FigsRow(
            flat: true,
            figs: [
              (
                formatCents(spread),
                _loss ? 'الخسارة' : 'الربح',
                _loss ? Tw.danger : Tw.accentInk,
              ),
            ],
          ),
          const SheetLabel('عند'),
          FundOrParty(
            label: _party ? 'الطرف' : 'الصندوق',
            party: _party,
            account: _entity,
            partyLabel: 'طرف (شركة، معتمد…)',
            onMode:
                (v) => setState(() {
                  _party = v;
                  _entity = null;
                }),
            onAccount: (a) => setState(() => _entity = a),
          ),
          const SizedBox(height: 8),
          FormRows(
            children: [
              FormRow(
                'خسارة لا ربح',
                Switch(
                  value: _loss,
                  onChanged: (v) => setState(() => _loss = v),
                ),
              ),
              FormRow(
                'الدورة',
                ErpTextField(controller: _cycle, hint: 'اختياري'),
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
        ],
      ),
    );
  }
}

// ------------------------------------------------------- admin brokerage

const brokerageHelp = [
  HelpItem(
    '',
    'الوساطة الإدارية: يدخل المبلغ كاملًا إلى الصندوق، ونسبة الوساطة إيراد لنا («عمولات الوساطة الإدارية»).',
  ),
  HelpItem(
    '',
    'الباقي ليس ربحًا: يُسجَّل دينًا علينا لمن يستحقه (معتمد، وكالة، عضو…). (نظام الويب كان يتركه في الصندوق دون أن يكون لأحد.)',
  ),
];

class AdminBrokeragePage extends StatelessWidget {
  const AdminBrokeragePage({super.key});

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'الوساطة الإدارية',
    help: brokerageHelp,
    fab:
        (context, _) => FloatingActionButton.extended(
          heroTag: 'brokerage',
          onPressed:
              () => showAppSheet<void>(context, (_) => const _BrokerageSheet()),
          icon: const Icon(Icons.add),
          label: const Text('وساطة'),
        ),
    load:
        (s) => s.trading.entriesOf(EntryKind.brokerage, ref: 'admin_brokerage'),
    build: (context, data, reload) {
      final list = data as List<JournalEntry>;
      final profit = list
          .where((e) => !e.reversed)
          .fold(0, (n, e) => n + ((e.meta['profit'] as num?)?.toInt() ?? 0));
      final amount = list
          .where((e) => !e.reversed)
          .fold(0, (n, e) => n + ((e.meta['amount'] as num?)?.toInt() ?? 0));
      return [
        FigsRow(
          figs: [
            (formatCentsShort(amount), 'المبالغ', null),
            (formatCentsShort(profit), 'ربح الوساطة', Tw.accentInk),
          ],
        ),
        gap,
        if (list.isEmpty)
          const EmptyState(
            icon: Icons.handshake_outlined,
            title: 'لا عمليات',
            message: 'سجّل أول وساطة من الزر في الأسفل.',
          )
        else
          GroupList(
            children: [
              for (final e in list)
                ListRow(
                  title: e.memo,
                  titleColor: e.reversed ? Tw.ink3 : null,
                  leading: IconChip(
                    Icons.handshake_outlined,
                    color: Tw.accentInk,
                    bg: Tw.accentSoft,
                  ),
                  subtitle: Text(
                    'ربح ${formatCents((e.meta['profit'] as num?)?.toInt() ?? 0)} · ${dateLabel(e.date)}${e.reversed ? ' · مُلغى' : ''}',
                  ),
                  trailing: Money(
                    (e.meta['amount'] as num?)?.toInt() ?? 0,
                    color: e.reversed ? Tw.ink3 : null,
                  ),
                  onTap: () => showEntrySheet(context, e.id),
                ),
            ],
          ),
      ];
    },
  );
}

class _BrokerageSheet extends StatefulWidget {
  const _BrokerageSheet();
  @override
  State<_BrokerageSheet> createState() => _BrokerageSheetState();
}

class _BrokerageSheetState extends State<_BrokerageSheet> {
  final _amount = TextEditingController();
  final _pct = TextEditingController();
  final _cycle = TextEditingController();
  final _memo = TextEditingController();
  String _date = Ledger.today();
  Account? _fund;
  Account? _rest;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final main = await AppScope.read(context).ledger.byRole(Roles.mainFund);
      if (mounted) setState(() => _fund = main);
    });
  }

  @override
  void dispose() {
    for (final c in [_amount, _pct, _cycle, _memo]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final amount = AmountField.cents(_amount);
    final bp = _pct.text.trim().isEmpty ? 0 : parsePercentBp(_pct.text);
    if (amount == null || amount <= 0 || bp == null) {
      showToast(context, 'اكتب المبلغ والنسبة', ToastType.warning);
      return;
    }
    if (_fund == null || (_rest == null && bp < 10000)) {
      showToast(context, 'اختر الصندوق ولمن الباقي', ToastType.warning);
      return;
    }
    setState(() => _busy = true);
    final ok = await runPosting(
      context,
      (s) => s.trading.adminBrokerage(
        amount: amount,
        pctBp: bp,
        fundId: _fund!.id,
        restToId: _rest?.id ?? _fund!.id,
        cycle: _cycle.text.trim(),
        memo: _memo.text,
        date: _date,
      ),
      done: 'سُجّلت الوساطة',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final amount = AmountField.cents(_amount) ?? 0;
    final bp = parsePercentBp(_pct.text) ?? 0;
    final profit = percentOf(amount, bp);
    return AppSheet(
      title: 'وساطة إدارية',
      footer: ErpButton(
        label: 'تسجيل',
        icon: Icons.check,
        loading: _busy,
        onPressed: _save,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SheetLabel('المبلغ', first: true),
          AmountField(
            controller: _amount,
            autofocus: true,
            onChanged: (_) => setState(() {}),
          ),
          const SheetLabel('نسبة الوساطة ٪'),
          ErpTextField(
            controller: _pct,
            hint: '0',
            ltr: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (_) => setState(() {}),
          ),
          if (amount > 0) ...[
            const SizedBox(height: 10),
            FigsRow(
              flat: true,
              figs: [
                (formatCentsShort(profit), 'ربح لنا', Tw.accentInk),
                (formatCentsShort(amount - profit), 'الباقي (علينا)', null),
              ],
            ),
          ],
          const SheetLabel('التفاصيل'),
          FormRows(
            children: [
              FormRow(
                'إلى الصندوق',
                PickerValue(
                  text: _fund?.name ?? 'اختر',
                  placeholder: _fund == null,
                  onTap: () async {
                    final a = await pickFund(context, selectedId: _fund?.id);
                    if (a != null) setState(() => _fund = a);
                  },
                ),
              ),
              FormRow(
                'الباقي لـ',
                PickerValue(
                  text: _rest?.name ?? 'اختر',
                  placeholder: _rest == null,
                  onTap: () async {
                    final a = await pickPartyAccount(
                      context,
                      title: 'لمن الباقي',
                      selectedId: _rest?.id,
                    );
                    if (a != null) setState(() => _rest = a);
                  },
                ),
              ),
              FormRow(
                'الدورة',
                ErpTextField(controller: _cycle, hint: 'اختياري'),
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
        ],
      ),
    );
  }
}
