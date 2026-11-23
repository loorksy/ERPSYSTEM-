// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/money.dart';
import '../../accounting/parties.dart';
import '../../accounting/reports.dart';
import '../adjustments_page.dart';
import '../backup_page.dart';
import '../erp_theme.dart';
import '../erp_widgets.dart';
import '../help.dart';
import '../search_page.dart';
import '../settings_page.dart';
import '../sort_page.dart';
import '../ui_kit.dart';
import 'accounts_page.dart';
import 'books_kit.dart';
import 'debts_page.dart';
import 'forms.dart';
import 'funds_page.dart';
import 'journal_page.dart';
import 'members_page.dart';
import 'trading_pages.dart';
import 'parties_pages.dart';
import 'reports_pages.dart';

const homeHelp = [
  HelpItem(
    '',
    'اللوحة الرئيسية: النقدية في كل الصناديق، وما لك عند الآخرين وما عليك، وأرباح الشهر، وآخر القيود.',
  ),
  HelpItem('', 'كل الأرقام من دفتر القيود مباشرة، فهي نفسها في التقارير.'),
  HelpItem(
    '',
    'الأزرار السريعة تسجّل سند قبض أو صرف أو مصروفًا أو تحويلًا في خطوة واحدة.',
  ),
];

class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'الرئيسية',
    help: homeHelp,
    load: (s) => s.reports.dashboard(),
    build: (context, data, reload) {
      final d = data as Dashboard;
      final net = d.monthNet;
      return [
        Container(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
          decoration: panelDecoration(radius: Ds.radiusL),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text('النقدية في الصناديق', style: Ds.secondary),
                  ),
                  TextButton(
                    onPressed: () => openPage(context, const FundsPage()),
                    child: const Text('الصناديق'),
                  ),
                ],
              ),
              Money(d.cash, size: 32, weight: FontWeight.w800),
              const SizedBox(height: 16),
              GridView.count(
                crossAxisCount: 4,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: 8,
                crossAxisSpacing: 8,
                childAspectRatio: 0.95,
                children: [
                  _Quick(
                    icon: Icons.south_west,
                    label: 'قبض',
                    onTap: () => showVoucherSheet(context, VoucherMode.receipt),
                  ),
                  _Quick(
                    icon: Icons.north_east,
                    label: 'صرف',
                    onTap: () => showVoucherSheet(context, VoucherMode.payment),
                  ),
                  _Quick(
                    icon: Icons.receipt_long_outlined,
                    label: 'مصروف',
                    onTap: () => showExpenseSheet(context),
                  ),
                  _Quick(
                    icon: Icons.swap_horiz,
                    label: 'تحويل',
                    onTap: () => showTransferSheet(context),
                  ),
                ],
              ),
            ],
          ),
        ),
        gap,
        SectionLabel(
          'هذا الشهر',
          trailing: Text(arabicMonths[DateTime.now().month - 1]),
        ),
        FigsRow(
          figs: [
            (formatCentsShort(d.monthRevenue), 'الإيرادات', null),
            (formatCentsShort(d.monthExpenses), 'المصاريف', null),
            (
              formatCentsShort(net),
              net >= 0 ? 'صافي الربح' : 'صافي الخسارة',
              net >= 0 ? Tw.accentInk : Tw.danger,
            ),
          ],
        ),
        gap,
        InkWell(
          borderRadius: BorderRadius.circular(Ds.radius),
          onTap: () => openPage(context, const DebtsPage()),
          child: FigsRow(
            figs: [
              (
                formatCentsShort(d.receivables),
                'لنا عند الآخرين',
                Tw.accentInk,
              ),
              (
                formatCentsShort(d.payables),
                'علينا للآخرين',
                d.payables > 0 ? Tw.danger : null,
              ),
              (
                formatCentsShort(d.todayNet),
                'صافي اليوم',
                d.todayNet < 0 ? Tw.danger : null,
              ),
            ],
          ),
        ),
        gap,
        SectionLabel(
          'آخر القيود',
          trailing: TextButton(
            onPressed: () => openPage(context, const JournalPage()),
            child: const Text('الكل'),
          ),
        ),
        if (d.recent.isEmpty)
          EmptyState(
            icon: Icons.flag_outlined,
            title: 'ابدأ دفاترك',
            message:
                'سجّل الأرصدة الافتتاحية: النقدية في كل صندوق، وما لك عند الزبائن، وما عليك للموردين.',
            action: ErpButton(
              label: 'الأرصدة الافتتاحية',
              icon: Icons.flag_outlined,
              expand: false,
              onPressed: () => openPage(context, const OpeningBalancesPage()),
            ),
          )
        else
          GroupList(children: [for (final e in d.recent) EntryRow(entry: e)]),
      ];
    },
  );
}

