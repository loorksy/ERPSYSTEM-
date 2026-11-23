// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/chart.dart';
import '../../accounting/ledger.dart';
import '../../accounting/money.dart';
import '../erp_theme.dart';
import '../erp_widgets.dart';
import '../help.dart';
import '../shell.dart';
import '../ui_kit.dart';
import 'books_kit.dart';

const journalHelp = [
  HelpItem(
    '',
    'دفتر القيود (اليومية) فيه كل قيد سُجّل بأي طريقة: سند قبض أو صرف، تحويل، مصروف، رصيد افتتاحي أو قيد يدوي.',
  ),
  HelpItem(
    '',
    'القيد لا يُعدَّل ولا يُحذف بعد تسجيله؛ الإلغاء قيد عكسي يعيد الأرصدة ويبقى القيدان ظاهرين، وهذا ما يجعل التقارير متطابقة دائمًا.',
  ),
];

class JournalPage extends StatefulWidget {
  const JournalPage({super.key, this.category = 0, this.title = 'دفتر القيود'});

  /// 0 all, 1 cash (funds), 2 parties, 3 revenue and expenses.
  final int category;
  final String title;
  @override
  State<JournalPage> createState() => _JournalPageState();
}

class _JournalPageState extends State<JournalPage> {
  String? _kind;
  int _limit = 60;
  late int _category = widget.category;

  static const _categories = [
    'الكل',
    'حركات نقدية',
    'الأطراف',
    'أرباح ومصاريف',
  ];

  static const _kinds = <String?>[
    null,
    EntryKind.receipt,
    EntryKind.payment,
    EntryKind.expense,
    EntryKind.transfer,
    EntryKind.manual,
    EntryKind.opening,
    EntryKind.reversal,
  ];

  @override
  Widget build(BuildContext context) => BooksPage(
    key: ValueKey('$_kind|$_limit|$_category'),
    title: widget.title,
    help: journalHelp,
    fab:
        (context, _) => FloatingActionButton.extended(
          heroTag: 'entry',
          onPressed: () => openPage(context, const ManualEntryPage()),
          icon: const Icon(Icons.add),
          label: const Text('قيد يدوي'),
        ),
    load: (s) async {
      Set<int>? any;
      if (_category == 1) {
        any = {
          for (final f in await s.books.funds(archived: true)) f.account.id,
        };
      } else if (_category == 2) {
        any = {for (final p in await s.reports.partyBalances()) p.account.id};
      } else if (_category == 3) {
        any = {
          for (final a in await s.ledger.accounts(archived: true))
            if (a.type == AccountType.revenue || a.type == AccountType.expense)
              a.id,
        };
      }
      return s.ledger.entries(kind: _kind, anyAccount: any, limit: _limit + 1);
    },
    build: (context, data, reload) {
      final list = data as List<JournalEntry>;
      final more = list.length > _limit;
      final shown = more ? list.sublist(0, _limit) : list;
      return [
        SegmentedChoice(
          options: _categories,
          selected: _category,
          onChanged:
              (i) => setState(() {
                _category = i;
                _limit = 60;
              }),
        ),
        const SizedBox(height: 10),
        SizedBox(
          height: 40,
          child: ListView(
            scrollDirection: Axis.horizontal,
            children: [
              for (final k in _kinds)
                Padding(
                  padding: const EdgeInsetsDirectional.only(end: 6),
                  child: FilterPill(
                    label: k == null ? 'الكل' : EntryKind.label(k),
                    count: '',
                    selected: _kind == k,
                    onTap:
                        () => setState(() {
                          _kind = k;
                          _limit = 60;
                        }),
                  ),
                ),
            ],
          ),
        ),
        gap,
        if (shown.isEmpty)
          const EmptyState(
            icon: Icons.menu_book_outlined,
            title: 'لا قيود',
            message: 'القيود تظهر هنا بمجرد تسجيل أي عملية.',
          )
        else
          GroupList(children: [for (final e in shown) EntryRow(entry: e)]),
        if (more) ...[
          gap,
          ErpButton(
            label: 'عرض المزيد',
            kind: ErpButtonKind.soft,
            onPressed: () => setState(() => _limit += 100),
          ),
        ],
      ];
    },
  );
}

// ------------------------------------------------------------ manual entry

const manualHelp = [
  HelpItem(
    '',
    'القيد اليدوي لأي عملية لا يغطيها سند جاهز: تسوية، إثبات دين، إقفال أرباح إلى الأرباح المحتجزة…',
  ),
  HelpItem(
    '',
    'كل سطر حساب ومبلغ مدين أو دائن. لا يُحفظ القيد إلا إذا تساوى مجموع المدين مع مجموع الدائن.',
  ),
];

class _Line {
  Account? account;
  final debit = TextEditingController();
  final credit = TextEditingController();
  final memo = TextEditingController();
  void dispose() {
    debit.dispose();
    credit.dispose();
    memo.dispose();
  }
}

