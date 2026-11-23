// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/chart.dart';
import '../../accounting/ledger.dart';
import '../../accounting/money.dart';
import '../../accounting/reports.dart';
import '../../app_services.dart';
import '../erp_theme.dart';
import '../erp_widgets.dart';
import '../help.dart';
import '../ui_kit.dart';
import 'books_kit.dart';
import 'forms.dart';
import 'funds_page.dart';

const accountsHelp = [
  HelpItem(
    '',
    'شجرة الحسابات خمس مجموعات: الأصول، الخصوم، حقوق الملكية، الإيرادات، المصاريف. الحساب الرئيسي (مجموعة) يجمع أرصدة حساباته الفرعية ولا تُسجَّل عليه قيود.',
  ),
  HelpItem(
    '',
    'الرصيد بطبيعة الحساب: الأصول والمصاريف تزيد بالمدين، والخصوم وحقوق الملكية والإيرادات تزيد بالدائن.',
  ),
  HelpItem(
    '',
    'حسابات النظام يمكن تغيير أسمائها لا حذفها. الحساب الذي عليه قيود لا يُحذف، ويمكن أرشفته عندما يصبح رصيده صفرًا.',
  ),
  HelpItem(
    '',
    'أضف زبائنك تحت «الذمم المدينة (لنا)»، ومورديك تحت «الذمم الدائنة (علينا)»، وبنود مصاريفك تحت «مصاريف تشغيلية».',
  ),
];

class AccountsPage extends StatefulWidget {
  const AccountsPage({super.key});
  @override
  State<AccountsPage> createState() => _AccountsPageState();
}

class _AccountsPageState extends State<AccountsPage> {
  final _collapsed = <int>{};
  bool _hideEmpty = false;

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'شجرة الحسابات',
    help: accountsHelp,
    load: (s) => s.reports.tree(),
    fab:
        (context, _) => FloatingActionButton.extended(
          heroTag: 'account',
          onPressed: () => addAccountFlow(context),
          icon: const Icon(Icons.add),
          label: const Text('حساب جديد'),
        ),
    build: (context, data, reload) {
      final roots = data as List<AccountNode>;
      return [
        FormRows(
          onSurface: false,
          children: [
            FormRow(
              'إخفاء الحسابات بلا رصيد',
              Switch(
                value: _hideEmpty,
                onChanged: (v) => setState(() => _hideEmpty = v),
              ),
            ),
          ],
        ),
        for (final r in roots) ...[
          gap,
          SectionLabel(r.account.name, trailing: Money(r.balance)),
          GroupList(
            inset: 16,
            children: [
              for (final n in r.children)
                ..._rows(context, n, 0, _groupIcon(n.account)),
            ],
          ),
        ],
      ];
    },
  );

  /// The icon of the accounts under a top group: funds, customers,
  /// suppliers, stock… (by type otherwise).
  static IconData? _groupIcon(Account a) => switch (a.role) {
    Roles.funds => Icons.account_balance_wallet_outlined,
    Roles.receivables => Icons.person_outline,
    Roles.payables => Icons.storefront_outlined,
    Roles.inventory => Icons.inventory_2_outlined,
    Roles.salariesPayable => Icons.badge_outlined,
    _ => null,
  };

  List<Widget> _rows(
    BuildContext context,
    AccountNode n,
    int depth,
    IconData? icon,
  ) {
    if (_hideEmpty && n.isEmpty) return const [];
    final a = n.account;
    final open = !_collapsed.contains(a.id);
    return [
      Padding(
        padding: EdgeInsetsDirectional.only(start: depth * 18.0),
        child: ListRow(
          title: a.name,
          titleColor: a.archived ? Tw.ink3 : null,
          leading:
              a.isGroup
                  ? InkWell(
                    onTap:
                        () => setState(
                          () =>
                              open
                                  ? _collapsed.add(a.id)
                                  : _collapsed.remove(a.id),
                        ),
                    child: IconChip(
                      open ? Icons.folder_open_outlined : Icons.folder_outlined,
                      color: Tw.ink2,
                    ),
                  )
                  : IconChip(
                    icon ?? accountIcon(a),
                    color: Tw.accentInk,
                    bg: Tw.accentSoft,
                    size: 34,
                  ),
          subtitle: Text(
            '${a.code}${a.archived ? ' · مؤرشف' : ''}${a.isGroup ? ' · رئيسي' : ''}',
            textDirection: TextDirection.rtl,
          ),
          trailing: Money(n.balance, color: n.balance == 0 ? Tw.ink3 : null),
          onTap: () => showAccountSheet(context, a),
        ),
      ),
      if (open)
        for (final c in n.children)
          ..._rows(context, c, depth + 1, icon ?? _groupIcon(c.account)),
    ];
  }
}

