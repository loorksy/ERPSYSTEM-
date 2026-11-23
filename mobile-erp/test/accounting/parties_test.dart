import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/accounting/books.dart';
import 'package:lork_erp/accounting/chart.dart';
import 'package:lork_erp/accounting/ledger.dart';
import 'package:lork_erp/accounting/parties.dart';
import 'package:lork_erp/accounting/reports.dart';
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
  late Reports reports;
  late int main;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('parties_test');
    db = await AppDatabase.open(path: '${dir.path}/b.db', factory: factory);
    ledger = Ledger(db.raw);
    await ledger.ensureSeeded();
    books = Books(ledger);
    parties = Parties(ledger, books);
    reports = Reports(ledger);
    main = (await ledger.byRole(Roles.mainFund)).id;
    await books.receipt(
      fundId: main,
      fromAccountId: (await ledger.byRole(Roles.capital)).id,
      amount: 1000000,
      memo: 'رأس مال',
    );
  });

  tearDown(() async {
    await db.close();
    await dir.delete(recursive: true);
  });

  Future<int> bal(int id) => ledger.balanceOf(id);

  test(
    'a party is an account under its group, with an opening balance',
    () async {
      final a = await parties.add(
        PartyKind.accreditation,
        'معتمد حلب',
        code: 'A1',
        percentBp: 250,
        opening: -50000,
      );
      expect(a.account.code, startsWith('14'));
      expect(a.balance, -50000);
      expect(a.toThem, 50000);
      expect(a.percent, 2.5);
      expect(
        () => parties.add(PartyKind.accreditation, 'معتمد حلب'),
        throwsA(isA<LedgerException>()),
      );
      final c = await parties.add(PartyKind.transferCompany, 'الهرم');
      expect(c.account.code, startsWith('15'));
      expect(
        (await parties.list(PartyKind.accreditation)).single.name,
        'معتمد حلب',
      );
    },
  );

  test('salary with brokerage: the fund gets all, we owe the rest', () async {
    final a = await parties.add(PartyKind.accreditation, 'م');
    await parties.salaryWithBrokerage(
      a.account.id,
      100000,
      fundId: main,
      brokerageBp: 1000,
    );
    expect(await bal(main), 1000000 + 100000);
    expect(await bal(a.account.id), -90000);
    expect(await bal((await ledger.byRole(Roles.revAccBrokerage)).id), -10000);
  });

  test(
    'debt to them with discount; debt to us; receive; pay; transfer',
    () async {
      final a = await parties.add(PartyKind.accreditation, 'م');
      final t = await parties.add(PartyKind.transferCompany, 'ش');
      await parties.debtToThem(
        a.account.id,
        20000,
        counterId: main,
        discountBp: 500,
      );
      expect(await bal(a.account.id), -19000);
      expect(
        await bal((await ledger.byRole(Roles.revPayableDiscount)).id),
        -1000,
      );
      await parties.debtToUs(a.account.id, 5000, counterId: main);
      expect(await bal(a.account.id), -14000);
      await parties.pay(a.account.id, 14000, fundId: main);
      expect(await bal(a.account.id), 0);
      await parties.pay(t.account.id, 30000, fundId: main);
      await parties.transfer(t.account.id, a.account.id, 10000);
      expect(await bal(t.account.id), 20000);
      expect(await bal(a.account.id), 10000);
      await parties.receive(t.account.id, 20000, fundId: main, returned: true);
      expect(await bal(t.account.id), 0);
      expect(
        () => parties.pay(t.account.id, 99999999, fundId: main),
        throwsA(isA<LedgerException>()),
      );
    },
  );

  test('sub-agency cycle share and reward', () async {
    final s = await parties.add(
      PartyKind.subAgency,
      'وكالة النجوم',
      percentBp: 1000,
    );
    final a = await parties.add(PartyKind.accreditation, 'المعتمد الرئيسي');
    await parties.cycleShare(
      s.account.id,
      50000,
      counterId: a.account.id,
      companyBp: s.percentBp,
      cycle: 'الدورة 1',
    );
    expect(await bal(s.account.id), -45000);
    expect(await bal(a.account.id), 50000);
    expect(await bal((await ledger.byRole(Roles.revSubAgency)).id), -5000);
    await parties.reward(s.account.id, 2000);
    expect(await bal(s.account.id), -47000);
    await parties.reward(s.account.id, 1000, fundId: main);
    expect(await bal(s.account.id), -47000);
    expect(await bal((await ledger.byRole(Roles.expSubAgency)).id), 3000);
  });

  test('payment due is paid from a fund in one entry', () async {
    final a = await parties.add(PartyKind.accreditation, 'م', opening: -30000);
    final s = await parties.add(PartyKind.subAgency, 'و', opening: -20000);
    await parties.add(PartyKind.accreditation, 'لنا', opening: 7000);
    final due = await parties.paymentDue();
    expect(due.map((p) => p.name).toSet(), {'م', 'و'});
    final e = await parties.settle({
      a.account.id: 30000,
      s.account.id: 5000,
    }, fundId: main);
    expect(e.lines.length, 3);
    expect(await bal(a.account.id), 0);
    expect(await bal(s.account.id), -15000);
  });

  test('credit-balance parties are liabilities in the balance sheet', () async {
    await parties.add(PartyKind.accreditation, 'علينا', opening: -30000);
    await parties.add(PartyKind.transferCompany, 'لنا', opening: 12000);
    final bs = await reports.balanceSheet();
    expect(bs.balanced, isTrue);
    expect(bs.liabilities.balance, 30000);
    expect(bs.assets.balance, 1000000 + 12000);
    final d = await reports.dashboard();
    expect(d.receivables, 12000);
    expect(d.payables, 30000);
  });

  test('bulk balances create parties and one opening entry', () async {
    final rows = Parties.parseLines(
      'أحمد\t1,200\nسعيد 300.5\n\nسطر بلا مبلغ\nأحمد ٢٠٠',
    );
    expect(rows.length, 3);
    final r = await parties.importBalances(
      PartyKind.accreditation,
      rows,
      toUs: false,
    );
    expect(r.created, 2);
    final list = await parties.list(PartyKind.accreditation);
    expect(list.firstWhere((p) => p.name == 'أحمد').balance, -140000);
    expect(list.firstWhere((p) => p.name == 'سعيد').balance, -30050);
  });

  test(
    'a v0.1 workspace that used code 14 still gets the new groups',
    () async {
      final assets = (await ledger.accounts()).firstWhere((a) => a.code == '1');
      // Simulate: drop the seeded group 14 and add a user group with code 14.
      final g = await ledger.byRole(Roles.accreditations);
      await db.raw.delete('acc_accounts', where: 'id = ?', whereArgs: [g.id]);
      await db.raw.insert('acc_accounts', {
        'code': '14',
        'name': 'سلف',
        'type': 'asset',
        'parent_id': assets.id,
        'is_group': 1,
        'system': 0,
        'created_at': 'x',
      });
      await ledger.ensureSeeded();
      final again = await ledger.byRole(Roles.accreditations);
      expect(again.code, isNot('14'));
      expect(again.parentId, assets.id);
    },
  );
}
