// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/books.dart';
import '../../accounting/chart.dart';
import '../../accounting/ledger.dart';
import '../../accounting/money.dart';
import '../erp_theme.dart';
import '../erp_widgets.dart';
import '../help.dart';
import '../ui_kit.dart';
import 'accounts_page.dart';
import 'books_kit.dart';
import 'forms.dart';

const fundsHelp = [
  HelpItem(
    '',
    'الصندوق حساب نقدية: صندوق المكتب، حساب بنكي، محفظة إلكترونية… رصيده مجموع كل القيود عليه.',
  ),
  HelpItem(
    '',
    'لا يُسمح أن ينزل رصيد صندوق تحت الصفر: سند الصرف والتحويل والمصروف تُرفض إن لم يكفِ الرصيد.',
  ),
  HelpItem(
    '',
    'اضغط صندوقًا لعرض كشفه والقبض والصرف والتحويل منه. الصندوق بلا رصيد يمكن أرشفته.',
  ),
];

class FundsPage extends StatelessWidget {
  const FundsPage({super.key});

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'الصناديق',
    help: fundsHelp,
    load: (s) => s.books.funds(),
    fab:
        (context, _) => FloatingActionButton.extended(
          heroTag: 'fund',
          onPressed: () => showNewFundSheet(context),
          icon: const Icon(Icons.add),
          label: const Text('صندوق جديد'),
        ),
    build: (context, data, reload) {
      final funds = data as List<FundBalance>;
      final total = funds.fold(0, (n, f) => n + f.balance);
      return [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: panelDecoration(radius: Ds.radiusL),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('إجمالي النقدية', style: Ds.secondary),
              const SizedBox(height: 4),
              Money(total, size: 30, weight: FontWeight.w800),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: ErpButton(
                      label: 'قبض',
                      icon: Icons.south_west,
                      height: 42,
                      kind: ErpButtonKind.indigoSoft,
                      onPressed:
                          () => showVoucherSheet(context, VoucherMode.receipt),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ErpButton(
                      label: 'صرف',
                      icon: Icons.north_east,
                      height: 42,
                      kind: ErpButtonKind.indigoSoft,
                      onPressed:
                          () => showVoucherSheet(context, VoucherMode.payment),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ErpButton(
                      label: 'تحويل',
                      icon: Icons.swap_horiz,
                      height: 42,
                      kind: ErpButtonKind.indigoSoft,
                      onPressed: () => showTransferSheet(context),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        gap,
        SectionLabel('الصناديق', trailing: Text('${funds.length}')),
        GroupList(
          children: [
            for (final f in funds)
              ListRow(
                title: f.account.name,
                leading: IconChip(
                  Icons.account_balance_wallet_outlined,
                  color: Tw.accentInk,
                  bg: Tw.accentSoft,
                ),
                subtitle: Text(
                  f.account.role == Roles.mainFund
                      ? 'الصندوق الرئيسي · ${f.account.code}'
                      : f.account.code,
                ),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Money(f.balance, color: f.balance < 0 ? Tw.danger : null),
                    const RowChevron(),
                  ],
                ),
                onTap: () => openPage(context, FundPage(fund: f.account)),
              ),
          ],
        ),
      ];
    },
  );
}

/// One fund: balance, actions and its statement.
class FundPage extends StatelessWidget {
  const FundPage({super.key, required this.fund});
  final Account fund;