class ManualEntryPage extends StatefulWidget {
  const ManualEntryPage({super.key});
  @override
  State<ManualEntryPage> createState() => _ManualEntryPageState();
}

class _ManualEntryPageState extends State<ManualEntryPage> {
  final _memo = TextEditingController();
  final _lines = [_Line(), _Line()];
  String _date = Ledger.today();
  bool _busy = false;

  @override
  void dispose() {
    _memo.dispose();
    for (final l in _lines) {
      l.dispose();
    }
    super.dispose();
  }

  int _sum(TextEditingController Function(_Line) f) =>
      _lines.fold(0, (n, l) => n + (parseCents(f(l).text) ?? 0));

  Future<void> _save() async {
    final lines = <JournalLine>[];
    for (final l in _lines) {
      final d = parseCents(l.debit.text) ?? 0;
      final c = parseCents(l.credit.text) ?? 0;
      if (d == 0 && c == 0) continue;
      if (l.account == null) {
        showToast(context, 'اختر الحساب في كل سطر فيه مبلغ', ToastType.warning);
        return;
      }
      lines.add(
        JournalLine(
          accountId: l.account!.id,
          debit: d,
          credit: c,
          memo: l.memo.text.trim(),
        ),
      );
    }
    setState(() => _busy = true);
    final ok = await runPosting(
      context,
      (s) => s.ledger.post(
        EntryDraft(date: _date, memo: _memo.text, lines: lines),
      ),
      done: 'سُجّل القيد',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final d = _sum((l) => l.debit);
    final c = _sum((l) => l.credit);
    final balanced = d == c && d > 0;
    return Scaffold(
      backgroundColor: Tw.paper,
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.only(bottom: 40),
          children: [
            ScreenHeader(title: 'قيد يدوي', help: () => manualHelp),
            Padding(
              padding: Ds.pagePadding,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FormRows(
                    onSurface: false,
                    children: [
                      FormRow(
                        'التاريخ',
                        DateValue(
                          value: _date,
                          onChanged: (v) => setState(() => _date = v),
                        ),
                      ),
                      FormRow(
                        'البيان',
                        ErpTextField(controller: _memo, hint: 'بيان القيد'),
                        block: true,
                      ),
                    ],
                  ),
                  for (var i = 0; i < _lines.length; i++) ...[
                    gap,
                    _lineCard(i),
                  ],
                  gap,
                  ErpButton(
                    label: 'سطر جديد',
                    icon: Icons.add,
                    kind: ErpButtonKind.indigoSoft,
                    onPressed: () => setState(() => _lines.add(_Line())),
                  ),
                  gap,
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: panelDecoration(
                      color: balanced ? Tw.accentSoft : Tw.warnSoft,
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            balanced
                                ? 'القيد متوازن'
                                : 'الفرق ${formatCents((d - c).abs())}',
                            style: TextStyle(
                              fontWeight: FontWeight.w800,
                              color: balanced ? Tw.accentInk : Tw.warn,
                            ),
                          ),
                        ),
                        Text('مدين ', style: Ds.secondary),
                        Money(d),
                        const SizedBox(width: 12),
                        Text('دائن ', style: Ds.secondary),
                        Money(c),
                      ],
                    ),
                  ),
                  gap,
                  ErpButton(
                    label: 'تسجيل القيد',
                    icon: Icons.check,
                    loading: _busy,
                    onPressed: balanced ? _save : null,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _lineCard(int i) {
    final l = _lines[i];
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 8, 8, 14),
      decoration: panelDecoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text('سطر ${i + 1}', style: Ds.label),
              const Spacer(),
              PickerValue(
                text: l.account?.name ?? 'اختر الحساب',
                placeholder: l.account == null,
                onTap: () async {
                  final a = await pickAccount(
                    context,
                    title: 'حساب السطر ${i + 1}',
                    selectedId: l.account?.id,
                  );
                  if (a != null) setState(() => l.account = a);
                },
              ),
              if (_lines.length > 2)
                IconButton(
                  tooltip: 'حذف السطر',
                  onPressed: () => setState(() => _lines.removeAt(i).dispose()),
                  icon: Icon(Icons.close, size: 18, color: Tw.ink3),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('مدين', style: Ds.secondary),
                    const SizedBox(height: 4),
                    _SmallAmount(
                      controller: l.debit,
                      onChanged: (_) {
                        if (l.debit.text.isNotEmpty) l.credit.clear();
                        setState(() {});
                      },
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('دائن', style: Ds.secondary),
                    const SizedBox(height: 4),
                    _SmallAmount(
                      controller: l.credit,
                      onChanged: (_) {
                        if (l.credit.text.isNotEmpty) l.debit.clear();
                        setState(() {});
                      },
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ErpTextField(controller: l.memo, hint: 'بيان السطر (اختياري)'),
        ],
      ),
    );
  }
}

class _SmallAmount extends StatelessWidget {
  const _SmallAmount({required this.controller, required this.onChanged});
  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  @override
  Widget build(BuildContext context) => ErpTextField(
    controller: controller,
    hint: '0.00',
    ltr: true,
    keyboardType: const TextInputType.numberWithOptions(decimal: true),
    onChanged: onChanged,
  );
}

// -------------------------------------------------------- opening balances

const openingHelp = [
  HelpItem(
    '',
    'الأرصدة الافتتاحية تنقل ما عندك اليوم إلى النظام: النقدية في كل صندوق، وما لك عند الزبائن، وما عليك للموردين، والمخزون.',
  ),
  HelpItem(
    '',
    'يُسجَّل قيد افتتاحي واحد، والفرق بين ما لك وما عليك يذهب إلى «أرصدة افتتاحية» ضمن حقوق الملكية (صافي رأس مالك في البداية).',
  ),
  HelpItem(
    '',
    'أضف الزبائن والموردين أولًا من شجرة الحسابات، ثم اكتب أرصدتهم هنا. يمكن تسجيل قيد افتتاحي آخر لاحقًا لما نسيته.',
  ),
];

class OpeningBalancesPage extends StatefulWidget {
  const OpeningBalancesPage({super.key});
  @override
  State<OpeningBalancesPage> createState() => _OpeningBalancesPageState();
}

class _OpeningBalancesPageState extends State<OpeningBalancesPage> {
  final _amounts = <int, TextEditingController>{};
  String _date = Ledger.today();
  bool _busy = false;

