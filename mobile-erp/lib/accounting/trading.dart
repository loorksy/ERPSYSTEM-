import 'package:sqflite/sqflite.dart';

import 'books.dart';
import 'chart.dart';
import 'ledger.dart';
import 'money.dart';
import 'parties.dart';

/// Quantities are stored in thousandths (1.5 → 1500).
const qtyScale = 1000;

/// «1.5» / «١٫٥» → 1500; null when not a quantity.
int? parseQty(String text) {
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  final b = StringBuffer();
  for (final r in text.trim().runes) {
    final ch = String.fromCharCode(r);
    var i = arabic.indexOf(ch);
    if (i < 0) i = persian.indexOf(ch);
    if (i >= 0) {
      b.write(i);
    } else if (ch == '٫') {
      b.write('.');
    } else if (ch != ',' && ch != '٬' && ch != ' ') {
      b.write(ch);
    }
  }
  final m = RegExp(r'^(\d+)(?:\.(\d{1,3})\d*)?$').firstMatch(b.toString());
  if (m == null) return null;
  return int.parse(m.group(1)!) * qtyScale +
      int.parse((m.group(2) ?? '0').padRight(3, '0'));
}

/// 1500 → «1.5».
String formatQty(int q) {
  final neg = q < 0;
  final a = q.abs();
  final whole = (a ~/ qtyScale).toString().replaceAllMapped(
    RegExp(r'\B(?=(\d{3})+(?!\d))'),
    (_) => ',',
  );
  final frac = (a % qtyScale)
      .toString()
      .padLeft(3, '0')
      .replaceAll(RegExp(r'0+$'), '');
  return '${neg ? '−' : ''}$whole${frac.isEmpty ? '' : '.$frac'}';
}

/// A stock item (ذهب، كرستال…): its inventory account, quantity on hand
/// and value (cost of what is left).
class StockItem {
  const StockItem({
    required this.id,
    required this.account,
    required this.unit,
    required this.qty,
    required this.value,
  });
  final int id;
  final Account account;
  final String unit;
  final int qty;
  final int value;
  String get name => account.name;

  /// Average cost of one unit (cents per unit).
  int get average => qty <= 0 ? 0 : (value * qtyScale / qty).round();
}

/// One stock movement with its entry.
class StockMove {
  const StockMove({
    required this.entry,
    required this.itemName,
    required this.qty,
    required this.cost,
    required this.amount,
    this.partyName,
  });
  final JournalEntry entry;
  final String itemName;
  final int qty;
  final int cost;
  final int amount;
  final String? partyName;
  bool get isSale => qty < 0;
  int get profit => isSale ? amount - cost : 0;
}

/// Shipping (الشحن): stock bought and sold at weighted average cost, FX
/// spread, admin brokerage and salary swap — each one balanced entry.
class Trading {
  Trading(this.ledger, this.books) {
    ledger.reverseGuards.add(_guardStock);
  }
  final Ledger ledger;
  final Books books;

  Database get _db => ledger.db;

  static const defaultItems = [('ذهب', 'وحدة'), ('كرستال', 'وحدة')];

  /// The default items (once): each an account under «المخزون».
  Future<void> ensureItems() async {
    final rows = await _db.query('acc_items', limit: 1);
    if (rows.isNotEmpty) return;
    for (final (name, unit) in defaultItems) {
      await addItem(name, unit: unit);
    }
  }

  Future<StockItem> addItem(String name, {String unit = ''}) async {
    final n = name.trim();
    if (n.isEmpty) throw LedgerException('اكتب اسم الصنف');
    if ((await items()).any((i) => i.name == n)) {
      throw LedgerException('الصنف موجود');
    }
    final group = await ledger.byRole(Roles.inventory);
    final a = await ledger.addAccount(name: n, parentId: group.id);
    final id = await _db.insert('acc_items', {
      'account_id': a.id,
      'unit': unit.trim(),
      'created_at': DateTime.now().toIso8601String(),
    });
    return (await item(id))!;
  }

  static const _liveMoves =
      'FROM acc_stock_moves m JOIN acc_entries e ON e.id = m.entry_id WHERE e.reversed_by_id IS NULL';

  Future<List<StockItem>> items() async {
    final rows = await _db.query('acc_items', orderBy: 'id');
    final out = <StockItem>[];
    for (final r in rows) {
      out.add((await item(r['id'] as int))!);
    }
    return out;
  }

