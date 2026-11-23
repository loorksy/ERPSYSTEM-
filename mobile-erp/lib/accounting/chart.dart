/// Chart of accounts and journal models of LorkERP (owner's request
/// 2026-11-23): a classic double-entry ledger in place of the web ERP's
/// fund-centric books, so every operation is one balanced entry and the
/// trial balance, income statement and balance sheet always agree.
library;

enum AccountType { asset, liability, equity, revenue, expense }

extension AccountTypeX on AccountType {
  String get label => switch (this) {
    AccountType.asset => 'الأصول',
    AccountType.liability => 'الخصوم',
    AccountType.equity => 'حقوق الملكية',
    AccountType.revenue => 'الإيرادات',
    AccountType.expense => 'المصاريف',
  };

  /// Assets and expenses grow on the debit side; the others on credit.
  bool get debitNormal =>
      this == AccountType.asset || this == AccountType.expense;

  static AccountType parse(String s) => AccountType.values.firstWhere(
    (t) => t.name == s,
    orElse: () => AccountType.asset,
  );
}

class Account {
  const Account({
    required this.id,
    required this.code,
    required this.name,
    required this.type,
    this.parentId,
    this.isGroup = false,
    this.role,
    this.system = false,
    this.archived = false,
    this.note = '',
  });

  final int id;
  final String code;
  final String name;
  final AccountType type;
  final int? parentId;

  /// A heading: it sums its children and takes no lines itself.
  final bool isGroup;

  /// What the app looks the account up by (main fund, funds group, opening
  /// balances…); null for accounts the user adds.
  final String? role;

  /// Seeded by the app: can be renamed, not deleted.
  final bool system;
  final bool archived;
  final String note;

  String get label => '$code  $name';

  static Account fromRow(Map<String, Object?> r) => Account(
    id: r['id'] as int,
    code: r['code'] as String,
    name: r['name'] as String,
    type: AccountTypeX.parse(r['type'] as String),
    parentId: r['parent_id'] as int?,
    isGroup: (r['is_group'] as int? ?? 0) == 1,
    role: r['role'] as String?,
    system: (r['system'] as int? ?? 0) == 1,
    archived: (r['archived'] as int? ?? 0) == 1,
    note: (r['note'] as String?) ?? '',
  );
}

/// One line of an entry: [debit] or [credit] in cents, never both.
class JournalLine {
  const JournalLine({
    required this.accountId,
    this.debit = 0,
    this.credit = 0,
    this.memo = '',
  });
  final int accountId;
  final int debit;
  final int credit;
  final String memo;

  JournalLine get swapped => JournalLine(
    accountId: accountId,
    debit: credit,
    credit: debit,
    memo: memo,
  );
}

/// What is posted; the ledger checks it and gives it a number.
class EntryDraft {
  const EntryDraft({
    required this.date,
    required this.memo,
    required this.lines,
    this.kind = EntryKind.manual,
    this.ref,
  });

  /// `yyyy-MM-dd`.
  final String date;
  final String memo;
  final List<JournalLine> lines;
  final String kind;

  /// The operation the entry came from (e.g. `fund_transfer`), for reports.
  final String? ref;
}

class JournalEntry {
  const JournalEntry({
    required this.id,
    required this.number,
    required this.date,
    required this.memo,
    required this.kind,
    this.ref,
    this.reversesId,
    this.reversedById,
    required this.createdAt,
    this.lines = const [],
  });

  final int id;
  final int number;
  final String date;
  final String memo;
  final String kind;
  final String? ref;
  final int? reversesId;
  final int? reversedById;
  final String createdAt;
  final List<JournalLine> lines;

  bool get reversed => reversedById != null;
  bool get isReversal => reversesId != null;
  int get total => lines.fold(0, (n, l) => n + l.debit);

  static JournalEntry fromRow(
    Map<String, Object?> r, [
    List<JournalLine> lines = const [],
  ]) => JournalEntry(
    id: r['id'] as int,
    number: r['number'] as int,
    date: r['date'] as String,
    memo: r['memo'] as String,
    kind: r['kind'] as String,
    ref: r['ref'] as String?,
    reversesId: r['reverses_id'] as int?,
    reversedById: r['reversed_by_id'] as int?,
    createdAt: r['created_at'] as String,
    lines: lines,
  );
}

/// Entry kinds (stored as text).
abstract final class EntryKind {
  static const manual = 'manual';
  static const opening = 'opening';
  static const transfer = 'transfer';
  static const receipt = 'receipt';
  static const payment = 'payment';
  static const expense = 'expense';
  static const reversal = 'reversal';

  static String label(String kind) => switch (kind) {
    manual => 'قيد يدوي',
    opening => 'قيد افتتاحي',
    transfer => 'تحويل بين صناديق',
    receipt => 'سند قبض',
    payment => 'سند صرف',
    expense => 'مصروف',
    reversal => 'قيد عكسي',
    _ => kind,
  };
}