  @override
  void dispose() {
    for (final c in _amounts.values) {
      c.dispose();
    }
    super.dispose();
  }

  TextEditingController _c(int id) =>
      _amounts.putIfAbsent(id, TextEditingController.new);

  Future<void> _save(List<Account> accounts) async {
    final map = <int, int>{};
    for (final a in accounts) {
      final v = parseCents(_c(a.id).text) ?? 0;
      if (v == 0) continue;
      if (v < 0) {
        showToast(
          context,
          'اكتب المبالغ موجبة: الجهة تحددها مجموعة الحساب',
          ToastType.warning,
        );
        return;
      }
      map[a.id] = a.type.debitNormal ? v : -v;
    }
    setState(() => _busy = true);
    final ok = await runPosting(
      context,
      (s) => s.books.openingBalances(map, date: _date),
      done: 'سُجّلت الأرصدة الافتتاحية',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'الأرصدة الافتتاحية',
    help: openingHelp,
    load: (s) async {
      final all = await s.ledger.accounts();
      return [
        for (final a in all)
          if (!a.isGroup &&
              (a.type == AccountType.asset ||
                  a.type == AccountType.liability ||
                  a.role == Roles.capital))
            a,
      ];
    },
    build: (context, data, reload) {
      final accounts = data as List<Account>;
      int sumOf(bool assets) => accounts
          .where((a) => a.type.debitNormal == assets)
          .fold(0, (n, a) => n + (parseCents(_c(a.id).text) ?? 0));
      final have = sumOf(true);
      final owe = sumOf(false);
      Widget group(String title, Iterable<Account> list) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SectionLabel(title),
          FormRows(
            onSurface: false,
            children: [
              for (final a in list)
                FormRow(
                  a.name,
                  SizedBox(
                    width: 150,
                    child: ErpTextField(
                      controller: _c(a.id),
                      hint: '0.00',
                      ltr: true,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      onChanged: (_) => setState(() {}),
                    ),
                  ),
                ),
            ],
          ),
        ],
      );
      return [
        FormRows(
          onSurface: false,
          children: [
            FormRow(
              'تاريخ الأرصدة',
              DateValue(
                value: _date,
                onChanged: (v) => setState(() => _date = v),
              ),
            ),
          ],
        ),
        gap,
        group(
          'ما لك (أصول): صناديق، زبائن، مخزون',
          accounts.where((a) => a.type == AccountType.asset),
        ),
        gap,
        group(
          'ما عليك (خصوم) ورأس المال',
          accounts.where((a) => a.type != AccountType.asset),
        ),
        gap,
        FigsRow(
          figs: [
            (formatCentsShort(have), 'لك', null),
            (formatCentsShort(owe), 'عليك', null),
            (
              formatCentsShort(have - owe),
              'إلى «أرصدة افتتاحية»',
              Tw.accentInk,
            ),
          ],
        ),
        gap,
        ErpButton(
          label: 'تسجيل القيد الافتتاحي',
          icon: Icons.flag_outlined,
          loading: _busy,
          onPressed: have == 0 && owe == 0 ? null : () => _save(accounts),
        ),
        const Caption(
          'لإضافة زبون أو مورد غير موجود في القائمة: شجرة الحسابات ← حساب جديد.',
        ),
      ];
    },
  );
}
