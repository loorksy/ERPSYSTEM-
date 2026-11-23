import 'package:sqflite/sqflite.dart';

import 'books.dart';
import 'chart.dart';
import 'ledger.dart';
import 'money.dart';

/// The kinds of parties (الأطراف) of the web ERP, each a group in the chart.
enum PartyKind {
  accreditation,
  transferCompany,
  subAgency,
  carrier,
  member,
  customer,
  supplier,
}

extension PartyKindX on PartyKind {
  String get label => switch (this) {
    PartyKind.accreditation => 'معتمد',
    PartyKind.transferCompany => 'شركة تحويل',
    PartyKind.subAgency => 'وكالة فرعية',
    PartyKind.carrier => 'وكالة شحن',
    PartyKind.member => 'عضو',
    PartyKind.customer => 'زبون',
    PartyKind.supplier => 'مورد',
  };

  String get plural => switch (this) {
    PartyKind.accreditation => 'المعتمدون',
    PartyKind.transferCompany => 'شركات التحويل',
    PartyKind.subAgency => 'الوكالات الفرعية',
    PartyKind.carrier => 'وكالات الشحن',
    PartyKind.member => 'ذمم الأعضاء',
    PartyKind.customer => 'الزبائن',
    PartyKind.supplier => 'الموردون',
  };

  /// The chart group the party's account sits under.
  String get groupRole => switch (this) {
    PartyKind.accreditation => Roles.accreditations,
    PartyKind.transferCompany => Roles.transferCompanies,
    PartyKind.subAgency => Roles.subAgencies,
    PartyKind.carrier => Roles.carriers,
    PartyKind.member => Roles.members,
    PartyKind.customer => Roles.receivables,
    PartyKind.supplier => Roles.payables,
  };

  /// The percentage a party of this kind keeps (shown on its forms).
  String? get percentLabel => switch (this) {
    PartyKind.accreditation => 'نسبة الوساطة الافتراضية',
    PartyKind.subAgency => 'نسبة الشركة من الأرباح',
    _ => null,
  };

  static PartyKind parse(String s) => PartyKind.values.firstWhere(
    (k) => k.name == s,
    orElse: () => PartyKind.customer,
  );

  static PartyKind? ofRole(String? role) {
    for (final k in PartyKind.values) {
      if (k.groupRole == role) return k;
    }
    return null;
  }
}

/// A party: its account in the chart plus details. [balance] is debit
/// minus credit: positive = «لنا» (they owe us), negative = «علينا».
class Party {
  const Party({
    required this.id,
    required this.kind,
    required this.account,
    this.code = '',
    this.phone = '',
    this.percentBp = 0,
    this.note = '',
    this.pinned = false,
    this.balance = 0,
  });
  final int id;
  final PartyKind kind;
  final Account account;
  final String code;
  final String phone;

  /// Percentage in basis points (12.5% = 1250).
  final int percentBp;
  final String note;
  final bool pinned;
  final int balance;

  String get name => account.name;
  int get toUs => balance > 0 ? balance : 0;
  int get toThem => balance < 0 ? -balance : 0;
  double get percent => percentBp / 100;

  Party withBalance(int b) => Party(
    id: id,
    kind: kind,
    account: account,
    code: code,
    phone: phone,
    percentBp: percentBp,
    note: note,
    pinned: pinned,
    balance: b,
  );
}

/// «12.5» → 1250; null when not a percentage 0–100.
int? parsePercentBp(String text) {
  final c = parseCents(text);
  if (c == null || c < 0 || c > 10000) return null;
  return c;
}

/// [amount] × [bp] / 10000, rounded to the cent.
int percentOf(int amount, int bp) => (amount * bp / 10000).round();

/// The parties and their operations. Every operation is one balanced entry
/// with the party's account on one side and an account the user chose on
/// the other (the web ERP often changed a balance with no other side: a
/// «دين لنا» with nothing given, a delivery that zeroed a debt without
/// paying it…).
class Parties {
  Parties(this.ledger, this.books);
  final Ledger ledger;
  final Books books;

  Database get _db => ledger.db;

  static String ref(int accountId) => 'party:$accountId';

  Future<Party> _row(Map<String, Object?> r, Account a) async => Party(
    id: r['id'] as int,
    kind: PartyKindX.parse(r['kind'] as String),
    account: a,
    code: (r['code'] as String?) ?? '',
    phone: (r['phone'] as String?) ?? '',
    percentBp: (r['percent'] as int?) ?? 0,
    note: (r['note'] as String?) ?? '',
    pinned: (r['pinned'] as int? ?? 0) == 1,
  );