class _Quick extends StatelessWidget {
  const _Quick({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
    color: Tw.accentSoft,
    borderRadius: BorderRadius.circular(16),
    child: InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, color: Tw.accentInk, size: 24),
          const SizedBox(height: 6),
          Text(
            label,
            style: TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w700,
              color: Tw.accentInk,
            ),
          ),
        ],
      ),
    ),
  );
}

// ------------------------------------------------------------------ hubs

/// A tab whose first screen lists its sections.
class HubPage extends StatelessWidget {
  const HubPage({
    super.key,
    required this.title,
    required this.help,
    required this.groups,
  });
  final String title;
  final List<HelpItem> help;
  final List<(String?, List<Widget>)> groups;

  @override
  Widget build(BuildContext context) => BooksPage(
    title: title,
    help: help,
    load: (_) async => null,
    build:
        (context, _, _) => [
          for (final (label, rows) in groups) ...[
            if (label != null)
              SectionLabel(label)
            else
              const SizedBox(height: 6),
            GroupList(children: rows),
            gap,
          ],
        ],
  );
}

const operationsHelp = [
  HelpItem(
    '',
    'كل عملية هنا تُسجَّل قيدًا متوازنًا واحدًا في دفتر القيود، وتظهر فورًا في الأرصدة والتقارير.',
  ),
  HelpItem(
    '',
    'سند القبض لكل مال يدخل صندوقًا، وسند الصرف لكل مال يخرج منه لغير المصاريف (سداد مورد، سلفة، مسحوبات…).',
  ),
];

class OperationsHub extends StatelessWidget {
  const OperationsHub({super.key});

  @override
  Widget build(BuildContext context) => HubPage(
    title: 'العمليات',
    help: operationsHelp,
    groups: [
      (
        null,
        [
          HubRow(
            icon: Icons.account_balance_wallet_outlined,
            title: 'الصناديق',
            subtitle: 'الأرصدة والكشوف والتحويل',
            onTap: () => openPage(context, const FundsPage()),
          ),
          HubRow(
            icon: Icons.receipt_long_outlined,
            title: 'المصاريف',
            subtitle: 'تسجيل ومتابعة حسب البند',
            onTap: () => openPage(context, const ExpensesPage()),
          ),
        ],
      ),
      (
        'الأطراف',
        [
          for (final k in const [
            PartyKind.accreditation,
            PartyKind.transferCompany,
            PartyKind.subAgency,
            PartyKind.carrier,
            PartyKind.customer,
            PartyKind.supplier,
          ])
            HubRow(
              icon: partyIcon(k),
              title: k.plural,
              onTap: () => openPage(context, PartiesPage(kind: k)),
            ),
        ],
      ),
      (
        'الشحن والتصريف',
        [
          HubRow(
            icon: Icons.local_shipping_outlined,
            title: 'الشحن',
            subtitle: 'بيع وشراء الأصناف وتبديل الرواتب',
            onTap: () => openPage(context, const ShippingPage()),
          ),
          HubRow(
            icon: Icons.currency_exchange,
            title: 'فرق التصريف',
            onTap: () => openPage(context, const FxSpreadPage()),
          ),
          HubRow(
            icon: Icons.handshake_outlined,
            title: 'الوساطة الإدارية',
            onTap: () => openPage(context, const AdminBrokeragePage()),
          ),
        ],
      ),
      (
        'الديون',
        [
          HubRow(
            icon: Icons.handshake_outlined,
            title: 'الديون',
            subtitle: 'لنا وعلينا لكل الأطراف',
            onTap: () => openPage(context, const DebtsPage()),
          ),
          HubRow(
            icon: Icons.task_alt,
            title: 'مطلوب دفع',
            subtitle: 'تسليم المعتمدين والوكالات',
            onTap: () => openPage(context, const PaymentDuePage()),
          ),
        ],
      ),
      (
        'سندات',
        [
          HubRow(
            icon: Icons.south_west,
            title: 'سند قبض',
            onTap: () => showVoucherSheet(context, VoucherMode.receipt),
          ),
          HubRow(
            icon: Icons.north_east,
            title: 'سند صرف',
            onTap: () => showVoucherSheet(context, VoucherMode.payment),
          ),
          HubRow(
            icon: Icons.swap_horiz,
            title: 'تحويل بين الصناديق',
            onTap: () => showTransferSheet(context),
          ),
        ],
      ),
      (
        'القيود',
        [
          HubRow(
            icon: Icons.edit_note,
            title: 'قيد يدوي',
            subtitle: 'قيد بعدة أسطر',
            onTap: () => openPage(context, const ManualEntryPage()),
          ),
          HubRow(
            icon: Icons.flag_outlined,
            title: 'الأرصدة الافتتاحية',
            subtitle: 'بداية الدفاتر',
            onTap: () => openPage(context, const OpeningBalancesPage()),
          ),
        ],
      ),
    ],
  );
}