  @override
  Widget build(BuildContext context) => BooksPage(
    title: fund.name,
    help: fundsHelp,
    load:
        (s) async => (
          account: await s.ledger.account(fund.id),
          st: await s.ledger.statement(fund.id),
        ),
    build: (context, data, reload) {
      final d =
          data
              as ({
                Account? account,
                ({int opening, List<StatementLine> lines}) st,
              });
      final a = d.account ?? fund;
      final lines = d.st.lines.reversed.toList();
      final balance =
          d.st.lines.isEmpty ? d.st.opening : d.st.lines.last.balance;
      return [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: panelDecoration(radius: Ds.radiusL),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('الرصيد', style: Ds.secondary),
              const SizedBox(height: 4),
              Money(balance, size: 30, weight: FontWeight.w800),
              if (a.archived) ...[
                const SizedBox(height: 8),
                const StatusBadge('مؤرشف', small: true),
              ],
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: ErpButton(
                      label: 'قبض',
                      icon: Icons.south_west,
                      height: 42,
                      kind: ErpButtonKind.indigoSoft,
                      onPressed:
                          a.archived
                              ? null
                              : () => showVoucherSheet(
                                context,
                                VoucherMode.receipt,
                                fundId: a.id,
                              ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ErpButton(
                      label: 'صرف',
                      icon: Icons.north_east,
                      height: 42,
                      kind: ErpButtonKind.indigoSoft,
                      onPressed:
                          a.archived
                              ? null
                              : () => showVoucherSheet(
                                context,
                                VoucherMode.payment,
                                fundId: a.id,
                              ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ErpButton(
                      label: 'تحويل',
                      icon: Icons.swap_horiz,
                      height: 42,
                      kind: ErpButtonKind.indigoSoft,
                      onPressed:
                          a.archived
                              ? null
                              : () => showTransferSheet(context, fromId: a.id),
                    ),
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
              icon: Icons.drive_file_rename_outline,
              title: 'تغيير الاسم',
              onTap: () async {
                final name = await askName(
                  context,
                  'اسم الصندوق',
                  initial: a.name,
                );
                if (name == null || !context.mounted) return;
                await runPosting(
                  context,
                  (s) => s.ledger.renameAccount(a.id, name),
                  done: 'تم',
                );
              },
            ),
            HubRow(
              icon:
                  a.archived
                      ? Icons.unarchive_outlined
                      : Icons.archive_outlined,
              title: a.archived ? 'إعادة من الأرشيف' : 'أرشفة الصندوق',
              subtitle: a.archived ? null : 'عندما يصبح رصيده صفرًا',
              onTap:
                  () => runPosting(
                    context,
                    (s) => s.ledger.setArchived(a.id, !a.archived),
                    done: 'تم',
                  ),
            ),
            HubRow(
              icon: Icons.receipt_long_outlined,
              title: 'كشف الحساب بفترة',
              onTap: () => openPage(context, StatementPage(account: a)),
            ),
          ],
        ),
        gap,
        SectionLabel('الحركات', trailing: Text('${lines.length}')),
        if (lines.isEmpty)
          const EmptyState(
            icon: Icons.receipt_long_outlined,
            title: 'لا حركات',
            message: 'كل قبض أو صرف أو تحويل على هذا الصندوق يظهر هنا.',
          )
        else
          GroupList(
            children: [for (final l in lines.take(200)) StatementRow(line: l)],
          ),
      ];
    },
  );
}

/// A statement line: memo, date, movement and the running balance.
class StatementRow extends StatelessWidget {
  const StatementRow({
    super.key,
    required this.line,
    this.natural = true,
    this.debitNormal = true,
  });
  final StatementLine line;
  final bool natural;
  final bool debitNormal;

  @override
  Widget build(BuildContext context) {
    final l = line;
    final move = l.debit - l.credit;
    final shownBalance = debitNormal ? l.balance : -l.balance;
    return ListRow(
      title: l.memo,
      titleColor: l.reversed || l.kind == EntryKind.reversal ? Tw.ink3 : null,
      subtitle: Text(
        '${dateLabel(l.date)} · #${l.number}${l.reversed ? ' · مُلغى' : ''}',
        maxLines: 1,
      ),
      trailing: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Money(debitNormal ? move : -move, signColor: true),
          Text(
            formatCents(shownBalance),
            textDirection: TextDirection.ltr,
            style: Ds.secondary.copyWith(fontSize: 12.5),
          ),
        ],
      ),
      onTap: () => showEntrySheet(context, l.entryId),
    );
  }
}

// ---------------------------------------------------------------- expenses

const expensesHelp = [
  HelpItem(
    '',
    'المصروف يُقيَّد على بند من بنود «مصاريف تشغيلية» ويُدفع من صندوق، أو بالآجل على حساب مورد/دائن.',
  ),
  HelpItem(
    '',
    'البنود حسابات في الشجرة؛ أضف ما تحتاجه من «إدارة البنود». مجموع المصاريف يظهر في قائمة الدخل.',
  ),
  HelpItem(
    '',
    'لحذف مصروف افتحه واضغط «إلغاء القيد»: يُسجَّل قيد عكسي ويعود المبلغ إلى الصندوق.',
  ),
];

class ExpensesPage extends StatefulWidget {
  const ExpensesPage({super.key});
  @override
  State<ExpensesPage> createState() => _ExpensesPageState();
}

class _ExpensesPageState extends State<ExpensesPage> {
  int _range = 0; // this month, last month, this year, all

  (String?, String?) get _dates {
    final now = DateTime.now();
    return switch (_range) {
      0 => (isoDate(DateTime(now.year, now.month)), null),
      1 => (
        isoDate(DateTime(now.year, now.month - 1)),
        isoDate(DateTime(now.year, now.month, 0)),
      ),
      2 => (isoDate(DateTime(now.year)), null),
      _ => (null, null),
    };
  }

