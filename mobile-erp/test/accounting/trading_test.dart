import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/accounting/books.dart';
import 'package:lork_erp/accounting/chart.dart';
import 'package:lork_erp/accounting/ledger.dart';
import 'package:lork_erp/accounting/parties.dart';
import 'package:lork_erp/accounting/reports.dart';
import 'package:lork_erp/accounting/trading.dart';
import 'package:lork_erp/data/app_database.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfiNoIsolate;
  late Directory dir;
  late AppDatabase db;
  late Ledger ledger;
  late Books books;
  late Parties parties;
  late Trading trading;
  late Reports reports;
  late int main;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('trading_test');
    db = await AppDatabase.open(path: '${dir.path}/b.db', factory: factory);
    ledger = Ledger(db.raw);
    await ledger.ensureSeeded();
    books = Books(ledger);
    parties = Parties(ledger, books);
    trading = Trading(ledger, books);
    reports = Reports(ledger);
    main = (await ledger.byRole(Roles.mainFund)).id;
    await books.receipt(
      fundId: main,
      fromAccountId: (await ledger.byRole(Roles.capital)).id,
      amount: 1000000,
      memo: 'رأس مال',
    );
    await trading.ensureItems();
  });

  tearDown(() async {
    await db.close();
    await dir.delete(recursive: true);
  });

  test('quantities parse with three decimals', () {
    expect(parseQty('1.5'), 1500);
    expect(parseQty('١٫٢٥'), 1250);
    expect(parseQty('1,000'), 1000000);
    expect(parseQty('x'), isNull);
    expect(formatQty(1500), '1.5');
    expect(formatQty(2000000), '2,000');
  });

  test('weighted average cost, COGS and profit', () async {
    final gold = (await trading.items()).firstWhere((i) => i.name == 'ذهب');
    await trading.buy(gold.id, 10000, 100000, payFromId: main); // 10 @ 100
    await trading.buy(gold.id, 10000, 140000, payFromId: main); // 10 @ 140
    var it = (await trading.item(gold.id))!;
    expect(it.qty, 20000);
    expect(it.value, 240000);
    expect(it.average, 12000);
    final member = await parties.add(PartyKind.member, 'عضو 77', code: '77');
    final r = await trading.sell(
      gold.id,
      5000,
      80000,
      receiveIntoId: member.account.id,
    );
    expect(r.cost, 60000);
    expect(r.profit, 20000);
    it = (await trading.item(gold.id))!;
    expect(it.qty, 15000);
    expect(it.value, 180000);
    expect(await ledger.balanceOf(member.account.id), 80000);
    final inc = await reports.incomeStatement();
    expect(inc.net, 20000);
    expect(
      () => trading.sell(gold.id, 99000, 1, receiveIntoId: main),
      throwsA(isA<LedgerException>()),
    );
    // Selling everything leaves no value behind.
    await trading.sell(gold.id, 15000, 300000, receiveIntoId: main);
    it = (await trading.item(gold.id))!;
    expect(it.qty, 0);
    expect(it.value, 0);
    expect(
      (await trading.moves(partyAccountId: member.account.id)).single.profit,
      20000,
    );
  });

  test('a purchase cannot be reversed once sold; a sale can', () async {
    final gold = (await trading.items()).first;
    final buy = await trading.buy(gold.id, 10000, 100000, payFromId: main);
    final sale = await trading.sell(gold.id, 4000, 60000, receiveIntoId: main);
    expect(() => ledger.reverse(buy.id), throwsA(isA<LedgerException>()));
    await ledger.reverse(sale.entry.id);
    var it = (await trading.item(gold.id))!;
    expect(it.qty, 10000);
    expect(it.value, 100000);
    await ledger.reverse(buy.id);
    it = (await trading.item(gold.id))!;
    expect(it.qty, 0);
    expect(it.value, 0);
    expect((await reports.balanceSheet()).balanced, isTrue);
  });

  test('FX spread posts a profit and is cancelled by a reversal', () async {
    expect(Trading.spreadOf(34000, 32, 34), 6250);
    final e = await trading.fxSpread(
      currency: 'TRY',
      foreign: 34000,
      internalRate: 32,
      settlementRate: 34,
      entityId: main,
    );
    expect(e.meta['spread'], 6250);
    expect(
      await ledger.balanceOf((await ledger.byRole(Roles.revFx)).id),
      -6250,
    );
    await ledger.reverse(e.id);
    expect(await ledger.balanceOf((await ledger.byRole(Roles.revFx)).id), 0);
    expect(
      () => trading.fxSpread(
        currency: 'TRY',
        foreign: 1,
        internalRate: 5,
        settlementRate: 5,
        entityId: main,
      ),
      throwsA(isA<LedgerException>()),
    );
  });

  test('admin brokerage splits into commission and what is owed', () async {
    final a = await parties.add(PartyKind.accreditation, 'م');
    await trading.adminBrokerage(
      amount: 100000,
      pctBp: 1500,
      fundId: main,
      restToId: a.account.id,
    );
    expect(await ledger.balanceOf(main), 1100000);
    expect(await ledger.balanceOf(a.account.id), -85000);
    expect(
      await ledger.balanceOf((await ledger.byRole(Roles.revBrokerage)).id),
      -15000,
    );
  });

  test(
    'salary swap: cash now, rest owed by the company, discount expense',
    () async {
      final c = await parties.add(PartyKind.transferCompany, 'ش');
      final a = await parties.add(PartyKind.accreditation, 'المعتمد');
      await trading.salarySwap(
        companyId: c.account.id,
        gross: 100000,
        discountBp: 1000,
        salaryFromId: a.account.id,
        fundId: main,
        firstPayment: 30000,
      );
      expect(await ledger.balanceOf(main), 1030000);
      expect(await ledger.balanceOf(c.account.id), 60000);
      expect(
        await ledger.balanceOf((await ledger.byRole(Roles.expSalarySwap)).id),
        10000,
      );
      expect(await ledger.balanceOf(a.account.id), -100000);
    },
  );
}