const reportsHelp = [
  HelpItem(
    '',
    'التقارير تُقرأ من دفتر القيود مباشرة، فهي متطابقة دائمًا: مجموع ميزان المراجعة متوازن، والميزانية متوازنة، وصافي الربح نفسه في كل مكان.',
  ),
];

class ReportsHub extends StatelessWidget {
  const ReportsHub({super.key});

  @override
  Widget build(BuildContext context) => HubPage(
    title: 'التقارير',
    help: reportsHelp,
    groups: [
      (
        'القوائم المالية',
        [
          HubRow(
            icon: Icons.trending_up,
            title: 'قائمة الدخل',
            subtitle: 'الإيرادات والمصاريف وصافي الربح',
            onTap: () => openPage(context, const IncomeStatementPage()),
          ),
          HubRow(
            icon: Icons.account_balance_outlined,
            title: 'الميزانية العمومية',
            subtitle: 'الأصول والخصوم وحقوق الملكية',
            onTap: () => openPage(context, const BalanceSheetPage()),
          ),
          HubRow(
            icon: Icons.insights_outlined,
            title: 'مصادر الربح',
            onTap: () => openPage(context, const ProfitSourcesPage()),
          ),
          HubRow(
            icon: Icons.balance,
            title: 'ميزان المراجعة',
            onTap: () => openPage(context, const TrialBalancePage()),
          ),
        ],
      ),
      (
        'الحسابات',
        [
          HubRow(
            icon: Icons.account_tree_outlined,
            title: 'شجرة الحسابات',
            onTap: () => openPage(context, const AccountsPage()),
          ),
          HubRow(
            icon: Icons.timeline,
            title: 'سجل الحركات',
            subtitle: 'نقدية، أطراف، أرباح ومصاريف',
            onTap:
                () => openPage(
                  context,
                  const JournalPage(category: 1, title: 'سجل الحركات'),
                ),
          ),
          HubRow(
            icon: Icons.menu_book_outlined,
            title: 'دفتر القيود',
            subtitle: 'اليومية',
            onTap: () => openPage(context, const JournalPage()),
          ),
          HubRow(
            icon: Icons.receipt_long_outlined,
            title: 'كشف حساب',
            onTap: () => openPage(context, const StatementPage()),
          ),
        ],
      ),
    ],
  );
}

const moreHelp = [
  HelpItem(
    '',
    'أدوات تدقيق الرواتب (التسويات، الفرز، الاستعلام) كما في تطبيق «المدقق»، والنسخ الاحتياطي والإعدادات.',
  ),
];

class MoreHub extends StatelessWidget {
  const MoreHub({super.key});

  @override
  Widget build(BuildContext context) => HubPage(
    title: 'المزيد',
    help: moreHelp,
    groups: [
      (
        'أدوات الرواتب',
        [
          HubRow(
            icon: Icons.exposure,
            title: 'التسويات',
            subtitle: 'إضافات وخصومات الرواتب',
            onTap: () => openPage(context, const AdjustmentsPage(active: true)),
          ),
          HubRow(
            icon: Icons.call_split,
            title: 'فرز',
            subtitle: 'ترتيب جدول المستخدمين وتقريب الرواتب',
            onTap: () => openPage(context, const SortPage(active: true)),
          ),
          HubRow(
            icon: Icons.badge_outlined,
            title: 'دليل الأعضاء',
            subtitle: 'أعضاء الدورات وحساباتهم',
            onTap: () => openPage(context, const MembersPage()),
          ),
          HubRow(
            icon: Icons.search,
            title: 'الاستعلام',
            onTap: () => openPage(context, const SearchPage(active: true)),
          ),
        ],
      ),
      (
        'النظام',
        [
          HubRow(
            icon: Icons.backup_outlined,
            title: 'النسخ الاحتياطي',
            subtitle: 'ملف أو Google Drive',
            onTap: () => openPage(context, const BackupPage()),
          ),
          HubRow(
            icon: Icons.settings_outlined,
            title: 'الإعدادات',
            onTap: () => openPage(context, const SettingsPage()),
          ),
        ],
      ),
    ],
  );
}