  /// The party of [account] (created on first use for accounts added from
  /// the chart, e.g. a customer).
  Future<Party?> ofAccount(int accountId) async {
    final a = await ledger.account(accountId);
    if (a == null) return null;
    final kind = await _kindOf(a);
    if (kind == null) return null;
    var rows = await _db.query(
      'acc_parties',
      where: 'account_id = ?',
      whereArgs: [accountId],
    );
    if (rows.isEmpty) {
      await _db.insert('acc_parties', {
        'account_id': accountId,
        'kind': kind.name,
        'created_at': DateTime.now().toIso8601String(),
      });
      rows = await _db.query(
        'acc_parties',
        where: 'account_id = ?',
        whereArgs: [accountId],
      );
    }
    final p = await _row(rows.first, a);
    return p.withBalance(await ledger.balanceOf(accountId));
  }

  Future<PartyKind?> _kindOf(Account a) async {
    final all = await ledger.accounts(archived: true);
    final byId = {for (final x in all) x.id: x};
    Account? cur = a;
    while (cur != null) {
      final k = PartyKindX.ofRole(cur.role);
      if (k != null) return k;
      cur = cur.parentId == null ? null : byId[cur.parentId];
    }
    return null;
  }

  /// Every party of [kind] with its balance (pinned first, then by name).
  Future<List<Party>> list(PartyKind kind, {bool archived = false}) async {
    final accounts = await ledger.childrenOfRole(
      kind.groupRole,
      archived: archived,
    );
    final rows = await _db.query('acc_parties');
    final byAccount = {for (final r in rows) r['account_id'] as int: r};
    final b = await ledger.balances();
    final out = <Party>[];
    for (final a in accounts) {
      final r = byAccount[a.id];
      final p =
          r == null ? Party(id: 0, kind: kind, account: a) : await _row(r, a);
      out.add(p.withBalance(b[a.id] ?? 0));
    }
    out.sort((x, y) {
      if (x.pinned != y.pinned) return x.pinned ? -1 : 1;
      return x.name.compareTo(y.name);
    });
    return out;
  }

  /// All parties of every kind (for «لنا / علينا» and payment due).
  Future<List<Party>> all() async => [
    for (final k in PartyKind.values) ...await list(k),
  ];

  /// A new party with an optional opening balance (signed: positive =
  /// «لنا»), posted against «أرصدة افتتاحية».
  Future<Party> add(
    PartyKind kind,
    String name, {
    String code = '',
    String phone = '',
    int percentBp = 0,
    String note = '',
    int opening = 0,
    String? date,
  }) async {
    final n = name.trim();
    if (n.isEmpty) throw LedgerException('اكتب الاسم');
    final existing = await list(kind, archived: true);
    if (existing.any((p) => p.name.trim() == n)) {
      throw LedgerException('يوجد ${kind.label} بهذا الاسم');
    }
    final group = await ledger.byRole(kind.groupRole);
    final account = await ledger.addAccount(
      name: n,
      parentId: group.id,
      note: note,
    );
    await _db.insert('acc_parties', {
      'account_id': account.id,
      'kind': kind.name,
      'code': code.trim(),
      'phone': phone.trim(),
      'percent': percentBp,
      'note': note.trim(),
      'created_at': DateTime.now().toIso8601String(),
    });
    if (opening != 0) {
      final eq = await ledger.byRole(Roles.opening);
      await ledger.post(
        EntryDraft(
          date: date ?? Ledger.today(),
          memo: 'رصيد افتتاحي — $n',
          kind: EntryKind.opening,
          ref: ref(account.id),
          lines:
              opening > 0
                  ? [
                    JournalLine(accountId: account.id, debit: opening),
                    JournalLine(accountId: eq.id, credit: opening),
                  ]
                  : [
                    JournalLine(accountId: eq.id, debit: -opening),
                    JournalLine(accountId: account.id, credit: -opening),
                  ],
        ),
      );
    }
    return (await ofAccount(account.id))!;
  }