  @override
  Widget build(BuildContext context) => BooksPage(
    key: ValueKey(_range),
    title: 'المصاريف',
    help: expensesHelp,
    fab:
        (context, _) => FloatingActionButton.extended(
          heroTag: 'expense',
          onPressed: () => showExpenseSheet(context),
          icon: const Icon(Icons.add),
          label: const Text('مصروف'),
        ),
    load: (s) async {
      final (from, to) = _dates;
      final cats = await s.books.expenseCategories();
      final all = await s.ledger.accounts(archived: true);
      final expenseIds = {
        for (final a in all)
          if (a.type == AccountType.expense) a.id,
      };
      final b = await s.ledger.balances(from: from, to: to);
      final entries = await s.ledger.entries(
        from: from,
        to: to,
        kind: EntryKind.expense,
        limit: 300,
      );
      return (
        cats: cats,
        all: all,
        expenseIds: expenseIds,
        b: b,
        entries: entries,
      );
    },
    build: (context, data, reload) {
      final d =
          data
              as ({
                List<Account> cats,
                List<Account> all,
                Set<int> expenseIds,
                Map<int, int> b,
                List<JournalEntry> entries,
              });
      final byCat = [
        for (final a in d.all)
          if (d.expenseIds.contains(a.id) &&
              !a.isGroup &&
              (d.b[a.id] ?? 0) != 0)
            (a, d.b[a.id]!),
      ]..sort((x, y) => y.$2.compareTo(x.$2));
      final total = byCat.fold(0, (n, x) => n + x.$2);
      return [
        SegmentedChoice(
          options: const ['هذا الشهر', 'الماضي', 'هذه السنة', 'الكل'],
          selected: _range,
          onChanged: (i) => setState(() => _range = i),
        ),
        gap,
        Container(
          padding: const EdgeInsets.all(20),
          decoration: panelDecoration(radius: Ds.radiusL),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('إجمالي المصاريف', style: Ds.secondary),
              const SizedBox(height: 4),
              Money(total, size: 30, weight: FontWeight.w800),
            ],
          ),
        ),
        if (byCat.isNotEmpty) ...[
          gap,
          const SectionLabel('حسب البند'),
          GroupList(
            children: [
              for (final (a, v) in byCat)
                ListRow(
                  title: a.name,
                  leading: IconChip(
                    Icons.trending_down,
                    color: Tw.warn,
                    bg: Tw.warnSoft,
                  ),
                  subtitle: Text(
                    total == 0
                        ? ''
                        : '${(v * 100 / total).toStringAsFixed(0)}٪',
                  ),
                  trailing: Money(v),
                  onTap: () => openPage(context, StatementPage(account: a)),
                ),
            ],
          ),
        ],
        gap,
        SectionLabel(
          'المصاريف المسجلة',
          trailing: TextButton.icon(
            onPressed: () => _manageCategories(context, d.cats),
            icon: const Icon(Icons.tune, size: 17),
            label: const Text('إدارة البنود'),
          ),
        ),
        if (d.entries.isEmpty)
          const EmptyState(
            icon: Icons.receipt_long_outlined,
            title: 'لا مصاريف',
            message: 'سجّل أول مصروف من الزر في الأسفل.',
          )
        else
          GroupList(children: [for (final e in d.entries) EntryRow(entry: e)]),
      ];
    },
  );

  Future<void> _manageCategories(
    BuildContext context,
    List<Account> cats,
  ) async {
    await showAppSheet<void>(
      context,
      (ctx) => AppSheet(
        title: 'بنود المصاريف',
        footer: ErpButton(
          label: 'بند جديد',
          icon: Icons.add,
          onPressed: () async {
            final name = await askName(
              ctx,
              'بند مصروف جديد',
              hint: 'مثال: كهرباء',
            );
            if (name == null || !ctx.mounted) return;
            final ok = await runPosting(
              ctx,
              (s) => s.books.addExpenseCategory(name),
              done: 'أُضيف البند',
            );
            if (ok && ctx.mounted) Navigator.pop(ctx);
          },
        ),
        child: Column(
          children: [
            for (final c in cats)
              ChoiceTile(
                icon: Icons.label_outline,
                label: c.name,
                tail: Text(c.code, textDirection: TextDirection.ltr),
                onTap: () async {
                  final name = await askName(ctx, 'اسم البند', initial: c.name);
                  if (name == null || !ctx.mounted) return;
                  final ok = await runPosting(
                    ctx,
                    (s) => s.ledger.renameAccount(c.id, name),
                    done: 'تم',
                  );
                  if (ok && ctx.mounted) Navigator.pop(ctx);
                },
              ),
          ],
        ),
      ),
    );
  }
}