/// Choose a parent group, then name the new account.
Future<void> addAccountFlow(BuildContext context, {Account? parent}) async {
  final p =
      parent ??
      await pickAccount(context, title: 'تحت أي حساب رئيسي؟', groups: true);
  if (p == null || !context.mounted) return;
  final name = await askName(
    context,
    'حساب جديد تحت «${p.name}»',
    hint: 'اسم الحساب',
  );
  if (name == null || !context.mounted) return;
  await runPosting(
    context,
    (s) => s.ledger.addAccount(name: name, parentId: p.id),
    done: 'أُضيف الحساب',
  );
}

/// The actions of one account.
Future<void> showAccountSheet(BuildContext context, Account a) async {
  final s = AppScope.read(context);
  final balance = await s.ledger.balanceOf(a.id);
  if (!context.mounted) return;
  await showAppSheet<void>(
    context,
    (ctx) => AppSheet(
      title: a.name,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '${a.code} · ${a.type.label}${a.isGroup ? ' · حساب رئيسي' : ''}${a.system ? ' · من حسابات النظام' : ''}',
            style: Ds.secondary,
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Text('الرصيد: ', style: Ds.secondary),
              Money(Reports.natural(a, balance)),
            ],
          ),
          const SizedBox(height: 12),
          ChoiceTile(
            icon: Icons.receipt_long_outlined,
            label: 'كشف الحساب',
            onTap: () {
              Navigator.pop(ctx);
              openPage(context, StatementPage(account: a));
            },
          ),
          if (a.isGroup)
            ChoiceTile(
              icon: Icons.add,
              label: 'إضافة حساب فرعي',
              onTap: () {
                Navigator.pop(ctx);
                addAccountFlow(context, parent: a);
              },
            ),
          ChoiceTile(
            icon: Icons.drive_file_rename_outline,
            label: 'تغيير الاسم',
            onTap: () async {
              Navigator.pop(ctx);
              final name = await askName(
                context,
                'اسم الحساب',
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
          if (!a.isGroup)
            ChoiceTile(
              icon:
                  a.archived
                      ? Icons.unarchive_outlined
                      : Icons.archive_outlined,
              label: a.archived ? 'إعادة من الأرشيف' : 'أرشفة',
              onTap: () async {
                Navigator.pop(ctx);
                await runPosting(
                  context,
                  (s) => s.ledger.setArchived(a.id, !a.archived),
                  done: 'تم',
                );
              },
            ),
          if (!a.system)
            ChoiceTile(
              icon: Icons.delete_outline,
              label: 'حذف الحساب',
              danger: true,
              onTap: () async {
                Navigator.pop(ctx);
                final ok = await confirmDialog(
                  context,
                  icon: Icons.delete_outline,
                  title: 'حذف «${a.name}»؟',
                  body:
                      'يُحذف الحساب فقط إن لم تكن عليه قيود ولا حسابات فرعية.',
                  confirmLabel: 'حذف',
                  confirmKind: ErpButtonKind.danger,
                );
                if (!ok || !context.mounted) return;
                await runPosting(
                  context,
                  (s) => s.ledger.deleteAccount(a.id),
                  done: 'حُذف الحساب',
                );
              },
            ),
        ],
      ),
    ),
  );
}

// --------------------------------------------------------------- statement

const statementHelp = [
  HelpItem(
    '',
    'كشف الحساب يعرض كل القيود على الحساب بترتيب التاريخ مع الرصيد بعد كل حركة. الرصيد المدوّر هو الرصيد قبل بداية الفترة.',
  ),
  HelpItem('', 'المبالغ بطبيعة الحساب: الموجب يزيد الرصيد والسالب ينقصه.'),
  HelpItem('', 'اضغط أي حركة لعرض قيدها كاملًا أو إلغائه.'),
];

class StatementPage extends StatefulWidget {
  const StatementPage({super.key, this.account});
  final Account? account;
  @override
  State<StatementPage> createState() => _StatementPageState();
}

