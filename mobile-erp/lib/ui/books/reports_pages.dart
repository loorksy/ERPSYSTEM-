// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/chart.dart';
import '../../accounting/ledger.dart';
import '../../accounting/money.dart';
import '../../accounting/reports.dart';
import '../erp_theme.dart';
import '../help.dart';
import '../ui_kit.dart';
import 'accounts_page.dart';
import 'books_kit.dart';

/// A period for the reports: this month, last month, this year, all, or
/// custom dates.
class Period {
  const Period(this.from, this.to);
  final String? from;
  final String to;

  static Period preset(int i) {
    final now = DateTime.now();
    final today = isoDate(now);
    return switch (i) {
      0 => Period(isoDate(DateTime(now.year, now.month)), today),
      1 => Period(
        isoDate(DateTime(now.year, now.month - 1)),
        isoDate(DateTime(now.year, now.month, 0)),
      ),
      2 => Period(isoDate(DateTime(now.year)), today),
      _ => Period(null, today),
    };
  }

  String get label =>
      from == null
          ? 'حتى ${dateLabel(to)}'
          : '${dateLabel(from!)} — ${dateLabel(to)}';
}

class PeriodPicker extends StatelessWidget {
  const PeriodPicker({
    super.key,
    required this.preset,
    required this.period,
    required this.onChanged,
  });
  final int preset;
  final Period period;
  final void Function(int preset, Period period) onChanged;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      SegmentedChoice(
        options: const ['هذا الشهر', 'الماضي', 'السنة', 'الكل', 'تاريخ'],
        selected: preset,
        onChanged: (i) => onChanged(i, i == 4 ? period : Period.preset(i)),
      ),
      if (preset == 4) ...[
        const SizedBox(height: 8),
        FormRows(
          onSurface: false,
          children: [
            FormRow(
              'من',
              DateValue(
                value: period.from ?? isoDate(DateTime(DateTime.now().year)),
                onChanged: (v) => onChanged(4, Period(v, period.to)),
              ),
            ),
            FormRow(
              'إلى',
              DateValue(
                value: period.to,
                onChanged: (v) => onChanged(4, Period(period.from, v)),
              ),
            ),
          ],
        ),
      ] else
        Caption(period.label, center: true),
    ],
  );
}

/// The rows of a report section: each account with its balance, children
/// indented; empty accounts hidden.
List<Widget> nodeRows(
  BuildContext context,
  AccountNode n, {
  int depth = 0,
  bool self = false,
}) {
  if (n.isEmpty) return const [];
  return [
    if (self || depth > 0)
      Padding(
        padding: EdgeInsetsDirectional.only(
          start: 16 + (depth - (self ? 0 : 1)) * 16.0,
          end: 16,
          top: 10,
          bottom: 10,
        ),
        child: Row(
          children: [
            Expanded(
              child: InkWell(
                onTap:
                    n.account.isGroup || n.account.id < 0
                        ? null
                        : () => openPage(
                          context,
                          StatementPage(account: n.account),
                        ),
                child: Text(
                  n.account.name,
                  style:
                      n.account.isGroup
                          ? Ds.body.copyWith(fontWeight: FontWeight.w700)
                          : Ds.body,
                ),
              ),
            ),
            Money(
              n.balance,
              weight: n.account.isGroup ? FontWeight.w800 : FontWeight.w600,
            ),
          ],
        ),
      ),
    for (final c in n.children) ...nodeRows(context, c, depth: depth + 1),
  ];
}

/// A report block: rows in a surface and a total line.
class ReportBlock extends StatelessWidget {
  const ReportBlock({
    super.key,
    required this.title,
    required this.rows,
    required this.total,
    this.totalLabel,
  });
  final String title;
  final List<Widget> rows;
  final int total;
  final String? totalLabel;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      SectionLabel(title),
      Container(
        decoration: panelDecoration(),
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (rows.isEmpty)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text('لا أرصدة', style: Ds.secondary),
              )
            else
              ...rows,
            Divider(height: 1, color: Tw.rule),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(totalLabel ?? 'الإجمالي', style: Ds.label),
                  ),
                  Money(total, size: 16.5, weight: FontWeight.w800),
                ],
              ),
            ),
          ],
        ),
      ),
    ],
  );
}