  Future<void> update(
    Party p, {
    String? name,
    String? code,
    String? phone,
    int? percentBp,
    String? note,
    bool? pinned,
  }) async {
    if (name != null && name.trim() != p.name) {
      await ledger.renameAccount(p.account.id, name);
    }
    await ofAccount(p.account.id);
    await _db.update(
      'acc_parties',
      {
        if (code != null) 'code': code.trim(),
        if (phone != null) 'phone': phone.trim(),
        if (percentBp != null) 'percent': percentBp,
        if (note != null) 'note': note.trim(),
        if (pinned != null) 'pinned': pinned ? 1 : 0,
      },
      where: 'account_id = ?',
      whereArgs: [p.account.id],
    );
  }

  void _positive(int amount) {
    if (amount <= 0) throw LedgerException('اكتب مبلغًا أكبر من صفر');
  }

  Future<String> _name(int accountId) async =>
      (await ledger.account(accountId))?.name ?? '';

  Future<bool> _isFund(int accountId) async {
    final funds = await ledger.childrenOfRole(Roles.funds, archived: true);
    return funds.any((f) => f.id == accountId);
  }

  Future<void> _coverIfFund(int accountId, int amount) async {
    if (!await _isFund(accountId)) return;
    final bal = await ledger.balanceOf(accountId);
    if (bal < amount) {
      throw LedgerException(
        'رصيد «${await _name(accountId)}» ${formatCents(bal)} لا يكفي لـ ${formatCents(amount)}',
      );
    }
  }

