import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/accounting/books.dart';
import 'package:lork_erp/accounting/chart.dart';
import 'package:lork_erp/accounting/ledger.dart';
import 'package:lork_erp/accounting/money.dart';
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
  late Reports reports;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('ledger_test');
    db = await AppDatabase.open(path: '${dir.path}/books.db', factory: factory);
    ledger = Ledger(db.raw);
    await ledger.ensureSeeded();
    books = Books(ledger);
    reports = Reports(ledger);
  });

  tearDown(() async {
    await db.close();
    await dir.delete(recursive: true);
  });

  Future<int> role(String r) async => (await ledger.byRole(r)).id;

  group('money', () {
    test('parses Arabic digits, separators and decimals', () {
      expect(parseCents('1,500.25'), 150025);
      expect(parseCents('١٥٠٠٫٥'), 150050);
      expect(parseCents('  20 '), 2000);
      expect(parseCents('-3.999'), -399);
      expect(parseCents('abc'), isNull);
      expect(parseCents(''), isNull);
      expect(formatCents(150025), '1,500.25');
      expect(formatCents(-5), '−0.05');
      expect(formatCents(100000000), '1,000,000.00');
    });
  });

  group('chart', () {
    test('seeding is idempotent and keeps renamed accounts', () async {
      final n = (await ledger.accounts()).length;
      expect(n, defaultChart.length);
      final main = await ledger.byRole(Roles.mainFund);
      await ledger.renameAccount(main.id, 'صندوق المكتب');
      await ledger.ensureSeeded();
      expect((await ledger.accounts()).length, n);
      expect((await ledger.byRole(Roles.mainFund)).name, 'صندوق المكتب');
    });

    test('a new account takes the parent type and the next code', () async {
      final funds = await ledger.byRole(Roles.funds);
      final a = await ledger.addAccount(name: 'بنك', parentId: funds.id);
      expect(a.code, '1102');
      expect(a.type, AccountType.asset);
      final b = await ledger.addAccount(name: 'محفظة', parentId: funds.id);
      expect(b.code, '1103');
      final opex = await ledger.byRole(Roles.opex);
      final c = await ledger.addAccount(name: 'كهرباء', parentId: opex.id);
      expect(c.code, '5110');
    });

    test(
      'a postable account cannot be a parent; system accounts stay',
      () async {
        final main = await ledger.byRole(Roles.mainFund);
        expect(
          () => ledger.addAccount(name: 'x', parentId: main.id),
          throwsA(isA<LedgerException>()),
        );
        expect(
          () => ledger.deleteAccount(main.id),
          throwsA(isA<LedgerException>()),
        );
      },
    );

    test(
      'an account with lines is not deleted, archived only at zero',
      () async {
        final fund = await books.createFund('صندوق 2', opening: 1000);
        expect(
          () => ledger.deleteAccount(fund.id),
          throwsA(isA<LedgerException>()),
        );
        expect(
          () => ledger.setArchived(fund.id, true),
          throwsA(isA<LedgerException>()),
        );
        final main = await role(Roles.mainFund);
        await books.transfer(fromId: fund.id, toId: main, amount: 1000);
        await ledger.setArchived(fund.id, true);
        expect(
          (await books.funds()).map((f) => f.account.id),
          isNot(contains(fund.id)),
        );
        final empty = await books.createFund('صندوق 3');
        await ledger.deleteAccount(empty.id);
        expect(await ledger.account(empty.id), isNull);
      },
    );
  });

  group('posting', () {
    test('rejects unbalanced, one-line, group and negative entries', () async {
      final main = await role(Roles.mainFund);
      final cap = await role(Roles.capital);
      final funds = await role(Roles.funds);
      final today = Ledger.today();
      Future<void> bad(List<JournalLine> lines) => expectLater(
        ledger.post(EntryDraft(date: today, memo: 'x', lines: lines)),
        throwsA(isA<LedgerException>()),
      );
      await bad([
        JournalLine(accountId: main, debit: 100),
        JournalLine(accountId: cap, credit: 90),
      ]);
      await bad([JournalLine(accountId: main, debit: 100)]);
      await bad([
        JournalLine(accountId: funds, debit: 100),
        JournalLine(accountId: cap, credit: 100),
      ]);
      await bad([
        JournalLine(accountId: main, debit: -100),
        JournalLine(accountId: cap, credit: -100),
      ]);
      await bad([
        JournalLine(accountId: main, debit: 100, credit: 100),
        JournalLine(accountId: cap, credit: 0),
      ]);
      expect(await ledger.entries(), isEmpty);
    });

    test('numbers entries and reverses once', () async {
      final main = await role(Roles.mainFund);
      final cap = await role(Roles.capital);
      final e1 = await books.receipt(
        fundId: main,
        fromAccountId: cap,
        amount: 50000,
        memo: 'رأس مال',
      );
      final e2 = await books.receipt(
        fundId: main,
        fromAccountId: cap,
        amount: 100,
        memo: 'رأس مال 2',
      );
      expect([e1.number, e2.number], [1, 2]);
      expect(await ledger.balanceOf(main), 50100);
      final rev = await ledger.reverse(e1.id);
      expect(rev.number, 3);
      expect(rev.isReversal, isTrue);
      expect((await ledger.entry(e1.id))!.reversed, isTrue);
      expect(await ledger.balanceOf(main), 100);
      expect(() => ledger.reverse(e1.id), throwsA(isA<LedgerException>()));
      expect(() => ledger.reverse(rev.id), throwsA(isA<LedgerException>()));
    });

    test('a fund cannot be overdrawn; a transfer fee is an expense', () async {
      final main = await role(Roles.mainFund);
      final bank = await books.createFund('بنك', opening: 10000);
      expect(
        () => books.transfer(fromId: main, toId: bank.id, amount: 1),
        throwsA(isA<LedgerException>()),
      );
      await books.transfer(fromId: bank.id, toId: main, amount: 9000, fee: 500);
      expect(await ledger.balanceOf(bank.id), 500);
      expect(await ledger.balanceOf(main), 9000);
      expect(await ledger.balanceOf(await role(Roles.expTransferFees)), 500);
      expect(
        () =>
            books.transfer(fromId: bank.id, toId: main, amount: 400, fee: 101),
        throwsA(isA<LedgerException>()),
      );
    });

    test(
      'statement shows a running balance and the opening before from',
      () async {
        final main = await role(Roles.mainFund);
        final cap = await role(Roles.capital);
        await ledger.post(
          EntryDraft(
            date: '2026-01-05',
            memo: 'a',
            lines: [
              JournalLine(accountId: main, debit: 1000),
              JournalLine(accountId: cap, credit: 1000),
            ],
          ),
        );
        await ledger.post(
          EntryDraft(
            date: '2026-02-05',
            memo: 'b',
            lines: [
              JournalLine(accountId: main, debit: 300),
              JournalLine(accountId: cap, credit: 300),
            ],
          ),
        );
        await ledger.post(
          EntryDraft(
            date: '2026-02-10',
            memo: 'c',
            lines: [
              JournalLine(accountId: cap, debit: 200),
              JournalLine(accountId: main, credit: 200),
            ],
          ),
        );
        final st = await ledger.statement(main, from: '2026-02-01');
        expect(st.opening, 1000);
        expect(st.lines.map((l) => l.balance), [1300, 1100]);
        final all = await ledger.statement(main);
        expect(all.lines.length, 3);
        expect((await ledger.balances(to: '2026-01-31'))[main], 1000);
      },
    );
  });

  group('reports', () {
    Future<void> sample() async {
      final main = await role(Roles.mainFund);
      await books.openingBalances({
        main: 100000,
        (await ledger.addAccount(
              name: 'زبون أ',
              parentId: await role(Roles.receivables),
            )).id:
            20000,
        (await ledger.addAccount(
              name: 'مورد ب',
              parentId: await role(Roles.payables),
            )).id:
            -30000,
      }, date: '2026-01-01');
      await books.receipt(
        fundId: main,
        fromAccountId: await role(Roles.revAudit),
        amount: 15000,
        memo: 'أرباح تدقيق',
        date: '2026-11-02',
      );
      final rent = (await books.expenseCategories()).firstWhere(
        (a) => a.name == 'إيجار',
      );
      await books.expense(
        categoryId: rent.id,
        fundId: main,
        amount: 4000,
        memo: 'إيجار تشرين',
        date: '2026-11-03',
      );
      await books.payment(
        fundId: main,
        toAccountId: await role(Roles.drawings),
        amount: 1000,
        memo: 'سحب شخصي',
        date: '2026-11-04',
      );
    }

    test('opening balances post the difference to «أرصدة افتتاحية»', () async {
      await sample();
      final opening = await ledger.balanceOf(await role(Roles.opening));
      expect(opening, -90000); // credit 90,000 = 100,000 + 20,000 − 30,000
    });

    test(
      'trial balance balances; income statement and balance sheet agree',
      () async {
        await sample();
        final tb = await reports.trialBalance();
        expect(tb.balanced, isTrue);
        expect(tb.debit, greaterThan(0));
        final inc = await reports.incomeStatement(
          from: '2026-11-01',
          to: '2026-11-30',
        );
        expect(inc.revenue.balance, 15000);
        expect(inc.expenses.balance, 4000);
        expect(inc.net, 11000);
        final bs = await reports.balanceSheet(date: '2026-11-30');
        expect(bs.assets.balance, 100000 + 20000 + 15000 - 4000 - 1000);
        expect(bs.liabilities.balance, 30000);
        expect(bs.earnings, 11000);
        expect(bs.equity.balance, 90000 - 1000);
        expect(bs.balanced, isTrue);
        final dash = await reports.dashboard(now: DateTime(2026, 11, 20));
        expect(dash.cash, 100000 + 15000 - 4000 - 1000);
        expect(dash.receivables, 20000);
        expect(dash.payables, 30000);
        expect(dash.monthNet, 11000);
      },
    );

    test('a reversal takes the operation out of every report', () async {
      await sample();
      final exp = (await ledger.entries(kind: EntryKind.expense)).single;
      await ledger.reverse(exp.id, date: '2026-11-05');
      final inc = await reports.incomeStatement(
        from: '2026-11-01',
        to: '2026-11-30',
      );
      expect(inc.expenses.balance, 0);
      expect((await reports.balanceSheet(date: '2026-11-30')).balanced, isTrue);
    });
  });
}