// ------------------------------------------------------------ income

const incomeHelp = [
  HelpItem(
    '',
    'قائمة الدخل (الأرباح والخسائر) للفترة: كل الإيرادات ناقص كل المصاريف = صافي الربح.',
  ),
  HelpItem(
    '',
    'الأرقام من القيود مباشرة، فهي نفسها في اللوحة الرئيسية والميزانية، ولا يوجد «صندوق ربح» منفصل قد يختلف عنها.',
  ),
];

class IncomeStatementPage extends StatefulWidget {
  const IncomeStatementPage({super.key});
  @override
  State<IncomeStatementPage> createState() => _IncomeStatementPageState();
}

class _IncomeStatementPageState extends State<IncomeStatementPage> {
  int _preset = 0;
  Period _period = Period.preset(0);

  @override
  Widget build(BuildContext context) => BooksPage(
    key: ValueKey('${_period.from}|${_period.to}'),
    title: 'قائمة الدخل',
    help: incomeHelp,
    load: (s) => s.reports.incomeStatement(from: _period.from, to: _period.to),
    build: (context, data, reload) {
      final r = data as IncomeStatement;
      final profit = r.net >= 0;
      return [
        PeriodPicker(
          preset: _preset,
          period: _period,
          onChanged:
              (i, p) => setState(() {
                _preset = i;
                _period = p;
              }),
        ),
        gap,
        ReportBlock(
          title: 'الإيرادات',
          rows: nodeRows(context, r.revenue),
          total: r.revenue.balance,
          totalLabel: 'إجمالي الإيرادات',
        ),
        gap,
        ReportBlock(
          title: 'المصاريف',
          rows: nodeRows(context, r.expenses),
          total: r.expenses.balance,
          totalLabel: 'إجمالي المصاريف',
        ),
        gap,
        Container(
          padding: const EdgeInsets.all(20),
          decoration: panelDecoration(
            radius: Ds.radiusL,
            color: profit ? Tw.accentSoft : Tw.dangerSoft,
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  profit ? 'صافي الربح' : 'صافي الخسارة',
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w800,
                    color: profit ? Tw.accentInk : Tw.danger,
                  ),
                ),
              ),
              Money(
                r.net.abs(),
                size: 24,
                weight: FontWeight.w800,
                color: profit ? Tw.accentInk : Tw.danger,
              ),
            ],
          ),
        ),
      ];
    },
  );
}

// ------------------------------------------------------- balance sheet

const balanceHelp = [
  HelpItem(
    '',
    'الميزانية العمومية في تاريخ: ما تملكه (الأصول) = ما عليك (الخصوم) + حقوق الملكية.',
  ),
  HelpItem(
    '',
    'أرباح الفترات غير المقفلة تظهر في حقوق الملكية باسم «صافي الربح غير المرحّل»، فتتوازن الميزانية دائمًا.',
  ),
];

class BalanceSheetPage extends StatefulWidget {
  const BalanceSheetPage({super.key});
  @override
  State<BalanceSheetPage> createState() => _BalanceSheetPageState();
}

class _BalanceSheetPageState extends State<BalanceSheetPage> {
  String _date = Ledger.today();

