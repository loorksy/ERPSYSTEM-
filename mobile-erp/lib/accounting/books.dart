import 'chart.dart';
import 'ledger.dart';
import 'money.dart';

/// A fund (cash box, bank, wallet) with its balance.
typedef FundBalance = ({Account account, int balance});

/// The everyday operations of the books, each one balanced entry.
///
/// Fixes over the web ERP (see `docs/ACCOUNTING.md`):
/// - a fund cannot go below zero (the web ERP checked this in some screens
///   only);
/// - a fund transfer with a fee posts the fee as an expense instead of
///   losing it;
/// - profit is not mirrored into a «صندوق الربح»: it is the revenue minus
///   the expenses of the period, in the income statement;
/// - deleting is a reversing entry, so balances and reports always agree.
class Books {
  Books(this.ledger);
  final Ledger ledger;

  // ---------------------------------------------------------------- funds

  Future<List<FundBalance>> funds({bool archived = false}) async {
    final list = await ledger.childrenOfRole(Roles.funds, archived: archived);
    final b = await ledger.balances();
    return [for (final a in list) (account: a, balance: b[a.id] ?? 0)];
  }

  /// A new fund under «النقدية والصناديق», with an optional opening balance
  /// (credited to «أرصدة افتتاحية»).
  Future<Account> createFund(
    String name, {
    int opening = 0,
    String? date,
    String note = '',
  }) async {
    final group = await ledger.byRole(Roles.funds);
    final existing = await ledger.childrenOfRole(Roles.funds, archived: true);
    if (existing.any((a) => a.name.trim() == name.trim())) {
      throw LedgerException('يوجد صندوق بهذا الاسم');
    }
    if (opening < 0) {
      throw LedgerException('الرصيد الافتتاحي للصندوق لا يكون سالبًا');
    }
    final fund = await ledger.addAccount(
      name: name,
      parentId: group.id,
      note: note,
    );
    if (opening > 0) {
      final eq = await ledger.byRole(Roles.opening);
      await ledger.post(
        EntryDraft(
          date: date ?? Ledger.today(),
          memo: 'رصيد افتتاحي — ${fund.name}',
          kind: EntryKind.opening,
          lines: [
            JournalLine(accountId: fund.id, debit: opening),
            JournalLine(accountId: eq.id, credit: opening),
          ],
        ),
      );
    }
    return fund;
  }

  Future<void> _ensureCovers(int fundId, int amount) async {
    final a = await ledger.account(fundId);
    if (a == null) throw LedgerException('الصندوق غير موجود');
    final bal = await ledger.balanceOf(fundId);
    if (bal < amount) {
      throw LedgerException(
        'رصيد «${a.name}» ${formatCents(bal)} لا يكفي لـ ${formatCents(amount)}',
      );
    }
  }

  void _positive(int amount) {
    if (amount <= 0) throw LedgerException('اكتب مبلغًا أكبر من صفر');
  }