  Future<StockItem?> item(int id) async {
    final rows = await _db.query('acc_items', where: 'id = ?', whereArgs: [id]);
    if (rows.isEmpty) return null;
    final r = rows.first;
    final a = await ledger.account(r['account_id'] as int);
    if (a == null) return null;
    final q = await _db.rawQuery(
      'SELECT COALESCE(SUM(m.qty), 0) AS q $_liveMoves AND m.item_id = ?',
      [id],
    );
    return StockItem(
      id: id,
      account: a,
      unit: (r['unit'] as String?) ?? '',
      qty: (q.first['q'] as num).toInt(),
      value: await ledger.balanceOf(a.id),
    );
  }

  /// Refuses to reverse a purchase whose quantity was already sold.
  Future<void> _guardStock(Transaction txn, JournalEntry e) async {
    final moves = await txn.query(
      'acc_stock_moves',
      where: 'entry_id = ?',
      whereArgs: [e.id],
    );
    for (final m in moves) {
      final qty = m['qty'] as int;
      if (qty <= 0) continue;
      final q = await txn.rawQuery(
        'SELECT COALESCE(SUM(m.qty), 0) AS q $_liveMoves AND m.item_id = ?',
        [m['item_id']],
      );
      final onHand = (q.first['q'] as num).toInt();
      if (onHand < qty) {
        throw LedgerException(
          'بيع جزء من هذه الكمية؛ ألغِ البيع أولًا ثم الشراء',
        );
      }
    }
  }

  Future<bool> _isFund(int accountId) async => (await ledger.childrenOfRole(
    Roles.funds,
    archived: true,
  )).any((f) => f.id == accountId);

  Future<void> _cover(int accountId, int amount) async {
    if (!await _isFund(accountId)) return;
    final bal = await ledger.balanceOf(accountId);
    if (bal < amount) {
      final a = await ledger.account(accountId);
      throw LedgerException(
        'رصيد «${a?.name}» ${formatCents(bal)} لا يكفي لـ ${formatCents(amount)}',
      );
    }
  }

  /// A purchase: [total] paid from a fund or owed to a party ([payFromId]).
  Future<JournalEntry> buy(
    int itemId,
    int qty,
    int total, {
    required int payFromId,
    String memo = '',
    String? date,
  }) async {
    if (qty <= 0) throw LedgerException('اكتب الكمية');
    if (total <= 0) throw LedgerException('اكتب المبلغ');
    final it = await item(itemId);
    if (it == null) throw LedgerException('الصنف غير موجود');
    await _cover(payFromId, total);
    final from = await ledger.account(payFromId);
    return ledger.transaction((txn) async {
      final e = await ledger.postIn(
        txn,
        EntryDraft(
          date: date ?? Ledger.today(),
          memo:
              memo.trim().isEmpty
                  ? 'شراء ${formatQty(qty)} ${it.name} — ${from?.name}'
                  : memo.trim(),
          kind: EntryKind.purchase,
          ref: 'stock:$itemId',
          meta: {'item': itemId, 'qty': qty, 'total': total},
          lines: [
            JournalLine(accountId: it.account.id, debit: total),
            JournalLine(accountId: payFromId, credit: total),
          ],
        ),
      );
      await txn.insert('acc_stock_moves', {
        'entry_id': e.id,
        'item_id': itemId,
        'qty': qty,
        'cost': total,
        'amount': total,
        'party_account_id': payFromId,
      });
      return e;
    });
  }