  @override
  Widget build(BuildContext context) => BooksPage(
    key: ValueKey(_date),
    title: 'الميزانية العمومية',
    help: balanceHelp,
    load: (s) => s.reports.balanceSheet(date: _date),
    build: (context, data, reload) {
      final r = data as BalanceSheet;
      return [
        FormRows(
          onSurface: false,
          children: [
            FormRow(
              'في تاريخ',
              DateValue(
                value: _date,
                onChanged: (v) => setState(() => _date = v),
              ),
            ),
          ],
        ),
        gap,
        ReportBlock(
          title: 'الأصول',
          rows: nodeRows(context, r.assets),
          total: r.assets.balance,
          totalLabel: 'إجمالي الأصول',
        ),
        gap,
        ReportBlock(
          title: 'الخصوم',
          rows: nodeRows(context, r.liabilities),
          total: r.liabilities.balance,
          totalLabel: 'إجمالي الخصوم',
        ),
        gap,
        ReportBlock(
          title: 'حقوق الملكية',
          rows: [
            ...nodeRows(context, r.equity),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(
                children: [
                  Expanded(
                    child: Text('صافي الربح غير المرحّل', style: Ds.body),
                  ),
                  Money(r.earnings, weight: FontWeight.w600),
                ],
              ),
            ),
          ],
          total: r.equityTotal,
          totalLabel: 'إجمالي حقوق الملكية',
        ),
        gap,
        Container(
          padding: const EdgeInsets.all(18),
          decoration: panelDecoration(
            color: r.balanced ? Tw.accentSoft : Tw.dangerSoft,
          ),
          child: Row(
            children: [
              Icon(
                r.balanced ? Icons.check_circle_outline : Icons.error_outline,
                color: r.balanced ? Tw.accentInk : Tw.danger,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  r.balanced
                      ? 'متوازنة: الأصول = الخصوم + حقوق الملكية'
                      : 'غير متوازنة',
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    color: r.balanced ? Tw.accentInk : Tw.danger,
                  ),
                ),
              ),
              Money(r.liabilitiesAndEquity),
            ],
          ),
        ),
      ];
    },
  );
}

// -------------------------------------------------------- trial balance

const trialHelp = [
  HelpItem(
    '',
    'ميزان المراجعة يجمع أرصدة كل الحسابات الفرعية حتى التاريخ: مجموع المدين يساوي مجموع الدائن دائمًا لأن كل قيد متوازن.',
  ),
  HelpItem('', 'اضغط أي حساب لكشفه.'),
];

class TrialBalancePage extends StatefulWidget {
  const TrialBalancePage({super.key});
  @override
  State<TrialBalancePage> createState() => _TrialBalancePageState();
}

class _TrialBalancePageState extends State<TrialBalancePage> {
  String _date = Ledger.today();

  @override
  Widget build(BuildContext context) => BooksPage(
    key: ValueKey(_date),
    title: 'ميزان المراجعة',
    help: trialHelp,
    load: (s) => s.reports.trialBalance(to: _date),
    build: (context, data, reload) {
      final r = data as TrialBalance;
      TextStyle head = Ds.label;
      return [
        FormRows(
          onSurface: false,
          children: [
            FormRow(
              'حتى تاريخ',
              DateValue(
                value: _date,
                onChanged: (v) => setState(() => _date = v),
              ),
            ),
          ],
        ),
        gap,
        Container(
          decoration: panelDecoration(),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Row(
                  children: [
                    Expanded(child: Text('الحساب', style: head)),
                    SizedBox(
                      width: 96,
                      child: Text(
                        'مدين',
                        style: head,
                        textAlign: TextAlign.end,
                      ),
                    ),
                    SizedBox(
                      width: 96,
                      child: Text(
                        'دائن',
                        style: head,
                        textAlign: TextAlign.end,
                      ),
                    ),
                  ],
                ),
              ),
              Divider(height: 1, color: Tw.rule),
              if (r.rows.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(20),
                  child: Text('لا أرصدة', style: Ds.secondary),
                ),
              for (final row in r.rows)
                InkWell(
                  onTap:
                      () => openPage(
                        context,
                        StatementPage(account: row.account),
                      ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 10,
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(row.account.name, style: Ds.body),
                              Text(
                                row.account.code,
                                style: Ds.secondary.copyWith(fontSize: 12),
                              ),
                            ],
                          ),
                        ),
                        SizedBox(width: 96, child: _cell(row.debit)),
                        SizedBox(width: 96, child: _cell(row.credit)),
                      ],
                    ),
                  ),
                ),
              Divider(height: 1, color: Tw.rule),
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Row(
                        children: [
                          Text('المجموع', style: head),
                          const SizedBox(width: 8),
                          if (r.balanced)
                            Icon(
                              Icons.check_circle,
                              size: 16,
                              color: Tw.accentInk,
                            ),
                        ],
                      ),
                    ),
                    SizedBox(width: 96, child: _cell(r.debit, bold: true)),
                    SizedBox(width: 96, child: _cell(r.credit, bold: true)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ];
    },
  );

  Widget _cell(int v, {bool bold = false}) => Align(
    alignment: AlignmentDirectional.centerEnd,
    child: Text(
      v == 0 ? '—' : formatCentsShort(v),
      textDirection: TextDirection.ltr,
      style: TextStyle(
        fontSize: 14,
        fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
        color: v == 0 ? Tw.ink3 : Tw.ink,
      ),
    ),
  );
}

