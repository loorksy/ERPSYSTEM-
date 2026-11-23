import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/data/app_database.dart';
import 'package:lork_erp/services/adjustments_service.dart';
import 'package:lork_erp/services/audit_job_runner.dart';
import 'package:lork_erp/services/cycle_service.dart';
import 'package:lork_erp/services/payroll_service.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/fake_sheets.dart';

/// A user-info row: id in C, salary in L, status in O (ERP defaults).
List<String> uiRow(String id, String salary) => [
  'n$id',
  '',
  id,
  'وكالة',
  for (var i = 4; i < 11; i++) '',
  salary,
  '',
  '',
  '',
];

final sheet = [
  [
    'A',
    'B',
    'ID',
    'D',
    for (var i = 4; i < 11; i++) 'c$i',
    'Salary',
    'M',
    'N',
    'Status',
  ],
  uiRow('1001', '10'),
  uiRow('1002', '100'),
  uiRow('1003', '40'),
  uiRow('1004', '75'),
];

String status(BulkComputation c, int row) =>
    c.writes.firstWhere((w) => w.row == row).status;
String salary(BulkComputation c, int row) =>
    c.writes.firstWhere((w) => w.row == row).salary;

void main() {
  sqfliteFfiInit();

  test('ERP order: a deduction then an addition leaves a wrong debt', () {
    final erp = AdjustmentsService.computeBulk(
      '1001\tخصم\t50\n1001\tاضافة\t30',
      sheet,
      settle: false,
    );
    // ERP: 10 − 50 → 0 with 40 still owed, then + 30 → 30.
    expect(erp.results.map((r) => r.status), ['باقي عليه', 'تمت الإضافة']);
    expect(salary(erp, 2), '30.00');
    expect(AdjustmentsService.summarize(erp.results).totalDebt, 40);
  });

  test('settlement: additions and deductions of one id are netted first', () {
    final c = AdjustmentsService.computeBulk(
      '1001\tخصم\t50\n1002\tخصم\t20\n1001\tاضافة\t30',
      sheet,
    );
    // 1001: +30 − 50 = −20 on a salary of 10 → 0, 10 still owed.
    expect(c.results.length, 2);
    expect(c.results[0].id, '1001');
    expect(c.results[0].status, 'باقي عليه');
    expect(c.results[0].debt, 10);
    expect(c.results[0].settlement, 'إضافة 30، خصم 50');
    expect(c.results[0].displayStatus, 'باقي عليه (مقاصة)');
    expect(salary(c, 2), '0.00');
    expect(status(c, 2), 'تم خصم 20 (مقاصة: إضافة 30، خصم 50)');
    // 1002 has only a deduction: ERP's line as is.
    expect(c.results[1].status, 'تم الخصم بالكامل');
    expect(salary(c, 3), '80.00');
    expect(status(c, 3), 'تم خصم 20');
  });

  test('settlement with a net addition, a zero net and «خصم كامل»', () {
    final c = AdjustmentsService.computeBulk(
      [
        '1002\tاضافة\t50',
        '1002\tخصم\t20',
        '1003\tخصم\t15',
        '1003\tإضافة\t15',
        '1004\tخصم كامل',
        '1004\tاضافة\t5',
      ].join('\n'),
      sheet,
    );
    expect(salary(c, 3), '130.00');
    expect(status(c, 3), 'تم اضافة 30 (مقاصة: إضافة 50، خصم 20)');
    expect(salary(c, 4), '40.00');
    expect(status(c, 4), 'تمت المقاصة (إضافة 15، خصم 15)');
    // «خصم كامل» is not netted: ERP order (all taken, then + 5).
    expect(c.results.where((r) => r.id == '1004').map((r) => r.status), [
      'تم خصم الدين',
      'تمت الإضافة',
    ]);
    expect(salary(c, 5), '5.00');
  });

  test('unknown ids are reported per line, like ERP', () {
    final c = AdjustmentsService.computeBulk(
      '9999\tخصم\t5\n9999\tاضافة\t7',
      sheet,
    );
    expect(c.results.map((r) => r.status), ['غير موجود', 'غير موجود']);
    expect(AdjustmentsService.summarize(c.results).totalNotFound, 12);
    expect(c.writes, isEmpty);
  });

  test('copy text like ERP (comma decimals and totals)', () {
    final c = AdjustmentsService.computeBulk('1003\tخصم\t60.5', sheet);
    final text = AdjustmentsService.copyText(
      c.results,
      AdjustmentsService.summarize(c.results),
    );
    expect(text.split('\n')[1], '1003\tباقي عليه\t\$20,5');
    expect(text, contains('مجموع المتبقي (لنا عليهم)\t\t\$20,5'));
    expect(text, contains('مجموع تم خصم\t\t\$40'));
  });

  test(
    'results sheet: the list as pasted, one result per user, settlements',
    () {
      const bulk =
          '1002\tخصم\t20\n\n1001\tخصم\t50\n9999\tخصم\t5\n1001\tاضافة\t30\n\n';
      final c = AdjustmentsService.computeBulk(bulk, sheet);
      final out = AdjustOutcome(
        success: true,
        message: '',
        results: c.results,
        summary: AdjustmentsService.summarize(c.results),
        lines: AdjustmentsService.sheetLines(bulk, c),
        settlements: c.settlements,
      );
      final layout = AdjustmentsService.sheetLayout(out);
      final rows = layout.rows;
      expect(rows[0], [
        'رقم المستخدم',
        'الحالة',
        'المبلغ',
        '',
        'رقم المستخدم',
        'الحالة',
        'المبلغ',
      ]);
      // A–C exactly as pasted (blank line kept, both lines of 1001);
      // E–G one row per user, 1001 after the settlement.
      expect(rows[1], [
        '1002',
        'خصم',
        '20',
        '',
        '1002',
        'تم الخصم بالكامل',
        '\$20',
      ]);
      expect(rows[2], ['', '', '', '', '1001', 'باقي عليه', '\$10']);
      expect(rows[3], ['1001', 'خصم', '50', '', '9999', 'غير موجود', '\$5']);
      expect(rows[4], ['9999', 'خصم', '5', '', '', '', '']);
      expect(rows[5], ['1001', 'اضافة', '30', '', '', '', '']);
      expect(rows[6], isEmpty);
      expect(rows[7], [
        '',
        '',
        '',
        '',
        'مجموع المتبقي (لنا عليهم)',
        '',
        '\$10',
      ]);
      expect(rows[8], ['', '', '', '', 'مجموع تم خصم', '', '\$30']);
      expect(rows[9], ['', '', '', '', 'مجموع غير موجود', '', '\$5']);
      // Five empty rows, then the settled users.
      expect(layout.settleHeader, 16);
      expect(rows[15], ['رقم المستخدم', 'الإضافة', 'الخصم', 'الصافي']);
      expect(rows[16], ['1001', 30.0, 50.0, -20.0]);
    },
  );

  test('repeated lines of one user are merged (owner\'s example)', () {
    // Like the owner's list: 1002 twice with 12, an unknown id twice.
    const bulk =
        '1002\tخصم\t12\n1003\tخصم\t12\n1004\tخصم\t8\n9999\tخصم\t48\n1002\tخصم\t12\n9999\tخصم\t2';
    final c = AdjustmentsService.computeBulk(bulk, sheet);
    expect(c.results.where((r) => r.id == '1002').length, 1);
    final r1002 = c.results.firstWhere((r) => r.id == '1002');
    expect(r1002.status, 'تم الخصم بالكامل');
    expect(r1002.amount, 24);
    expect(r1002.merged, '12 + 12');
    expect(r1002.displayStatus, 'تم الخصم بالكامل (دمج)');
    expect(salary(c, 3), '76.00');
    expect(status(c, 3), 'تم خصم 24 (دمج: 12 + 12)');
    // A merge is not a settlement: the table lists only netted users.
    expect(c.settlements, isEmpty);
    final out = AdjustOutcome(
      success: true,
      message: '',
      results: c.results,
      summary: AdjustmentsService.summarize(c.results),
      lines: AdjustmentsService.sheetLines(bulk, c),
      settlements: c.settlements,
    );
    final layout = AdjustmentsService.sheetLayout(out);
    final rows = layout.rows;
    expect(
      [for (final r in rows.skip(1).take(6)) r.take(3).toList()],
      [
        ['1002', 'خصم', '12'],
        ['1003', 'خصم', '12'],
        ['1004', 'خصم', '8'],
        ['9999', 'خصم', '48'],
        ['1002', 'خصم', '12'],
        ['9999', 'خصم', '2'],
      ],
    );
    expect(
      [for (final r in rows.skip(1).take(6)) r.sublist(4)],
      [
        ['1002', 'تم الخصم بالكامل', '\$24'],
        ['1003', 'تم الخصم بالكامل', '\$12'],
        ['1004', 'تم الخصم بالكامل', '\$8'],
        ['9999', 'غير موجود', '\$50'],
        ['', '', ''],
        ['', '', ''],
      ],
    );
    expect(layout.settleHeader, isNull);
  });

  test('second system: state, user state and the arithmetic per row', () {
    final c = AdjustmentsService.computeBulk(
      '1001\tخصم\t50\n1002\tاضافة\t14\n1001\tاضافة\t30\n1002\tاضافة\t15\n1004\tخصم\t5\n1003\tخصم كامل',
      sheet,
    );
    AdjustWrite w(int row) => c.writes.firstWhere((x) => x.row == row);
    expect(
      [w(2).state, w(2).userState, w(2).expression, w(2).tone],
      ['متبقي عليه', 'مديون', '30 - 50', 'r'],
    );
    expect(
      [w(3).state, w(3).userState, w(3).expression, w(3).tone],
      ['اضافة', 'له', '14 + 15', 'g'],
    );
    expect(w(3).salary, '129.00');
    expect(
      [w(5).state, w(5).userState, w(5).expression, w(5).tone],
      ['خصم', 'له', '', 'r'],
    );
    expect([w(4).state, w(4).salary], ['خصم', '0.00']);
  });

  test(
    'upgrading a 2.4 database keeps its jobs and allows cycle-less ones',
    () async {
      final dir = await Directory.systemTemp.createTemp('v4');
      final path = '${dir.path}/erp_audit.db';
      final f = databaseFactoryFfiNoIsolate;
      final old = await f.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 4,
          onCreate: (db, _) async {
            await db.execute(
              'CREATE TABLE financial_cycles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)',
            );
            // audit_jobs exactly as in schema 4.
            await db.execute('''CREATE TABLE audit_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL REFERENCES financial_cycles(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      plan_json TEXT,
      step_next INTEGER NOT NULL DEFAULT 0,
      step_total INTEGER NOT NULL DEFAULT 0,
      progress TEXT,
      error TEXT,
      result_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      seen INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL)''');
            await db.insert('financial_cycles', {'id': 1, 'name': 'c'});
            await db.insert('audit_jobs', {
              'cycle_id': 1,
              'status': 'done',
              'request_json': '{}',
              'step_next': 7,
              'step_total': 7,
              'progress': 'تم',
              'created_at': '2026-11-16T10:00:00',
              'updated_at': '2026-11-16T10:00:00',
            });
          },
        ),
      );
      await old.close();
      final db = await AppDatabase.open(path: path, factory: f);
      final kept = (await db.latestAuditJob(1))!;
      expect(kept.stepNext, 7);
      expect(kept.progress, 'تم');
      final id = await db.createAuditJob(null, {'kind': 'adjustments'});
      expect((await db.getAuditJob(id))!.cycleId, isNull);
      await db.close();
      await dir.delete(recursive: true);
    },
  );

  group('job on Google', () {
    late AppDatabase db;
    late FakeSheets fake;
    late AuditJobRunner runner;

    setUp(() async {
      db = await AppDatabase.open(
        path: inMemoryDatabasePath,
        factory: databaseFactoryFfiNoIsolate,
      );
      fake = FakeSheets()..add('ui', 'Data', sheet);
      final payroll = PayrollService(db, () => fake);
      runner = AuditJobRunner(
        db,
        payroll,
        CycleService(db, () => fake),
        retryDelays: const [],
      );
    });

    tearDown(() => db.close());

    Future<AuditJob> run(String bulk) async {
      final id = await db.createAuditJob(
        null,
        AdjustRequest(
          spreadsheetId: 'ui',
          sheetName: 'Data',
          bulkData: bulk,
        ).toJson(),
      );
      await runner.runPending();
      return (await db.getAuditJob(id))!;
    }

    test(
      'writes salary and status in one batch and keeps the result',
      () async {
        final job = await run('1001\tخصم\t50\n1001\tاضافة\t30\n1004\tاضافة\t5');
        expect(job.status, AuditJob.done, reason: job.error);
        expect(job.cycleId, isNull);
        final rows = fake.books['ui']!['Data']!;
        expect(rows[1][11], '0.00');
        expect(rows[1][14], 'تم خصم 20 (مقاصة: إضافة 30، خصم 50)');
        expect(rows[4][11], '80.00');
        expect(rows[4][14], 'تم اضافة 5');
        expect(fake.log.where((l) => l.startsWith('BATCH VALUES')).length, 1);
        final out = AdjustOutcome.fromJson(
          (await db.getAuditJobResult(job.id))!,
        );
        expect(out.summary!.totalDebt, 10);
        expect(out.summary!.debtUsers, ['1001']);
        expect(await db.latestCyclelessJob(), isNotNull);
      },
    );

    test('a lost connection resumes without applying twice', () async {
      var down = true;
      fake.failWhen = (op, _) {
        if (down && op == 'valuesBatchUpdate') {
          down = false;
          return true;
        }
        return false;
      };
      final first = await run('1002\tخصم\t30');
      expect(first.status, AuditJob.waiting);
      expect(fake.books['ui']!['Data']![2][11], '100');
      await runner.runPending();
      final job = (await db.getAuditJob(first.id))!;
      expect(job.status, AuditJob.done, reason: job.error);
      expect(fake.books['ui']!['Data']![2][11], '70.00');
      // Running the same job again writes the same values (no double −30).
      await AdjustmentsService(db, () => fake).runStep(
        AdjustPlan.fromJson((await db.getAuditJobPlan(job.id))!),
        1,
        (_) {},
      );
      expect(fake.books['ui']!['Data']![2][11], '70.00');
    });

    test('stops if a salary changed while waiting', () async {
      var down = true;
      fake.failWhen = (op, _) {
        if (down && op == 'valuesBatchUpdate') {
          down = false;
          return true;
        }
        return false;
      };
      final first = await run('1002\tخصم\t30');
      expect(first.status, AuditJob.waiting);
      // Meanwhile the salary was edited by hand; the job restarts at the
      // check step after a restart of the app.
      fake.books['ui']!['Data']![2][11] = '500';
      await db.updateAuditJob(first.id, {'step_next': 0});
      await runner.runPending();
      final job = (await db.getAuditJob(first.id))!;
      expect(job.status, AuditJob.failed);
      expect(job.error, contains('الصف 3'));
      expect(fake.books['ui']!['Data']![2][11], '500');
    });

    test(
      'pushes the results to a new sheet, once, even after a drop',
      () async {
        final job = await run('1001\tخصم\t50\n1001\tاضافة\t30\n1004\tاضافة\t5');
        final service = AdjustmentsService(db, () => fake);
        var out = AdjustOutcome.fromJson((await db.getAuditJobResult(job.id))!);
        expect(out.lines.length, 3);
        Future<void> save(AdjustOutcome o) =>
            db.updateAuditJob(job.id, {'result_json': jsonEncode(o.toJson())});
        var down = true;
        fake.failWhen = (op, payload) {
          if (down && op == 'valuesUpdate' && '$payload'.contains('إضافات')) {
            down = false;
            return true;
          }
          return false;
        };
        Object? error;
        try {
          await service.pushResults('ui', out, save);
        } catch (e) {
          error = e;
        }
        expect(error, isNotNull);
        // The sheet exists and is remembered; the retry writes into it.
        out = AdjustOutcome.fromJson((await db.getAuditJobResult(job.id))!);
        expect(out.pushedSheet, 'إضافات وخصومات');
        expect(out.pushed, isFalse);
        out = await service.pushResults('ui', out, save);
        expect(out.pushed, isTrue);
        expect(
          fake.books['ui']!.keys.where((k) => k.startsWith('إضافات')).toList(),
          ['إضافات وخصومات'],
        );
        final written = fake.books['ui']!['إضافات وخصومات']!;
        // A–C as pasted; E–G one row per user (1001 nets to −20).
        expect(written[1], [
          '1001',
          'خصم',
          '50',
          '',
          '1001',
          'باقي عليه',
          '\$10',
        ]);
        expect(written[2], [
          '1001',
          'اضافة',
          '30',
          '',
          '1004',
          'تمت الإضافة',
          '\$5',
        ]);
        expect(written[3].sublist(0, 3), ['1004', 'اضافة', '5']);
        expect(
          written.any(
            (r) => r.length > 3 && r[0] == 'رقم المستخدم' && r[3] == 'الصافي',
          ),
          isTrue,
        );
        expect(fake.log.any((l) => l.contains('updateBorders')), isTrue);

        // Another processing goes to a second sheet, not over the first.
        final next = await run('1002\tاضافة\t1');
        final out2 = await service.pushResults(
          'ui',
          AdjustOutcome.fromJson((await db.getAuditJobResult(next.id))!),
          (_) async {},
        );
        expect(out2.pushedSheet, 'إضافات وخصومات 2');
      },
    );

    Future<AuditJob> runColumn(String bulk, String out) async {
      final id = await db.createAuditJob(
        null,
        AdjustRequest(
          spreadsheetId: 'ui',
          sheetName: 'Data',
          bulkData: bulk,
          outputCol: out,
        ).toJson(),
      );
      await runner.runPending();
      return (await db.getAuditJob(id))!;
    }

    test(
      'second system: the salary goes to the chosen column, coloured',
      () async {
        const bulk =
            '1001\tخصم\t50\n1001\tاضافة\t30\n1002\tاضافة\t14\n1002\tاضافة\t15\n1004\tخصم\t5';
        final job = await runColumn(bulk, 'P');
        expect(job.status, AuditJob.done, reason: job.error);
        final rows = fake.books['ui']!['Data']!;
        expect(rows[0].sublist(15, 19), [
          'الراتب بعد التسوية',
          'الحالة',
          'حالة المستخدم',
          'العملية الحسابية',
        ]);
        // The salary and status columns are not touched.
        expect([rows[1][11], rows[1][14]], ['10', '']);
        expect(rows[1].sublist(15, 19), [
          '0',
          'متبقي عليه',
          'مديون',
          "'30 - 50",
        ]);
        expect(rows[2].sublist(15, 19), ['129', 'اضافة', 'له', "'14 + 15"]);
        expect(rows[4].sublist(15, 19), ['70', 'خصم', 'له', '']);
        expect(rows[3].length, 15);
        final dataId = fake.ids['ui']!['Data'];
        expect(fake.cellColors['ui|$dataId|15'], {
          1: AdjustmentsService.toneRed,
          2: AdjustmentsService.toneGreen,
          4: AdjustmentsService.toneRed,
        });
        expect(fake.cellColors['ui|$dataId|17'], {
          1: AdjustmentsService.toneRed,
          2: AdjustmentsService.toneGreen,
          4: AdjustmentsService.toneGreen,
        });
        // The same list again gives the same cells (the base is column L).
        await runColumn(bulk, 'P');
        expect(rows[2].sublist(15, 19), ['129', 'اضافة', 'له', "'14 + 15"]);
        final out = AdjustOutcome.fromJson(
          (await db.getAuditJobResult(job.id))!,
        );
        expect(out.settlements.single.id, '1001');
      },
    );

    test('second system: adds columns when the grid is too narrow', () async {
      final job = await runColumn('1002\tاضافة\t1', 'X');
      expect(job.status, AuditJob.done, reason: job.error);
      expect(fake.log.any((l) => l.contains('appendDimension')), isTrue);
      expect(fake.books['ui']!['Data']![2][23], '101');
    });

    test(
      'second system: the four columns may not cover id or salary',
      () async {
        final job = await runColumn('1002\tاضافة\t1', 'J');
        expect(job.status, AuditJob.failed);
        expect(job.error ?? '', contains('عمود الراتب بعد التسوية'));
        expect(fake.books['ui']!['Data']![2][11], '100');
      },
    );

    test('a missing sheet stops with a clear message', () async {
      final id = await db.createAuditJob(
        null,
        const AdjustRequest(
          spreadsheetId: 'ui',
          sheetName: 'تدقيق',
          bulkData: '1002\tخصم\t5',
        ).toJson(),
      );
      await runner.runPending();
      final job = (await db.getAuditJob(id))!;
      expect(job.status, AuditJob.failed);
      expect((job.error ?? '').contains('الورقة «تدقيق» غير موجودة'), isTrue);
      expect(fake.books['ui']!['Data']![2][11], '100');
    });

    test('adjustments do not wait for or block cycle audits', () async {
      final job = await run('1001\tاضافة\t1');
      expect(job.status, AuditJob.done);
      expect(await db.latestAuditJob(1), isNull);
    });
  });
}
