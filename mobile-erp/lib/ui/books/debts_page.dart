// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/chart.dart';
import '../../accounting/money.dart';
import '../../accounting/parties.dart';
import '../erp_theme.dart';
import '../erp_widgets.dart';
import '../help.dart';
import '../ui_kit.dart';
import 'books_kit.dart';
import 'parties_pages.dart';

const debtsHelp = [
  HelpItem(
    '',
    '«لنا»: كل طرف رصيده مدين (هو مدين لنا)، و«علينا»: كل طرف رصيده دائن (نحن مدينون له)، من المعتمدين وشركات التحويل والوكالات والزبائن والموردين والأعضاء.',
  ),
  HelpItem(
    '',
    'تسجيل دين جديد يكون قيدًا متوازنًا: اختر الطرف ثم الحساب المقابل (صندوق أو إيراد أو طرف آخر).',
  ),
  HelpItem('', 'تسديد دين علينا من «مطلوب دفع» أو من ملف الطرف («دفع له»).'),
];

String groupLabel(String role) => PartyKindX.ofRole(role)?.plural ?? role;

class DebtsPage extends StatefulWidget {
  const DebtsPage({super.key, this.toUs = true});
  final bool toUs;
  @override
  State<DebtsPage> createState() => _DebtsPageState();
}

class _DebtsPageState extends State<DebtsPage> {
  late bool _toUs = widget.toUs;

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'الديون',
    help: debtsHelp,
    fab:
        (context, _) => FloatingActionButton.extended(
          heroTag: 'debt',
          onPressed: () => _register(context),
          icon: const Icon(Icons.add),
          label: const Text('تسجيل دين'),
        ),
    load: (s) => s.reports.partyBalances(),
    build: (context, data, reload) {
      final all =
          data as List<({Account account, String groupRole, int balance})>;
      final toUs = all.fold(0, (n, p) => n + (p.balance > 0 ? p.balance : 0));
      final toThem = all.fold(
        0,
        (n, p) => n + (p.balance < 0 ? -p.balance : 0),
      );
      final shown = [
        for (final p in all)
          if (_toUs ? p.balance > 0 : p.balance < 0) p,
      ]..sort((a, b) => b.balance.abs().compareTo(a.balance.abs()));
      final groups =
          <String, List<({Account account, String groupRole, int balance})>>{};
      for (final p in shown) {
        groups.putIfAbsent(p.groupRole, () => []).add(p);
      }
      return [
        FigsRow(
          figs: [
            (formatCentsShort(toUs), 'لنا', Tw.accentInk),
            (formatCentsShort(toThem), 'علينا', toThem > 0 ? Tw.danger : null),
            (formatCentsShort(toUs - toThem), 'الصافي', null),
          ],
        ),
        gap,
        SegmentedChoice(
          options: const ['دين لنا', 'دين علينا'],
          selected: _toUs ? 0 : 1,
          onChanged: (i) => setState(() => _toUs = i == 0),
        ),
        gap,
        if (shown.isEmpty)
          EmptyState(
            icon: Icons.handshake_outlined,
            title: _toUs ? 'لا ديون لنا' : 'لا ديون علينا',
            message: 'الأرصدة تظهر هنا بمجرد تسجيل عمليات على الأطراف.',
          )
        else
          for (final e in groups.entries) ...[
            SectionLabel(
              groupLabel(e.key),
              trailing: Money(
                e.value.fold(0, (n, p) => n + p.balance.abs()),
                size: 13.5,
              ),
            ),
            GroupList(
              children: [
                for (final p in e.value)
                  ListRow(
                    title: p.account.name,
                    leading: IconChip(
                      partyIcon(PartyKindX.ofRole(e.key) ?? PartyKind.customer),
                      color: _toUs ? Tw.accentInk : Tw.danger,
                      bg: _toUs ? Tw.accentSoft : Tw.dangerSoft,
                    ),
                    subtitle: Text(p.account.code),
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
            gap,
          ],
      ];
    },
  );

  Future<void> _register(BuildContext context) async {
    final p = await pickParty(context, title: 'الدين على / لـ');
    if (p == null || !context.mounted) return;
    final op = await showAppSheet<PartyOp>(
      context,
      (ctx) => AppSheet(
        title: p.name,
        child: Column(
          children: [
            ChoiceTile(
              icon: PartyOp.debtToUs.icon,
              label: 'دين لنا (هو مدين لنا)',
              onTap: () => Navigator.pop(ctx, PartyOp.debtToUs),
            ),
            ChoiceTile(
              icon: PartyOp.debtToThem.icon,
              label: 'دين علينا (نحن مدينون له)',
              onTap: () => Navigator.pop(ctx, PartyOp.debtToThem),
            ),
          ],
        ),
      ),
    );
    if (op == null || !context.mounted) return;
    await showPartyOpSheet(context, p, op);
  }
}

// ------------------------------------------------------------ payment due

const dueHelp = [
  HelpItem('', 'مطلوب دفع: المعتمدون والوكالات الفرعية الذين لهم رصيد علينا.'),
  HelpItem(
    '',
    '«تسليم المحدد» يدفع لكل من اخترته مبلغه من صندوق واحد في قيد واحد. (نظام الويب كان يصفّر هذه الديون دون أن يخرج المال من أي صندوق.)',
  ),
  HelpItem('', 'يمكن تعديل المبلغ لكل طرف لتسليم جزء منه.'),
];

class PaymentDuePage extends StatefulWidget {
  const PaymentDuePage({super.key});
  @override
  State<PaymentDuePage> createState() => _PaymentDuePageState();
}

class _PaymentDuePageState extends State<PaymentDuePage> {
  final _selected = <int>{};
  final _amounts = <int, TextEditingController>{};
  Account? _fund;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in _amounts.values) {
      c.dispose();
    }
    super.dispose();
  }