  /// A sale: [total] received in a fund or owed by the buyer ([receiveIntoId]
  /// — a member, accreditation, sub-agency…). The cost of the quantity at
  /// the average cost leaves the stock for «تكلفة بضاعة الشحن المباعة»,
  /// so the profit is the sales minus that cost.
  Future<({JournalEntry entry, int cost, int profit})> sell(
    int itemId,
    int qty,
    int total, {
    required int receiveIntoId,
    String memo = '',
    String? date,
  }) async {
    if (qty <= 0) throw LedgerException('اكتب الكمية');
    if (total < 0) throw LedgerException('المبلغ لا يكون سالبًا');
    final it = await item(itemId);
    if (it == null) throw LedgerException('الصنف غير موجود');
    if (it.qty < qty) {
      throw LedgerException(
        'الكمية المتوفرة من ${it.name} ${formatQty(it.qty)} فقط',
      );
    }
    final cost = qty == it.qty ? it.value : (it.value * qty / it.qty).round();
    final to = await ledger.account(receiveIntoId);
    final rev = await ledger.byRole(Roles.revShipping);
    final cogs = await ledger.byRole(Roles.cogs);
    final e = await ledger.transaction((txn) async {
      final e = await ledger.postIn(
        txn,
        EntryDraft(
          date: date ?? Ledger.today(),
          memo:
              memo.trim().isEmpty
                  ? 'بيع ${formatQty(qty)} ${it.name} — ${to?.name}'
                  : memo.trim(),
          kind: EntryKind.sale,
          ref: 'stock:$itemId',
          meta: {
            'item': itemId,
            'qty': qty,
            'total': total,
            'cost': cost,
            'profit': total - cost,
          },
          lines: [
            if (total > 0) JournalLine(accountId: receiveIntoId, debit: total),
            if (total > 0) JournalLine(accountId: rev.id, credit: total),
            if (cost > 0)
              JournalLine(
                accountId: cogs.id,
                debit: cost,
                memo: 'تكلفة ${formatQty(qty)} ${it.name}',
              ),
            if (cost > 0) JournalLine(accountId: it.account.id, credit: cost),
          ],
        ),
      );
      await txn.insert('acc_stock_moves', {
        'entry_id': e.id,
        'item_id': itemId,
        'qty': -qty,
        'cost': cost,
        'amount': total,
        'party_account_id': receiveIntoId,
      });
      return e;
    });
    return (entry: e, cost: cost, profit: total - cost);
  }

  /// Stock movements, newest first (one item, or one party's purchases).
  Future<List<StockMove>> moves({
    int? itemId,
    int? partyAccountId,
    int limit = 200,
  }) async {
    final where = <String>[];
    final args = <Object?>[];
    if (itemId != null) {
      where.add('m.item_id = ?');
      args.add(itemId);
    }
    if (partyAccountId != null) {
      where.add('m.party_account_id = ?');
      args.add(partyAccountId);
    }
    final rows = await _db.rawQuery(
      'SELECT m.*, a.name AS item_name, p.name AS party_name FROM acc_stock_moves m '
      'JOIN acc_items i ON i.id = m.item_id JOIN acc_accounts a ON a.id = i.account_id '
      'LEFT JOIN acc_accounts p ON p.id = m.party_account_id '
      '${where.isEmpty ? '' : 'WHERE ${where.join(' AND ')}'} ORDER BY m.id DESC LIMIT ?',
      [...args, limit],
    );
    final out = <StockMove>[];
    for (final r in rows) {
      final e = await ledger.entry(r['entry_id'] as int);
      if (e == null) continue;
      out.add(
        StockMove(
          entry: e,
          itemName: r['item_name'] as String,
          qty: r['qty'] as int,
          cost: r['cost'] as int,
          amount: r['amount'] as int,
          partyName: r['party_name'] as String?,
        ),
      );
    }
    return out;
  }

  // ------------------------------------------------------------- FX spread

  /// The spread in cents: |amount ÷ internal − amount ÷ settlement| (as the
  /// web ERP), with [foreign] in the foreign currency (any decimals).
  static int spreadOf(
    double foreign,
    double internalRate,
    double settlementRate,
  ) {
    if (foreign <= 0 || internalRate <= 0 || settlementRate <= 0) return 0;
    return ((foreign / internalRate - foreign / settlementRate).abs() *
            centsPerUnit)
        .round();
  }