/// Account roles the app looks up.
abstract final class Roles {
  static const funds = 'funds';
  static const mainFund = 'main_fund';
  static const receivables = 'receivables';
  static const inventory = 'inventory';
  static const payables = 'payables';
  static const salariesPayable = 'salaries_payable';
  static const capital = 'capital';
  static const retained = 'retained';
  static const opening = 'opening';
  static const drawings = 'drawings';
  static const revTransferDiscount = 'rev_transfer_discount';
  static const revAudit = 'rev_audit';
  static const revShipping = 'rev_shipping';
  static const revFx = 'rev_fx';
  static const revBrokerage = 'rev_brokerage';
  static const revSubAgency = 'rev_sub_agency';
  static const revOther = 'rev_other';
  static const opex = 'opex';
  static const cogs = 'cogs';
  static const expSubAgency = 'exp_sub_agency';
  static const expFx = 'exp_fx';
  static const expTransferFees = 'exp_transfer_fees';
}

/// One account of the default tree: code, name, type, parent code, group?,
/// role.
typedef SeedAccount =
    (
      String code,
      String name,
      AccountType type,
      String? parent,
      bool group,
      String? role,
    );

/// The default chart (Arabic), fitted to the business of the web ERP.
const List<SeedAccount> defaultChart = [
  ('1', 'الأصول', AccountType.asset, null, true, null),
  ('11', 'النقدية والصناديق', AccountType.asset, '1', true, Roles.funds),
  ('1101', 'الصندوق الرئيسي', AccountType.asset, '11', false, Roles.mainFund),
  (
    '12',
    'الذمم المدينة (لنا)',
    AccountType.asset,
    '1',
    true,
    Roles.receivables,
  ),
  ('1201', 'ذمم مدينة أخرى', AccountType.asset, '12', false, null),
  ('13', 'المخزون', AccountType.asset, '1', true, Roles.inventory),
  ('2', 'الخصوم', AccountType.liability, null, true, null),
  (
    '21',
    'الذمم الدائنة (علينا)',
    AccountType.liability,
    '2',
    true,
    Roles.payables,
  ),
  ('2101', 'ذمم دائنة أخرى', AccountType.liability, '21', false, null),
  (
    '22',
    'الرواتب المستحقة',
    AccountType.liability,
    '2',
    true,
    Roles.salariesPayable,
  ),
  ('3', 'حقوق الملكية', AccountType.equity, null, true, null),
  ('31', 'رأس المال', AccountType.equity, '3', false, Roles.capital),
  ('32', 'الأرباح المحتجزة', AccountType.equity, '3', false, Roles.retained),
  ('33', 'أرصدة افتتاحية', AccountType.equity, '3', false, Roles.opening),
  ('34', 'المسحوبات الشخصية', AccountType.equity, '3', false, Roles.drawings),
  ('4', 'الإيرادات', AccountType.revenue, null, true, null),
  (
    '41',
    'أرباح خصم التحويل',
    AccountType.revenue,
    '4',
    false,
    Roles.revTransferDiscount,
  ),
  ('42', 'أرباح التدقيق', AccountType.revenue, '4', false, Roles.revAudit),
  ('43', 'مبيعات الشحن', AccountType.revenue, '4', false, Roles.revShipping),
  ('44', 'أرباح فرق التصريف', AccountType.revenue, '4', false, Roles.revFx),
  (
    '45',
    'عمولات الوساطة الإدارية',
    AccountType.revenue,
    '4',
    false,
    Roles.revBrokerage,
  ),
  (
    '46',
    'أرباح الوكالات الفرعية',
    AccountType.revenue,
    '4',
    false,
    Roles.revSubAgency,
  ),
  ('49', 'إيرادات أخرى', AccountType.revenue, '4', false, Roles.revOther),
  ('5', 'المصاريف', AccountType.expense, null, true, null),
  ('51', 'مصاريف تشغيلية', AccountType.expense, '5', true, Roles.opex),
  ('5101', 'رواتب وأجور', AccountType.expense, '51', false, null),
  ('5102', 'إيجار', AccountType.expense, '51', false, null),
  ('5103', 'اتصالات وإنترنت', AccountType.expense, '51', false, null),
  ('5104', 'نقل ومواصلات', AccountType.expense, '51', false, null),
  ('5109', 'مصاريف متنوعة', AccountType.expense, '51', false, null),
  (
    '52',
    'تكلفة بضاعة الشحن المباعة',
    AccountType.expense,
    '5',
    false,
    Roles.cogs,
  ),
  (
    '53',
    'مكافآت الوكالات الفرعية',
    AccountType.expense,
    '5',
    false,
    Roles.expSubAgency,
  ),
  ('54', 'خسائر فرق التصريف', AccountType.expense, '5', false, Roles.expFx),
  (
    '55',
    'عمولات ومصاريف التحويل',
    AccountType.expense,
    '5',
    false,
    Roles.expTransferFees,
  ),
];
