import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/accounting/books.dart';
import 'package:lork_erp/accounting/chart.dart';
import 'package:lork_erp/accounting/ledger.dart';
import 'package:lork_erp/data/app_database.dart';
import 'package:lork_erp/google/google_auth.dart';
import 'package:lork_erp/services/backup_service.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfiNoIsolate;
  late Directory dir;

  setUp(() async => dir = await Directory.systemTemp.createTemp('backup_test'));
  tearDown(() async => dir.delete(recursive: true));

  Future<AppDatabase> open(String name) async {
    final db = await AppDatabase.open(
      path: '${dir.path}/$name.db',
      factory: factory,
    );
    await Ledger(db.raw).ensureSeeded();
    return db;
  }

  test(
    'a backup restores the books and settings into another workspace',
    () async {
      final a = await open('a');
      final books = Books(Ledger(a.raw));
      final bank = await books.createFund('بنك', opening: 250000);
      await books.transfer(
        fromId: bank.id,
        toId: (await books.ledger.byRole(Roles.mainFund)).id,
        amount: 1000,
        fee: 50,
      );
      await a.setValue('some_setting', 'x');
      final bytes = await BackupService(a, GoogleAuth()).export('الشركة أ');
      final info = BackupService.inspect(bytes);
      expect(info.workspace, 'الشركة أ');
      expect(info.entries, 2);
      expect(info.schema, AppDatabase.schemaVersion);

      final b = await open('b');
      final other = Books(Ledger(b.raw));
      await other.createFund('سيُستبدل', opening: 5);
      await BackupService(b, GoogleAuth()).restore(bytes);
      final ledger = Ledger(b.raw);
      final funds = await Books(ledger).funds();
      expect(
        funds.map((f) => f.account.name),
        containsAll(['الصندوق الرئيسي', 'بنك']),
      );
      expect(funds.map((f) => f.account.name), isNot(contains('سيُستبدل')));
      expect(
        funds.firstWhere((f) => f.account.name == 'بنك').balance,
        250000 - 1050,
      );
      expect((await ledger.entries()).length, 2);
      expect(await b.getValue('some_setting'), 'x');
      // The restored books keep working: numbering continues.
      final e = await Books(ledger).receipt(
        fundId: bank.id,
        fromAccountId: (await ledger.byRole(Roles.capital)).id,
        amount: 100,
        memo: 'بعد الاستعادة',
      );
      expect(e.number, 3);
      await a.close();
      await b.close();
    },
  );

  test('a file that is not a backup is refused', () async {
    expect(
      () => BackupService.inspect([1, 2, 3]),
      throwsA(isA<BackupException>()),
    );
  });
}