  /// Moves [amount] from one fund to another; a [fee] paid from the source
  /// fund goes to «عمولات ومصاريف التحويل».
  Future<JournalEntry> transfer({
    required int fromId,
    required int toId,
    required int amount,
    int fee = 0,
    String? date,
    String memo = '',
  }) async {
    _positive(amount);
    if (fromId == toId) throw LedgerException('اختر صندوقين مختلفين');
    if (fee < 0) throw LedgerException('العمولة لا تكون سالبة');
    await _ensureCovers(fromId, amount + fee);
    final from = (await ledger.account(fromId))!;
    final to = (await ledger.account(toId))!;
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo:
            memo.trim().isEmpty
                ? 'تحويل من ${from.name} إلى ${to.name}'
                : memo.trim(),
        kind: EntryKind.transfer,
        ref: 'fund_transfer',
        lines: [
          JournalLine(accountId: toId, debit: amount),
          if (fee > 0)
            JournalLine(
              accountId: (await ledger.byRole(Roles.expTransferFees)).id,
              debit: fee,
              memo: 'عمولة التحويل',
            ),
          JournalLine(accountId: fromId, credit: amount + fee),
        ],
      ),
    );
  }

  /// Money in: debit the fund, credit [fromAccountId] (a revenue, a
  /// customer we are owed by, the capital…).
  Future<JournalEntry> receipt({
    required int fundId,
    required int fromAccountId,
    required int amount,
    String? date,
    required String memo,
  }) async {
    _positive(amount);
    if (fundId == fromAccountId) {
      throw LedgerException('اختر حسابًا مقابلًا غير الصندوق');
    }
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: memo,
        kind: EntryKind.receipt,
        lines: [
          JournalLine(accountId: fundId, debit: amount),
          JournalLine(accountId: fromAccountId, credit: amount),
        ],
      ),
    );
  }

  /// Money out: debit [toAccountId] (a supplier we owe, an expense,
  /// drawings…), credit the fund.
  Future<JournalEntry> payment({
    required int fundId,
    required int toAccountId,
    required int amount,
    String? date,
    required String memo,
    String kind = EntryKind.payment,
  }) async {
    _positive(amount);
    if (fundId == toAccountId) {
      throw LedgerException('اختر حسابًا مقابلًا غير الصندوق');
    }
    await _ensureCovers(fundId, amount);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: memo,
        kind: kind,
        lines: [
          JournalLine(accountId: toAccountId, debit: amount),
          JournalLine(accountId: fundId, credit: amount),
        ],
      ),
    );
  }

  // ------------------------------------------------------------- expenses

  /// The expense categories (postable accounts under «مصاريف تشغيلية»).
  Future<List<Account>> expenseCategories() =>
      ledger.childrenOfRole(Roles.opex);

  Future<Account> addExpenseCategory(String name) async {
    final group = await ledger.byRole(Roles.opex);
    return ledger.addAccount(name: name, parentId: group.id);
  }

  /// An expense paid from a fund, or owed ([payableId], a supplier account)
  /// when not paid yet.
  Future<JournalEntry> expense({
    required int categoryId,
    required int amount,
    int? fundId,
    int? payableId,
    String? date,
    required String memo,
  }) async {
    _positive(amount);
    final cat = await ledger.account(categoryId);
    if (cat == null || cat.type != AccountType.expense) {
      throw LedgerException('اختر بند مصروف');
    }
    final credit = fundId ?? payableId;
    if (credit == null) {
      throw LedgerException('اختر الصندوق الذي دُفع منه المصروف');
    }
    if (fundId != null) await _ensureCovers(fundId, amount);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: memo.trim().isEmpty ? cat.name : memo,
        kind: EntryKind.expense,
        lines: [
          JournalLine(accountId: categoryId, debit: amount),
          JournalLine(accountId: credit, credit: amount),
        ],
      ),
    );
  }

  // ------------------------------------------------------ opening balances

  /// One opening entry: [amounts] are signed debit-positive cents per
  /// account (an asset 500 → +500; a debt we owe 300 → −300); the
  /// difference goes to «أرصدة افتتاحية».
  Future<JournalEntry> openingBalances(
    Map<int, int> amounts, {
    String? date,
  }) async {
    final lines = <JournalLine>[];
    var net = 0;
    for (final e in amounts.entries) {
      if (e.value == 0) continue;
      net += e.value;
      lines.add(
        e.value > 0
            ? JournalLine(accountId: e.key, debit: e.value)
            : JournalLine(accountId: e.key, credit: -e.value),
      );
    }
    if (lines.isEmpty) throw LedgerException('اكتب رصيدًا واحدًا على الأقل');
    final eq = await ledger.byRole(Roles.opening);
    if (amounts.containsKey(eq.id)) {
      throw LedgerException('حساب «${eq.name}» يُحسب تلقائيًا');
    }
    if (net != 0) {
      lines.add(
        net > 0
            ? JournalLine(
              accountId: eq.id,
              credit: net,
              memo: 'فرق الأرصدة الافتتاحية',
            )
            : JournalLine(
              accountId: eq.id,
              debit: -net,
              memo: 'فرق الأرصدة الافتتاحية',
            ),
      );
    }
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: 'أرصدة افتتاحية',
        kind: EntryKind.opening,
        lines: lines,
      ),
    );
  }
}