  TextEditingController _c(Party p) => _amounts.putIfAbsent(
    p.account.id,
    () => TextEditingController(
      text: formatCentsShort(p.toThem).replaceAll(',', ''),
    ),
  );

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'مطلوب دفع',
    help: dueHelp,
    load: (s) async {
      final due = await s.parties.paymentDue();
      final funds = await s.books.funds();
      return (due: due, funds: funds);
    },
    build: (context, data, reload) {
      final d =
          data
              as ({
                List<Party> due,
                List<({Account account, int balance})> funds,
              });
      _fund ??= d.funds.isEmpty ? null : d.funds.first.account;
      final fundBal =
          d.funds
              .where((f) => f.account.id == _fund?.id)
              .firstOrNull
              ?.balance ??
          0;
      final total = d.due.fold(0, (n, p) => n + p.toThem);
      var chosen = 0;
      for (final p in d.due) {
        if (_selected.contains(p.account.id)) {
          chosen += parseCents(_c(p).text) ?? 0;
        }
      }
      return [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: panelDecoration(radius: Ds.radiusL),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('مجموع المطلوب دفعه', style: Ds.secondary),
              Money(
                total,
                size: 30,
                weight: FontWeight.w800,
                color: total > 0 ? Tw.danger : null,
              ),
            ],
          ),
        ),
        gap,
        if (d.due.isEmpty)
          const EmptyState(
            icon: Icons.task_alt,
            title: 'لا شيء مطلوب دفعه',
            message: 'لا يوجد معتمد أو وكالة لهم رصيد علينا.',
          )
        else ...[
          SectionLabel(
            'اختر من تسلّمه',
            trailing: TextButton(
              onPressed:
                  () => setState(() {
                    if (_selected.length == d.due.length) {
                      _selected.clear();
                    } else {
                      _selected.addAll(d.due.map((p) => p.account.id));
                    }
                  }),
              child: Text(
                _selected.length == d.due.length ? 'إلغاء الكل' : 'تحديد الكل',
              ),
            ),
          ),
          GroupList(
            inset: 16,
            children: [
              for (final p in d.due)
                Padding(
                  padding: const EdgeInsetsDirectional.fromSTEB(4, 6, 12, 6),
                  child: Row(
                    children: [
                      Checkbox(
                        value: _selected.contains(p.account.id),
                        onChanged:
                            (v) => setState(
                              () =>
                                  v == true
                                      ? _selected.add(p.account.id)
                                      : _selected.remove(p.account.id),
                            ),
                      ),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              p.name,
                              style: Ds.body.copyWith(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            Text(
                              '${p.kind.label} · علينا ${formatCents(p.toThem)}',
                              style: Ds.secondary,
                            ),
                          ],
                        ),
                      ),
                      SizedBox(
                        width: 112,
                        child: ErpTextField(
                          controller: _c(p),
                          ltr: true,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
          gap,
          FormRows(
            onSurface: false,
            children: [
              FormRow(
                'من الصندوق',
                PickerValue(
                  text: _fund == null ? 'اختر' : _fund!.name,
                  placeholder: _fund == null,
                  onTap: () async {
                    final ids = {for (final f in d.funds) f.account.id};
                    final a = await pickAccount(
                      context,
                      title: 'الصندوق',
                      selectedId: _fund?.id,
                      where: (a) => ids.contains(a.id),
                    );
                    if (a != null) setState(() => _fund = a);
                  },
                ),
              ),
            ],
          ),
          Caption(
            'رصيد الصندوق ${formatCents(fundBal)}',
            color: chosen > fundBal ? Tw.danger : null,
          ),
          gap,
          ErpButton(
            label:
                _selected.isEmpty
                    ? 'تسليم المحدد'
                    : 'تسليم المحدد (${formatCents(chosen)})',
            icon: Icons.task_alt,
            loading: _busy,
            onPressed:
                _selected.isEmpty || _fund == null
                    ? null
                    : () async {
                      final amounts = <int, int>{};
                      for (final p in d.due) {
                        if (!_selected.contains(p.account.id)) continue;
                        final v = parseCents(_c(p).text) ?? 0;
                        if (v > p.toThem) {
                          showToast(
                            context,
                            'المبلغ لـ ${p.name} أكبر من المطلوب له',
                            ToastType.warning,
                          );
                          return;
                        }
                        amounts[p.account.id] = v;
                      }
                      setState(() => _busy = true);
                      final ok = await runPosting(
                        context,
                        (s) => s.parties.settle(amounts, fundId: _fund!.id),
                        done: 'تم التسليم',
                      );
                      if (!mounted) return;
                      setState(() {
                        _busy = false;
                        if (ok) {
                          _selected.clear();
                          for (final c in _amounts.values) {
                            c.dispose();
                          }
                          _amounts.clear();
                        }
                      });
                    },
          ),
        ],
      ];
    },
  );
}
