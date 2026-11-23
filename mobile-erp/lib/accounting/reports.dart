import 'chart.dart';
import 'ledger.dart';

/// An account in a report tree: [balance] is in the account's natural sign
/// (an asset or expense counts its debits, the others their credits), and a
/// group sums its children.
class AccountNode {
  AccountNode(this.account, this.balance, this.children);
  final Account account;
  final int balance;
  final List<AccountNode> children;

  bool get isEmpty => balance == 0 && children.every((c) => c.isEmpty);
}

class TrialRow {
  const TrialRow(this.account, this.debit, this.credit);
  final Account account;
  final int debit;
  final int credit;
}

class TrialBalance {
  const TrialBalance(this.rows);
  final List<TrialRow> rows;
  int get debit => rows.fold(0, (n, r) => n + r.debit);
  int get credit => rows.fold(0, (n, r) => n + r.credit);
  bool get balanced => debit == credit;
}

class IncomeStatement {
  const IncomeStatement({
    required this.revenue,
    required this.expenses,
    required this.from,
    required this.to,
  });
  final AccountNode revenue;
  final AccountNode expenses;
  final String? from;
  final String to;
  int get net => revenue.balance - expenses.balance;
}

class BalanceSheet {
  const BalanceSheet({
    required this.assets,
    required this.liabilities,
    required this.equity,
    required this.earnings,
    required this.date,
  });
  final AccountNode assets;
  final AccountNode liabilities;
  final AccountNode equity;

  /// Revenue minus expenses to [date] (there are no closing entries, so
  /// the profit of all periods sits here until it is moved to «الأرباح
  /// المحتجزة» by an entry).
  final int earnings;
  final String date;

  int get equityTotal => equity.balance + earnings;
  int get liabilitiesAndEquity => liabilities.balance + equityTotal;
  bool get balanced => assets.balance == liabilitiesAndEquity;
}

/// Reports read straight from the ledger, so they always agree with each
/// other and with the fund balances (the web ERP's dashboard and report
/// computed profit in two different ways).
class Reports {
  Reports(this.ledger);
  final Ledger ledger;

  static int natural(Account a, int debitMinusCredit) =>
      a.type.debitNormal ? debitMinusCredit : -debitMinusCredit;

  /// The whole tree with balances (natural sign), top-level accounts first.
  Future<List<AccountNode>> tree({
    String? from,
    String? to,
    bool archived = false,
  }) async {
    final all = await ledger.accounts(archived: true);
    final b = await ledger.balances(from: from, to: to);
    final kids = <int?, List<Account>>{};
    for (final a in all) {
      kids.putIfAbsent(a.parentId, () => []).add(a);
    }
    AccountNode build(Account a) {
      final children = [
        for (final c in kids[a.id] ?? const <Account>[])
          if (archived || !c.archived || (b[c.id] ?? 0) != 0) build(c),
      ];
      final own = natural(a, b[a.id] ?? 0);
      final sum = children.fold(
        own,
        (n, c) => n + (c.account.type == a.type ? c.balance : -c.balance),
      );
      return AccountNode(a, sum, children);
    }

    return [for (final a in kids[null] ?? const <Account>[]) build(a)];
  }

  Future<AccountNode> _root(
    AccountType type, {
    String? from,
    String? to,
  }) async {
    final roots = await tree(from: from, to: to);
    final r = roots.where((n) => n.account.type == type).toList();
    if (r.length == 1) return r.first;
    // Several roots of one type (not in the default chart): a virtual sum.
    final sum = r.fold(0, (n, x) => n + x.balance);
    return AccountNode(
      Account(id: -1, code: '', name: type.label, type: type, isGroup: true),
      sum,
      r,
    );
  }

  Future<TrialBalance> trialBalance({String? to}) async {
    final all = await ledger.accounts(archived: true);
    final b = await ledger.balances(to: to);
    final rows = <TrialRow>[];
    for (final a in all) {
      final v = b[a.id] ?? 0;
      if (v == 0) continue;
      rows.add(v > 0 ? TrialRow(a, v, 0) : TrialRow(a, 0, -v));
    }
    return TrialBalance(rows);
  }

  Future<IncomeStatement> incomeStatement({String? from, String? to}) async {
    final end = to ?? Ledger.today();
    return IncomeStatement(
      revenue: await _root(AccountType.revenue, from: from, to: end),
      expenses: await _root(AccountType.expense, from: from, to: end),
      from: from,
      to: end,
    );
  }

