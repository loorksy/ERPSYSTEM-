import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/accounting/books.dart';
import 'package:lork_erp/accounting/chart.dart';
import 'package:lork_erp/accounting/ledger.dart';
import 'package:lork_erp/accounting/parties.dart';
import 'package:lork_erp/accounting/trading.dart';
import 'package:lork_erp/data/app_database.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfiNoIsolate;

  test(
    'a 0.1.0 database (schema 6) upgrades to 7 and keeps its books',
    () async {
      final dir = await Directory.systemTemp.createTemp('upgrade_test');
      final path = '${dir.path}/b.db';
      // Build the 0.1.0 shape: schema 6 without meta and the v7 tables.
      var db = await AppDatabase.open(path: path, factory: factory);
      var ledger = Ledger(db.raw);
      await ledger.ensureSeeded();
      final main = (await ledger.byRole(Roles.mainFund)).id;
      await Books(ledger).receipt(
        fundId: main,
        fromAccountId: (await ledger.byRole(Roles.capital)).id,
        amount: 12345,
        memo: 'قبل التحديث',
      );
      for (final t in ['acc_stock_moves', 'acc_items', 'acc_parties']) {
        await db.raw.execute('DROP TABLE $t');
      }
      await db.raw.execute('DROP INDEX acc_entries_ref');
      await db.raw.execute('ALTER TABLE acc_entries DROP COLUMN meta');
      for (final role in [
        'accreditations',
        'transfer_companies',
        'sub_agencies',
        'carriers',
        'members',
        'rev_mgmt_w',
      ]) {
        await db.raw.delete(
          'acc_accounts',
          where: 'role = ?',
          whereArgs: [role],
        );
      }
      await db.raw.execute('PRAGMA user_version = 6');
      await db.close();

      db = await AppDatabase.open(path: path, factory: factory);
      ledger = Ledger(db.raw);
      await ledger.ensureSeeded();
      final books = Books(ledger);
      final trading = Trading(ledger, books);
      await trading.ensureItems();
      expect(await ledger.balanceOf(main), 12345);
      expect((await ledger.entries()).single.meta, isEmpty);
      final a = await Parties(
        ledger,
        books,
      ).add(PartyKind.accreditation, 'بعد التحديث', opening: -500);
      expect(a.balance, -500);
      expect((await trading.items()).length, 2);
      await db.close();
      await dir.delete(recursive: true);
    },
  );
}
