import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/accounting/books.dart';
import 'package:lork_erp/accounting/chart.dart';
import 'package:lork_erp/accounting/cycle_posting.dart';
import 'package:lork_erp/accounting/ledger.dart';
import 'package:lork_erp/accounting/parties.dart';
import 'package:lork_erp/accounting/reports.dart';
import 'package:lork_erp/data/app_database.dart';
import 'package:lork_erp/google/sheets_client.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/fake_sheets.dart';

List<String> mgmtRow(String id, String name, num w, num y, num z) {
  final r = List<String>.filled(26, '');
  r[0] = id;
  r[1] = name;
  r[22] = '$w';
  r[24] = '$y';
  r[25] = '$z';
  return r;
}

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfiNoIsolate;
  late Directory dir;
  late AppDatabase db;
  late Ledger ledger;
  late Parties parties;
  late CyclePosting posting;
  late Reports reports;
  late int main;
  late int cycleId;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('cycle_post_test');
    db = await AppDatabase.open(path: '${dir.path}/b.db', factory: factory);
    ledger = Ledger(db.raw);
    await ledger.ensureSeeded();
    final books = Books(ledger);
    parties = Parties(ledger, books);
    posting = CyclePosting(ledger, db, parties);
    reports = Reports(ledger);
    main = (await ledger.byRole(Roles.mainFund)).id;
    cycleId = await db.insertCycle(
      name: 'الدورة 7',
      transferDiscountPct: 10,
      managementRows: [
        ['ID', 'الاسم', ...List.filled(24, '')],
        mgmtRow('1001', 'أ', 100, 5, 2.5),
        mgmtRow('1002', 'ب', 50.25, 0, 1),
      ],
      agentRows: [
        ['ID', 'الاسم', 'C', 'الراتب'],
        ['1001', 'أ', '', '200'],
        ['1003', 'ج', '', '50.5'],
        ['', '', '', '999'],
      ],
    );
  });

  tearDown(() async {
    await db.close();
    await dir.delete(recursive: true);
  });

  test('figures from the saved sheets', () async {
    final f = await posting.figures(cycleId);
    expect(f.hasData, isTrue);
    expect(f.agentSalaries, 25050);
    expect(f.discount, 2505);
    expect(f.mgmtW, 15025);
    expect(f.mgmtYZ, 850);
  });

  test('posting a part twice replaces it (reversal + new entry)', () async {
    final acc = await parties.add(PartyKind.accreditation, 'المعتمد الرئيسي');
    await posting.postAgent(
      cycleId,
      receivedInId: main,
      accreditationId: acc.account.id,
    );
    expect(await ledger.balanceOf(main), 25050);
    expect(await ledger.balanceOf(acc.account.id), -22545);
    expect(
      await ledger.balanceOf(
        (await ledger.byRole(Roles.revTransferDiscount)).id,
      ),
      -2505,
    );
    await posting.postAgent(
      cycleId,
      receivedInId: main,
      accreditationId: acc.account.id,
      salaries: 30000,
      discount: 3000,
    );
    expect(await ledger.balanceOf(main), 30000);
    expect(await ledger.balanceOf(acc.account.id), -27000);
    expect(
      (await posting.posted(cycleId, CyclePart.agent))!.meta['salaries'],
      30000,
    );
  });

  test('management and sub-agency shares make the right profit', () async {
    await posting.postManagement(cycleId, receivedInId: main);
    final sa = await parties.add(
      PartyKind.subAgency,
      'وكالة النجوم',
      percentBp: 2000,
    );
    await posting.postShares(cycleId, {sa.account.id: 10000});
    expect(await ledger.balanceOf(sa.account.id), -8000);
    final inc = await reports.incomeStatement();
    // W 150.25 − agency 80 (its share) + Y+Z 8.50 = 78.75
    expect(inc.net, 15025 - 8000 + 850);
    await posting.postShares(cycleId, {sa.account.id: 5000});
    expect(await ledger.balanceOf(sa.account.id), -4000);
    expect((await reports.balanceSheet()).balanced, isTrue);
  });

  test(
    'agency totals read every agency sheet of the management file',
    () async {
      final fake = FakeSheets();
      fake.add('m', 'الإدارة', [
        ['ID'],
      ]);
      fake.add('m', 'وكالة النجوم', [
        ['ID', 'الاسم'],
        mgmtRow('1', 'x', 40, 0, 0),
        mgmtRow('2', 'y', 2.5, 0, 0),
      ]);
      fake.add('m', 'وكالة القمر', [mgmtRow('3', 'z', 10, 0, 0)]);
      final id = await db.insertCycle(
        name: 'G',
        managementRows: null,
        agentRows: null,
        managementSpreadsheetId: 'm',
        managementSheetName: 'الإدارة',
      );
      final t = await CyclePosting.agencyTotals(
        (await db.getCycleInfo(id))!,
        fake as SheetsApi,
      );
      expect(t, {'وكالة النجوم': 4250, 'وكالة القمر': 1000});
    },
  );
}