  Future<BalanceSheet> balanceSheet({String? date}) async {
    final end = date ?? Ledger.today();
    final rev = await _root(AccountType.revenue, to: end);
    final exp = await _root(AccountType.expense, to: end);
    var assets = await _root(AccountType.asset, to: end);
    var liabilities = await _root(AccountType.liability, to: end);
    // A party is one current account: a credit balance in an asset group
    // (we owe an accreditation, a transfer company…) is a liability, and a
    // debit balance in a liability group (a supplier we paid ahead) an
    // asset. Both are moved to the right side, so the sheet stays honest.
    final partyGroups = {
      for (final a in await ledger.accounts(archived: true))
        if (Roles.partyGroups.contains(a.role)) a.id,
    };
    final toLiabilities = <AccountNode>[];
    final toAssets = <AccountNode>[];
    assets = _strip(assets, partyGroups, false, toLiabilities);
    liabilities = _strip(liabilities, partyGroups, false, toAssets);
    if (toLiabilities.isNotEmpty) {
      liabilities = _append(
        liabilities,
        'أطراف بأرصدة دائنة (علينا)',
        AccountType.liability,
        toLiabilities,
      );
    }
    if (toAssets.isNotEmpty) {
      assets = _append(
        assets,
        'أطراف بأرصدة مدينة (لنا)',
        AccountType.asset,
        toAssets,
      );
    }
    return BalanceSheet(
      assets: assets,
      liabilities: liabilities,
      equity: await _root(AccountType.equity, to: end),
      earnings: rev.balance - exp.balance,
      date: end,
    );
  }

  /// [n] without the postable accounts under a party group whose balance
  /// is against their side (collected in [moved], sign flipped); group
  /// totals are recomputed.
  static AccountNode _strip(
    AccountNode n,
    Set<int> partyGroups,
    bool inParty,
    List<AccountNode> moved,
  ) {
    final here = inParty || partyGroups.contains(n.account.id);
    if (n.children.isEmpty) return n;
    final kids = <AccountNode>[];
    for (final c in n.children) {
      if (here && !c.account.isGroup && c.children.isEmpty && c.balance < 0) {
        moved.add(AccountNode(c.account, -c.balance, const []));
      } else {
        kids.add(_strip(c, partyGroups, here, moved));
      }
    }
    final own = n.balance - n.children.fold<int>(0, (s, c) => s + c.balance);
    return AccountNode(
      n.account,
      own + kids.fold<int>(0, (s, c) => s + c.balance),
      kids,
    );
  }

  static AccountNode _append(
    AccountNode root,
    String name,
    AccountType type,
    List<AccountNode> nodes,
  ) {
    final sum = nodes.fold<int>(0, (s, c) => s + c.balance);
    final group = AccountNode(
      Account(id: -2, code: '', name: name, type: type, isGroup: true),
      sum,
      nodes,
    );
    return AccountNode(root.account, root.balance + sum, [
      ...root.children,
      group,
    ]);
  }

  /// Every party account with its balance (debit − credit: positive =
  /// «لنا», negative = «علينا»), to [to].
  Future<List<({Account account, String groupRole, int balance})>>
  partyBalances({String? to}) async {
    final all = await ledger.accounts(archived: true);
    final b = await ledger.balances(to: to);
    final byId = {for (final a in all) a.id: a};
    String? groupOf(Account a) {
      Account? cur = a;
      while (cur != null) {
        if (Roles.partyGroups.contains(cur.role)) return cur.role;
        cur = cur.parentId == null ? null : byId[cur.parentId];
      }
      return null;
    }

    return [
      for (final a in all)
        if (!a.isGroup && groupOf(a) != null)
          (account: a, groupRole: groupOf(a)!, balance: b[a.id] ?? 0),
    ];
  }

  /// The numbers of the home screen.
  Future<Dashboard> dashboard({DateTime? now}) async {
    final d = now ?? DateTime.now();
    String iso(DateTime x) =>
        '${x.year}-${x.month.toString().padLeft(2, '0')}-${x.day.toString().padLeft(2, '0')}';
    final monthStart = iso(DateTime(d.year, d.month));
    final today = iso(d);
    final all = await ledger.accounts(archived: true);
    final b = await ledger.balances(to: today);
    int sumRole(String role) {
      final group = all.where((a) => a.role == role).firstOrNull;
      if (group == null) return 0;
      final ids = <int>{group.id};
      var grew = true;
      while (grew) {
        grew = false;
        for (final a in all) {
          if (a.parentId != null && ids.contains(a.parentId) && ids.add(a.id)) {
            grew = true;
          }
        }
      }
      return ids.fold(0, (n, id) => n + natural(group, b[id] ?? 0));
    }

    final month = await incomeStatement(from: monthStart, to: today);
    final day = await incomeStatement(from: today, to: today);
    final parties = await partyBalances(to: today);
    return Dashboard(
      cash: sumRole(Roles.funds),
      receivables: parties.fold(
        0,
        (n, p) => n + (p.balance > 0 ? p.balance : 0),
      ),
      payables: parties.fold(0, (n, p) => n + (p.balance < 0 ? -p.balance : 0)),
      monthRevenue: month.revenue.balance,
      monthExpenses: month.expenses.balance,
      todayRevenue: day.revenue.balance,
      todayExpenses: day.expenses.balance,
      recent: await ledger.entries(limit: 6),
    );
  }
}

class Dashboard {
  const Dashboard({
    required this.cash,
    required this.receivables,
    required this.payables,
    required this.monthRevenue,
    required this.monthExpenses,
    required this.todayRevenue,
    required this.todayExpenses,
    required this.recent,
  });
  final int cash;
  final int receivables;
  final int payables;
  final int monthRevenue;
  final int monthExpenses;
  final int todayRevenue;
  final int todayExpenses;
  final List<JournalEntry> recent;
  int get monthNet => monthRevenue - monthExpenses;
  int get todayNet => todayRevenue - todayExpenses;
}