  /// «فرق التصريف»: the spread is revenue («أرباح فرق التصريف») held by
  /// [entityId] (a fund or a party), or a loss («خسائر فرق التصريف»).
  /// Cancelling is a reversal (the web ERP deleted the row and left the
  /// profit and the fund as they were).
  Future<JournalEntry> fxSpread({
    required String currency,
    required double foreign,
    required double internalRate,
    required double settlementRate,
    required int entityId,
    bool loss = false,
    String cycle = '',
    String memo = '',
    String? date,
  }) async {
    final spread = spreadOf(foreign, internalRate, settlementRate);
    if (spread <= 0) {
      throw LedgerException('لا فرق بين السعرين أو أن الأرقام غير صحيحة');
    }
    final entity = await ledger.account(entityId);
    final acc = await ledger.byRole(loss ? Roles.expFx : Roles.revFx);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo:
            memo.trim().isEmpty
                ? '${loss ? 'خسارة' : 'ربح'} فرق تصريف ${currency.trim()} — ${entity?.name}'
                : memo.trim(),
        kind: EntryKind.fx,
        meta: {
          'currency': currency.trim(),
          'foreign': foreign,
          'internalRate': internalRate,
          'settlementRate': settlementRate,
          'spread': spread,
          'loss': loss,
          'cycle': cycle,
          'entity': entityId,
        },
        lines:
            loss
                ? [
                  JournalLine(accountId: acc.id, debit: spread),
                  JournalLine(accountId: entityId, credit: spread),
                ]
                : [
                  JournalLine(accountId: entityId, debit: spread),
                  JournalLine(accountId: acc.id, credit: spread),
                ],
      ),
    );
  }

  // ------------------------------------------------------ admin brokerage

  /// «وساطة إدارية»: [amount] comes into a fund; [pctBp] of it is our
  /// commission («عمولات الوساطة الإدارية») and the rest is owed to
  /// [restToId]. (The web ERP put the rest in the main fund with no one
  /// owed it.)
  Future<JournalEntry> adminBrokerage({
    required int amount,
    required int pctBp,
    required int fundId,
    required int restToId,
    String cycle = '',
    String memo = '',
    String? date,
  }) async {
    if (amount <= 0) throw LedgerException('اكتب المبلغ');
    if (pctBp < 0 || pctBp > 10000) throw LedgerException('النسبة بين 0 و100');
    final profit = percentOf(amount, pctBp);
    final rest = amount - profit;
    final rev = await ledger.byRole(Roles.revBrokerage);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo:
            memo.trim().isEmpty
                ? 'وساطة إدارية ${formatPercent(pctBp)}٪${cycle.isEmpty ? '' : ' — $cycle'}'
                : memo.trim(),
        kind: EntryKind.brokerage,
        ref: 'admin_brokerage',
        meta: {
          'amount': amount,
          'pctBp': pctBp,
          'profit': profit,
          'rest': rest,
          'cycle': cycle,
        },
        lines: [
          JournalLine(accountId: fundId, debit: amount),
          if (profit > 0) JournalLine(accountId: rev.id, credit: profit),
          if (rest > 0) JournalLine(accountId: restToId, credit: rest),
        ],
      ),
    );
  }

  // ----------------------------------------------------------- salary swap

  /// «تبديل راتب»: a transfer company takes [gross] of salary (from
  /// [salaryFromId]) for the net after [discountBp]; the discount is our
  /// expense. The net comes now into [fundId] ([firstPayment] of it when
  /// paid in instalments, nothing when on credit) and the rest is owed by
  /// the company.
  Future<JournalEntry> salarySwap({
    required int companyId,
    required int gross,
    required int discountBp,
    required int salaryFromId,
    int? fundId,
    int? firstPayment,
    String memo = '',
    String? date,
  }) async {
    if (gross <= 0) throw LedgerException('اكتب المبلغ');
    if (discountBp < 0 || discountBp > 10000) {
      throw LedgerException('النسبة بين 0 و100');
    }
    final discount = percentOf(gross, discountBp);
    final net = gross - discount;
    final now = fundId == null ? 0 : (firstPayment ?? net);
    if (now < 0 || now > net) {
      throw LedgerException('الدفعة الأولى بين 0 والصافي ${formatCents(net)}');
    }
    final company = await ledger.account(companyId);
    final exp = await ledger.byRole(Roles.expSalarySwap);
    return ledger.post(
      EntryDraft(
        date: date ?? Ledger.today(),
        memo:
            memo.trim().isEmpty ? 'تبديل راتب — ${company?.name}' : memo.trim(),
        kind: EntryKind.salarySwap,
        ref: Parties.ref(companyId),
        meta: {
          'gross': gross,
          'discountBp': discountBp,
          'discount': discount,
          'net': net,
          'now': now,
        },
        lines: [
          if (now > 0) JournalLine(accountId: fundId!, debit: now),
          if (net - now > 0)
            JournalLine(
              accountId: companyId,
              debit: net - now,
              memo: 'باقي الصافي',
            ),
          if (discount > 0)
            JournalLine(
              accountId: exp.id,
              debit: discount,
              memo: 'خصم ${formatPercent(discountBp)}٪',
            ),
          JournalLine(accountId: salaryFromId, credit: gross),
        ],
      ),
    );
  }

  /// Entries of one kind with their details (FX, brokerage, swaps).
  Future<List<JournalEntry>> entriesOf(
    String kind, {
    String? ref,
    int limit = 200,
  }) async {
    final list = await ledger.entries(kind: kind, limit: limit);
    return ref == null
        ? list
        : [
          for (final e in list)
            if (e.ref == ref) e,
        ];
  }
}