class _StatementPageState extends State<StatementPage> {
  Account? _account;
  String? _from;
  String _to = Ledger.today();

  @override
  void initState() {
    super.initState();
    _account = widget.account;
  }

  @override
  Widget build(BuildContext context) => BooksPage(
    key: ValueKey('${_account?.id}|$_from|$_to'),
    title: 'كشف حساب',
    help: statementHelp,
    actions: (context, data) {
      final d = data as (Account, ({int opening, List<StatementLine> lines})?)?;
      final st = d?.$2;
      if (d == null || st == null) return const [];
      return [
        PdfButton(
          name: 'كشف ${d.$1.name}',
          build:
              (p, s) => p.statement(
                workspace: s.workspace.name,
                account: d.$1,
                from: _from,
                to: _to,
                opening: st.opening,
                lines: st.lines,
              ),
        ),
      ];
    },
    load: (s) async {
      final a = _account;
      if (a == null) return null;
      if (a.isGroup) return (a, null);
      return (a, await s.ledger.statement(a.id, from: _from, to: _to));
    },
    build: (context, data, reload) {
      final d = data as (Account, ({int opening, List<StatementLine> lines})?)?;
      final a = d?.$1;
      final st = d?.$2;
      final debitNormal = a?.type.debitNormal ?? true;
      int nat(int v) => debitNormal ? v : -v;
      final closing =
          st == null
              ? 0
              : (st.lines.isEmpty ? st.opening : st.lines.last.balance);
      final debit = st?.lines.fold(0, (n, l) => n + l.debit) ?? 0;
      final credit = st?.lines.fold(0, (n, l) => n + l.credit) ?? 0;
      return [
        FormRows(
          onSurface: false,
          children: [
            FormRow(
              'الحساب',
              PickerValue(
                text: a?.name ?? 'اختر الحساب',
                placeholder: a == null,
                onTap: () async {
                  final p = await pickAccount(
                    context,
                    title: 'الحساب',
                    selectedId: a?.id,
                  );
                  if (p != null) setState(() => _account = p);
                },
              ),
            ),
            FormRow(
              'من',
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (_from == null)
                    PickerValue(
                      text: 'البداية',
                      onTap:
                          () => setState(
                            () =>
                                _from = isoDate(
                                  DateTime(
                                    DateTime.now().year,
                                    DateTime.now().month,
                                  ),
                                ),
                          ),
                    )
                  else ...[
                    DateValue(
                      value: _from!,
                      onChanged: (v) => setState(() => _from = v),
                    ),
                    IconButton(
                      tooltip: 'من البداية',
                      onPressed: () => setState(() => _from = null),
                      icon: Icon(Icons.close, size: 18, color: Tw.ink3),
                    ),
                  ],
                ],
              ),
            ),
            FormRow(
              'إلى',
              DateValue(value: _to, onChanged: (v) => setState(() => _to = v)),
            ),
          ],
        ),
        if (a == null)
          const EmptyState(
            icon: Icons.receipt_long_outlined,
            title: 'اختر حسابًا',
            message: 'اختر الحساب الذي تريد كشفه.',
          )
        else if (st == null)
          const EmptyState(
            icon: Icons.folder_outlined,
            title: 'حساب رئيسي',
            message:
                'الكشف للحسابات الفرعية؛ رصيد الحساب الرئيسي في شجرة الحسابات.',
          )
        else ...[
          gap,
          FigsRow(
            figs: [
              (formatCentsShort(nat(st.opening)), 'رصيد مدوّر', null),
              (formatCentsShort(debit), 'مدين', null),
              (formatCentsShort(credit), 'دائن', null),
            ],
          ),
          gap,
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            decoration: panelDecoration(),
            child: Row(
              children: [
                Expanded(
                  child: Text('الرصيد في ${dateLabel(_to)}', style: Ds.body),
                ),
                Money(nat(closing), size: 20, weight: FontWeight.w800),
              ],
            ),
          ),
          gap,
          SectionLabel('الحركات', trailing: Text('${st.lines.length}')),
          if (st.lines.isEmpty)
            const EmptyState(
              icon: Icons.receipt_long_outlined,
              title: 'لا حركات',
              message: 'لا قيود على هذا الحساب في الفترة.',
            )
          else
            GroupList(
              children: [
                for (final l in st.lines.reversed)
                  StatementRow(line: l, debitNormal: debitNormal),
              ],
            ),
        ],
      ];
    },
  );
}