  /// «دين لنا»: the party owes us [amount]; [counterId] is what we gave or
  /// earned (a fund we paid from, a revenue, another party…).
  Future<JournalEntry> debtToUs(
    int partyId,
    int amount, {
    required int counterId,
    String memo = '',
    String? date,
  }) async {
    _positive(amount);
    if (partyId == counterId) {
      throw LedgerException('اختر حسابًا مقابلًا غير الطرف نفسه');
    }
    await _coverIfFund(counterId, amount);
    final name = await _name(partyId);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: memo.trim().isEmpty ? 'دين لنا على $name' : memo.trim(),
        kind: EntryKind.debtToUs,
        ref: ref(partyId),
        lines: [
          JournalLine(accountId: partyId, debit: amount),
          JournalLine(accountId: counterId, credit: amount),
        ],
      ),
    );
  }

  /// «دين علينا»: we owe the party; [counterId] is what we received (a fund
  /// they deposited in, an expense…). A [discountBp] keeps that share of
  /// the amount as our profit («أرباح خصم الديون»): we owe the rest.
  Future<JournalEntry> debtToThem(
    int partyId,
    int gross, {
    required int counterId,
    int discountBp = 0,
    String memo = '',
    String? date,
  }) async {
    _positive(gross);
    if (partyId == counterId) {
      throw LedgerException('اختر حسابًا مقابلًا غير الطرف نفسه');
    }
    if (discountBp < 0 || discountBp > 10000) {
      throw LedgerException('نسبة الخصم بين 0 و100');
    }
    final discount = percentOf(gross, discountBp);
    final net = gross - discount;
    final name = await _name(partyId);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: memo.trim().isEmpty ? 'دين علينا لـ $name' : memo.trim(),
        kind: EntryKind.debtToThem,
        ref: ref(partyId),
        meta:
            discount > 0
                ? {
                  'gross': gross,
                  'discountBp': discountBp,
                  'discount': discount,
                }
                : null,
        lines: [
          JournalLine(accountId: counterId, debit: gross),
          if (net > 0) JournalLine(accountId: partyId, credit: net),
          if (discount > 0)
            JournalLine(
              accountId: (await ledger.byRole(Roles.revPayableDiscount)).id,
              credit: discount,
              memo: 'خصم ${formatPercent(discountBp)}٪',
            ),
        ],
      ),
    );
  }

  /// Money from the party into a fund («قبض»، or «مرتجع» with [returned]).
  Future<JournalEntry> receive(
    int partyId,
    int amount, {
    required int fundId,
    String memo = '',
    String? date,
    bool returned = false,
  }) async {
    _positive(amount);
    final name = await _name(partyId);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo:
            memo.trim().isEmpty
                ? '${returned ? 'مرتجع من' : 'قبض من'} $name'
                : memo.trim(),
        kind: returned ? EntryKind.returned : EntryKind.receipt,
        ref: ref(partyId),
        lines: [
          JournalLine(accountId: fundId, debit: amount),
          JournalLine(accountId: partyId, credit: amount),
        ],
      ),
    );
  }

  /// Money from a fund to the party («دفع» / «صرف»).
  Future<JournalEntry> pay(
    int partyId,
    int amount, {
    required int fundId,
    String memo = '',
    String? date,
  }) async {
    _positive(amount);
    await _coverIfFund(fundId, amount);
    final name = await _name(partyId);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: memo.trim().isEmpty ? 'دفع إلى $name' : memo.trim(),
        kind: EntryKind.payment,
        ref: ref(partyId),
        lines: [
          JournalLine(accountId: partyId, debit: amount),
          JournalLine(accountId: fundId, credit: amount),
        ],
      ),
    );
  }

  /// From one party's account to another (an accreditation's money handed
  /// to a transfer company…): the first owes us less, the second more.
  Future<JournalEntry> transfer(
    int fromId,
    int toId,
    int amount, {
    String memo = '',
    String? date,
  }) async {
    _positive(amount);
    if (fromId == toId) throw LedgerException('اختر طرفين مختلفين');
    final from = await _name(fromId);
    final to = await _name(toId);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: memo.trim().isEmpty ? 'تحويل من $from إلى $to' : memo.trim(),
        kind: EntryKind.partyTransfer,
        ref: ref(fromId),
        meta: {'to': toId},
        lines: [
          JournalLine(accountId: toId, debit: amount),
          JournalLine(accountId: fromId, credit: amount),
        ],
      ),
    );
  }

  /// An accreditation's salary handed to us with our brokerage: the fund
  /// gets the whole [gross], our share is revenue («عمولات وساطة
  /// المعتمدين») and we owe them the rest. (The web ERP owed them the whole
  /// amount and booked the brokerage as profit too.)
  Future<JournalEntry> salaryWithBrokerage(
    int partyId,
    int gross, {
    required int fundId,
    int brokerageBp = 0,
    String memo = '',
    String? date,
  }) async {
    _positive(gross);
    if (brokerageBp < 0 || brokerageBp > 10000) {
      throw LedgerException('نسبة الوساطة بين 0 و100');
    }
    final brokerage = percentOf(gross, brokerageBp);
    final name = await _name(partyId);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: memo.trim().isEmpty ? 'راتب من $name' : memo.trim(),
        kind: EntryKind.brokerage,
        ref: ref(partyId),
        meta: {
          'gross': gross,
          'brokerageBp': brokerageBp,
          'brokerage': brokerage,
        },
        lines: [
          JournalLine(accountId: fundId, debit: gross),
          if (gross - brokerage > 0)
            JournalLine(accountId: partyId, credit: gross - brokerage),
          if (brokerage > 0)
            JournalLine(
              accountId: (await ledger.byRole(Roles.revAccBrokerage)).id,
              credit: brokerage,
              memo: 'وساطة ${formatPercent(brokerageBp)}٪',
            ),
        ],
      ),
    );
  }

  /// A sub-agency's share of a cycle: [base] (column W of its sheet) comes
  /// from [counterId]; the company keeps [companyBp] of it as revenue
  /// («أرباح الوكالات الفرعية») and we owe the agency the rest.
  Future<JournalEntry> cycleShare(
    int partyId,
    int base, {
    required int counterId,
    required int companyBp,
    String cycle = '',
    String memo = '',
    String? date,
  }) async {
    _positive(base);
    if (partyId == counterId) {
      throw LedgerException('اختر حسابًا مقابلًا غير الوكالة');
    }
    if (companyBp < 0 || companyBp > 10000) {
      throw LedgerException('نسبة الشركة بين 0 و100');
    }
    final company = percentOf(base, companyBp);
    final agency = base - company;
    final name = await _name(partyId);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo:
            memo.trim().isEmpty
                ? 'أرباح ${cycle.isEmpty ? 'دورة' : cycle} — $name'
                : memo.trim(),
        kind: EntryKind.share,
        ref: ref(partyId),
        meta: {
          'base': base,
          'companyBp': companyBp,
          'company': company,
          'agency': agency,
          'cycle': cycle,
        },
        lines: [
          JournalLine(accountId: counterId, debit: base),
          if (agency > 0)
            JournalLine(
              accountId: partyId,
              credit: agency,
              memo: 'حصة الوكالة',
            ),
          if (company > 0)
            JournalLine(
              accountId: (await ledger.byRole(Roles.revSubAgency)).id,
              credit: company,
              memo: 'حصة الشركة ${formatPercent(companyBp)}٪',
            ),
        ],
      ),
    );
  }

  /// A reward to a party (an expense we owe them); paid now from [fundId]
  /// or left in their account. (The web ERP paid it from the fund and
  /// still added it to the agency's balance.)
  Future<JournalEntry> reward(
    int partyId,
    int amount, {
    int? fundId,
    String memo = '',
    String? date,
  }) async {
    _positive(amount);
    if (fundId != null) await _coverIfFund(fundId, amount);
    final party = await ofAccount(partyId);
    final expRole =
        party?.kind == PartyKind.member
            ? Roles.expMemberRewards
            : Roles.expSubAgency;
    final exp = await ledger.byRole(expRole);
    final name = party?.name ?? '';
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo: memo.trim().isEmpty ? 'مكافأة $name' : memo.trim(),
        kind: EntryKind.reward,
        ref: ref(partyId),
        lines: [
          JournalLine(accountId: exp.id, debit: amount),
          JournalLine(accountId: partyId, credit: amount),
          if (fundId != null) ...[
            JournalLine(
              accountId: partyId,
              debit: amount,
              memo: 'دُفعت من الصندوق',
            ),
            JournalLine(accountId: fundId, credit: amount),
          ],
        ],
      ),
    );
  }

  /// «مطلوب دفع»: the accreditations and sub-agencies we owe.
  Future<List<Party>> paymentDue() async => [
    for (final k in [PartyKind.accreditation, PartyKind.subAgency])
      for (final p in await list(k))
        if (p.balance < 0) p,
  ];

  /// «تسليم المحدد»: pays every chosen party what we owe it, from one fund,
  /// in one entry. (The web ERP zeroed these debts without paying them.)
  Future<JournalEntry> settle(
    Map<int, int> amounts, {
    required int fundId,
    String? date,
    String memo = '',
  }) async {
    final lines = <JournalLine>[];
    var total = 0;
    for (final e in amounts.entries) {
      if (e.value <= 0) continue;
      total += e.value;
      lines.add(
        JournalLine(accountId: e.key, debit: e.value, memo: await _name(e.key)),
      );
    }
    if (lines.isEmpty) throw LedgerException('اختر طرفًا واحدًا على الأقل');
    await _coverIfFund(fundId, total);
    lines.add(JournalLine(accountId: fundId, credit: total));
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo:
            memo.trim().isEmpty
                ? 'تسليم مطلوب الدفع (${lines.length - 1})'
                : memo.trim(),
        kind: EntryKind.settlement,
        meta: {'parties': amounts.keys.toList()},
        lines: lines,
      ),
    );
  }

  /// Bulk opening balances (pasted «الاسم المبلغ» lines): creates the
  /// missing parties and posts one opening entry. [toUs] tells whether the
  /// amounts are owed to us or by us.
  Future<({int created, int lines, JournalEntry? entry})> importBalances(
    PartyKind kind,
    List<(String name, int amount)> rows, {
    required bool toUs,
    String? date,
  }) async {
    final existing = {
      for (final p in await list(kind, archived: true)) p.name.trim(): p,
    };
    var created = 0;
    final amounts = <int, int>{};
    for (final (name, amount) in rows) {
      final n = name.trim();
      if (n.isEmpty || amount == 0) continue;
      var p = existing[n];
      if (p == null) {
        p = await add(kind, n);
        existing[n] = p;
        created++;
      }
      amounts[p.account.id] =
          (amounts[p.account.id] ?? 0) + (toUs ? amount : -amount);
    }
    if (amounts.isEmpty) return (created: created, lines: 0, entry: null);
    final entry = await books.openingBalances(amounts, date: date);
    return (created: created, lines: amounts.length, entry: entry);
  }

  /// «الاسم المبلغ» per line (tab, comma or spaces before the amount).
  static List<(String, int)> parseLines(String text) {
    final out = <(String, int)>[];
    for (final raw in text.split(RegExp(r'\r?\n'))) {
      final line = raw.trim();
      if (line.isEmpty) continue;
      final m = RegExp(
        r'^(.*?)[\s,\t؛;:]+([-−]?[\d٠-٩۰-۹.,٫٬]+)\s*$',
      ).firstMatch(line);
      if (m == null) continue;
      final amount = parseCents(m.group(2)!.replaceAll('−', '-'));
      if (amount == null) continue;
      out.add((m.group(1)!.trim(), amount.abs()));
    }
    return out;
  }
}