// ------------------------------------------------------- profit sources

const profitHelp = [
  HelpItem(
    '',
    'مصادر الربح: كل حساب إيراد في الفترة ونصيبه من مجموع الإيرادات، وصافي ربح الشحن (المبيعات ناقص تكلفتها).',
  ),
  HelpItem('', 'اضغط مصدرًا لعرض كشفه. الأرقام نفسها في قائمة الدخل.'),
];

class ProfitSourcesPage extends StatefulWidget {
  const ProfitSourcesPage({super.key});
  @override
  State<ProfitSourcesPage> createState() => _ProfitSourcesPageState();
}

class _ProfitSourcesPageState extends State<ProfitSourcesPage> {
  int _preset = 0;
  Period _period = Period.preset(0);

  @override
  Widget build(BuildContext context) => BooksPage(
    key: ValueKey('${_period.from}|${_period.to}'),
    title: 'مصادر الربح',
    help: profitHelp,
    load: (s) async {
      final inc = await s.reports.incomeStatement(
        from: _period.from,
        to: _period.to,
      );
      final b = await s.ledger.balances(from: _period.from, to: _period.to);
      final cogs = await s.ledger.byRole(Roles.cogs);
      return (inc: inc, cogs: b[cogs.id] ?? 0);
    },
    build: (context, data, reload) {
      final d = data as ({IncomeStatement inc, int cogs});
      final sources = <AccountNode>[];
      void walk(AccountNode n) {
        if (n.children.isEmpty && !n.account.isGroup) {
          if (n.balance != 0) sources.add(n);
        } else {
          n.children.forEach(walk);
        }
      }

      walk(d.inc.revenue);
      sources.sort((a, b) => b.balance.compareTo(a.balance));
      final total = d.inc.revenue.balance;
      final shipping = sources
          .where((n) => n.account.role == Roles.revShipping)
          .fold(0, (s, n) => s + n.balance);
      return [
        PeriodPicker(
          preset: _preset,
          period: _period,
          onChanged:
              (i, p) => setState(() {
                _preset = i;
                _period = p;
              }),
        ),
        gap,
        FigsRow(
          figs: [
            (formatCentsShort(total), 'الإيرادات', Tw.accentInk),
            (formatCentsShort(d.inc.expenses.balance), 'المصاريف', null),
            (
              formatCentsShort(d.inc.net),
              'صافي الربح',
              d.inc.net < 0 ? Tw.danger : null,
            ),
          ],
        ),
        gap,
        if (sources.isEmpty)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: Text('لا إيرادات في الفترة')),
          )
        else
          Container(
            decoration: panelDecoration(),
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(
              children: [
                for (final n in sources)
                  InkWell(
                    onTap:
                        () => openPage(
                          context,
                          StatementPage(account: n.account),
                        ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 10,
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(n.account.name, style: Ds.body),
                              ),
                              Text(
                                total == 0
                                    ? ''
                                    : '${(n.balance * 100 / total).toStringAsFixed(0)}٪  ',
                                style: Ds.secondary,
                              ),
                              Money(n.balance),
                            ],
                          ),
                          const SizedBox(height: 6),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(4),
                            child: LinearProgressIndicator(
                              value:
                                  total <= 0
                                      ? 0
                                      : (n.balance / total)
                                          .clamp(0, 1)
                                          .toDouble(),
                              minHeight: 6,
                              backgroundColor: Tw.surface2,
                              color: Tw.accent,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        if (shipping != 0 || d.cogs != 0) ...[
          gap,
          Container(
            padding: const EdgeInsets.all(16),
            decoration: panelDecoration(),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'صافي ربح الشحن (المبيعات − التكلفة)',
                    style: Ds.body,
                  ),
                ),
                Money(
                  shipping - d.cogs,
                  color: shipping - d.cogs < 0 ? Tw.danger : Tw.accentInk,
                ),
              ],
            ),
          ),
        ],
      ];
    },
  );
}
