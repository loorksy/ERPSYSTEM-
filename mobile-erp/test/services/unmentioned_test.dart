import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/data/app_database.dart';
import 'package:lork_erp/erp/payroll_audit_engine.dart';
import 'package:lork_erp/google/sheets_client.dart';
import 'package:lork_erp/services/audit_job_runner.dart';
import 'package:lork_erp/services/cycle_service.dart';
import 'package:lork_erp/services/payroll_service.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/fake_sheets.dart';

/// A management row 30 columns wide, like the owner's sheet; [w] is the
/// sub-agent amount in column W.
List<String> mgmtRow(String id, String name, String w) => [
  id,
  name,
  'F',
  for (var i = 3; i < 22; i++) '0',
  w,
  for (var i = 23; i < 30; i++) '0',
];

final mgmtSheet = [
  ['ID', 'Name', for (var i = 2; i < 30; i++) 'c$i'],
  mgmtRow('1001', 'أحمد', '2.0'),
  mgmtRow('1002', 'سارة', '0.0'),
  mgmtRow('1003', 'علي', '5'),
  mgmtRow('1004', 'منى', ''),
  mgmtRow('1005', 'ريتا', '1٫5'),
  mgmtRow('1006', 'نانو', '3.00'),
];
final agentSheet = [
  ['ID', 'الوكالة', 'الاسم', 'الراتب'],
  ['1001', 'Abu', 'أحمد', '100'],
  ['1002', 'Abu', 'سارة', '60'],
  ['1002', 'Abu', 'سارة', '40'],
  ['1007', 'Abu', 'باسم', '30'],
];
final userInfoSheet = [
  ['A', 'B', 'رقم المستخدم', 'الوكالة', 'الدولة'],
  ['x1', '', '1001', 'وكيل الشمال', 'SY'],
  ['x3', '', '1003', 'وكيل الجنوب', 'TR'],
];

void main() {
  sqfliteFfiInit();
  late AppDatabase db;
  late FakeSheets fake;
  late PayrollService payroll;
  late AuditJobRunner runner;

  setUp(() async {
    db = await AppDatabase.open(
      path: inMemoryDatabasePath,
      factory: databaseFactoryFfiNoIsolate,
    );
    fake =
        FakeSheets()
          ..add('cyc', 'الإدارة', mgmtSheet)
          ..add('cyc', 'الوكيل', agentSheet)
          ..add('ui', 'Data', userInfoSheet);
    payroll = PayrollService(db, () => fake);
    runner = AuditJobRunner(
      db,
      payroll,
      CycleService(db, () => fake),
      retryDelays: const [],
    );
  });

  tearDown(() => db.close());

  PayrollRequest request(int id) => PayrollRequest(
    cycleId: id,
    userInfo: const GoogleUserInfo('ui', 'Data'),
    discountRate: 10,
    agentColor: '#8b5cf6',
    managementColor: '#facc15',
    columns: const AuditColumns(),
  );

  Future<int> linkedCycle() => db.insertCycle(
    name: 'مرتبطة',
    managementRows: const [],
    agentRows: const [],
    managementSpreadsheetId: 'cyc',
    managementSheetName: 'الإدارة',
    agentSpreadsheetId: 'cyc',
    agentSheetName: 'الوكيل',
  );

  Future<AuditJob> runJob(int cycleId, String kind) async {
    final jobId = await db.createAuditJob(cycleId, {
      ...request(cycleId).toJson(),
      'kind': kind,
      'unmentioned': const UnmentionedOptions().toJson(),
    });
    await runner.runPending();
    return (await db.getAuditJob(jobId))!;
  }

  Future<PayrollResult> resultOf(AuditJob job) async =>
      PayrollResult.fromJson((await db.getAuditJobResult(job.id))!);

  int mgmtSheetId() => fake.ids['cyc']!['الإدارة']!;
  int agentSheetId() => fake.ids['cyc']!['الوكيل']!;

  test(
    'unmentioned agent users are added to user info once, then audited',
    () async {
      final id = await linkedCycle();
      final job = await runJob(id, JobKind.unmentionedUsers);
      expect(job.status, AuditJob.done, reason: job.error);
      final ui = fake.books['ui']!['Data']!;
      expect(ui.length, 5);
      // The earlier rows are untouched (no salary or status written).
      expect(ui[1], ['x1', '', '1001', 'وكيل الشمال', 'SY']);
      expect(ui[2], ['x3', '', '1003', 'وكيل الجنوب', 'TR']);
      // 1002 has two agent rows but is added once; A and C hold the id,
      // D and E «غير مذكور»; salary L and status M by the audit logic.
      expect(ui[3].sublist(0, 5), [
        '1002',
        '',
        '1002',
        'غير مذكور',
        'غير مذكور',
      ]);
      expect(ui[3][11], '90');
      expect(ui[3][12], 'سحب وكيل راتبين');
      // 1007 is not in the management sheet: «غير موجود», salary 0.
      expect(ui[4].sublist(0, 5), [
        '1007',
        '',
        '1007',
        'غير مذكور',
        'غير مذكور',
      ]);
      expect(ui[4][11], '0');
      expect(ui[4][12], 'غير موجود');

      // The title column sends 1002's management row to «غير مذكور».
      expect(fake.books['cyc']!['غير مذكور'], [mgmtRow('1002', 'سارة', '0.0')]);
      expect(fake.colors['cyc|${mgmtSheetId()}'], {2: '#8b5cf6'});
      expect(fake.colors['cyc|${agentSheetId()}'], {
        2: '#8b5cf6',
        3: '#8b5cf6',
      });

      final r = await resultOf(job);
      expect(r.summary!.total, 2);
      expect(r.summary!.agent, 1);
      expect(r.summary!.notFound, 1);
      expect(r.message, contains('الصفوف 4–5'));
      expect((await db.auditedMemberIds(id)), contains('1002'));

      // Again: nothing is missing any more, nothing is written twice.
      final again = await runJob(id, JobKind.unmentionedUsers);
      expect(again.status, AuditJob.done);
      expect((await resultOf(again)).message, contains('لا يوجد'));
      expect(fake.books['ui']!['Data']!.length, 5);
      expect(fake.books['cyc']!['غير مذكور']!.length, 1);
    },
  );

  test(
    'adding rows resumes after a lost connection without duplicates',
    () async {
      final id = await linkedCycle();
      var down = true;
      fake.failWhen = (op, payload) {
        if (down && op == 'valuesUpdate' && '$payload'.contains("'Data'!A4")) {
          down = false;
          return true;
        }
        return false;
      };
      final first = await runJob(id, JobKind.unmentionedUsers);
      expect(first.status, AuditJob.waiting);
      expect(fake.books['ui']!['Data']!.length, 3);
      await runner.runPending();
      final job = (await db.getAuditJob(first.id))!;
      expect(job.status, AuditJob.done, reason: job.error);
      expect(fake.books['ui']!['Data']!.length, 5);
      expect(fake.books['cyc']!['غير مذكور']!.length, 1);
    },
  );

  test('rows written by someone else are never overwritten', () async {
    final id = await linkedCycle();
    await CycleService(db, () => fake).syncCycle(id);
    final prepared = await payroll.prepareUnmentionedUsers(
      request(id),
      const UnmentionedOptions(),
      (_) {},
    );
    final plan = prepared.plan!;
    expect(plan.steps.first['k'], 'appendUserInfo');
    fake.books['ui']!['Data']!.add(['y', '', '5555', 'يدوي', '']);
    Object? error;
    try {
      await payroll.runStep(plan, 0, (_) {});
    } catch (e) {
      error = e;
    }
    expect('$error', contains('الصف 4'));
    expect(fake.books['ui']!['Data']![3], ['y', '', '5555', 'يدوي', '']);
  });

  test('the grid grows when the new rows do not fit', () async {
    final id = await linkedCycle();
    final many = [
      ['ID', 'الوكالة', 'الاسم', 'الراتب'],
      for (var i = 0; i < 30; i++) ['${2000 + i}', 'Abu', 'م$i', '10'],
    ];
    fake.books['cyc']!['الوكيل'] = many;
    final job = await runJob(id, JobKind.unmentionedUsers);
    expect(job.status, AuditJob.done, reason: job.error);
    expect(fake.books['ui']!['Data']!.length, 33);
    expect(fake.log.any((l) => l.contains('appendDimension')), isTrue);
  });

  test(
    'uncoloured management rows with an amount in W go to «غير مذكور»',
    () async {
      final id = await linkedCycle();
      // 1001 was audited by colour; 1003 is in the user-info sheet.
      fake.colors['cyc|${mgmtSheetId()}'] = {1: '#facc15'};
      final job = await runJob(id, JobKind.unmentionedMgmt);
      expect(job.status, AuditJob.done, reason: job.error);
      // 1002 (W 0.0) and 1004 (W empty) are skipped; 1005 has «1٫5».
      expect(fake.books['cyc']!['غير مذكور'], [
        mgmtRow('1005', 'ريتا', '1٫5'),
        mgmtRow('1006', 'نانو', '3.00'),
      ]);
      expect(fake.colors['cyc|${mgmtSheetId()}'], {
        1: '#facc15',
        // The owner's own colour for these rows (Settings), not management's.
        5: '#f97316',
        6: '#f97316',
      });
      expect((await resultOf(job)).message, contains('نُقل 2 صف'));
      expect(await db.auditedMemberIds(id), containsAll(['1005', '1006']));

      final again = await runJob(id, JobKind.unmentionedMgmt);
      expect(again.status, AuditJob.done);
      expect((await resultOf(again)).message, contains('لا توجد'));
      expect(fake.books['cyc']!['غير مذكور']!.length, 2);
    },
  );

  test('the two steps together: users first, then management rows', () async {
    final id = await linkedCycle();
    await runJob(id, JobKind.unmentionedUsers);
    final job = await runJob(id, JobKind.unmentionedMgmt);
    expect(job.status, AuditJob.done, reason: job.error);
    // 1002 came with the users step (agent colour); 1001 and 1003 are in
    // the user-info sheet; 1005 and 1006 are added now.
    expect(fake.books['cyc']!['غير مذكور']!.map((r) => r.first), [
      '1002',
      '1005',
      '1006',
    ]);
    // In «غير مذكور» only the pulled rows get their colour; 1002 (copied
    // by the users step) is left as it was.
    final target = fake.colors['cyc|${fake.ids['cyc']!['غير مذكور']}']!;
    expect(target, {1: '#f97316', 2: '#f97316'});
  });

  test('the pulled rows use the colour chosen in Settings', () async {
    final id = await linkedCycle();
    final jobId = await db.createAuditJob(id, {
      ...request(id).toJson(),
      'kind': JobKind.unmentionedMgmt,
      'unmentioned': const UnmentionedOptions(color: '#22c55e').toJson(),
    });
    await runner.runPending();
    expect((await db.getAuditJob(jobId))!.status, AuditJob.done);
    expect(fake.colors['cyc|${mgmtSheetId()}']![5], '#22c55e');
    expect(
      fake.colors['cyc|${fake.ids['cyc']!['غير مذكور']}']!.values.toSet(),
      {'#22c55e'},
    );
    final ws = WorkspaceColumns.fromJson({'unmentionedColor': '#ABCDEF'});
    expect(ws.unmentionedColor, '#abcdef');
    expect(
      WorkspaceColumns.fromJson({'unmentionedColor': 'red'}).unmentionedColor,
      WorkspaceColumns.defaultUnmentionedColor,
    );
  });

  test('an empty agency name sends the user to «غير مذكور»', () async {
    final id = await linkedCycle();
    fake.books['ui']!['Data']!.add(['x2', '', '1002', '', 'SY']);
    fake.books['ui']!['Data']!.add(['x5', '', '1005', '  ', 'SY']);
    final job = await db.createAuditJob(id, {
      ...PayrollRequest(
        cycleId: id,
        userInfo: const GoogleUserInfo('ui', 'Data'),
        discountRate: 10,
        agentColor: '#8b5cf6',
        managementColor: '#facc15',
        columns: const AuditColumns(),
        emptyTitle: 'غير مذكور',
      ).toJson(),
    });
    await runner.runPending();
    final done = (await db.getAuditJob(job))!;
    expect(done.status, AuditJob.done, reason: done.error);
    // Same audit (salary and status), copied to «غير مذكور» instead of a
    // sheet per row; column D itself is left empty.
    expect(fake.books['cyc']!['غير مذكور']!.map((r) => r.first), [
      '1002',
      '1005',
    ]);
    expect(fake.books['cyc']!.keys.any((k) => k.startsWith('صف_')), isFalse);
    final ui = fake.books['ui']!['Data']!;
    expect(ui[3][3], '');
    expect(ui[3][12], 'سحب وكيل راتبين');
    expect(ui[4][12], 'سحب ادارة');
  });

  test(
    '«غير مذكور» typed by hand, forgotten or pasted with marks: one sheet',
    () {
      final out = runPayrollAuditCore(
        managementRows: mgmtSheet,
        agentRows: agentSheet,
        userInfoRows: [
          userInfoSheet[0],
          ['a', '', '1001', 'غير مذكور', ''],
          ['b', '', '1002', '', ''],
          ['c', '', '1003', '\u200Fغير  مذكور ', ''],
          ['d', '', '1005', '\u200F', ''],
          ['e', '', '1006', 'وكيل الشمال', ''],
        ],
        emptyTitle: 'غير مذكور',
      );
      expect(out.results.map((r) => r.title), [
        'غير مذكور',
        'غير مذكور',
        'غير مذكور',
        'غير مذكور',
        'وكيل الشمال',
      ]);
      expect(out.titleOrder, ['غير مذكور', 'وكيل الشمال']);
    },
  );

  test('without the option the empty title stays ERP «صف_N»', () {
    final out = runPayrollAuditCore(
      managementRows: mgmtSheet,
      agentRows: agentSheet,
      userInfoRows: [
        userInfoSheet[0],
        ['x', '', '1003', '', ''],
      ],
    );
    expect(out.results.single.title, 'صف_1');
    final routed = runPayrollAuditCore(
      managementRows: mgmtSheet,
      agentRows: agentSheet,
      userInfoRows: [
        userInfoSheet[0],
        ['x', '', '1003', '', ''],
      ],
      emptyTitle: 'غير مذكور',
    );
    expect(routed.results.single.title, 'غير مذكور');
  });

  test('amounts with Arabic digits and separators', () {
    expect(PayrollService.parseAmount('٢٫٥'), 2.5);
    expect(PayrollService.parseAmount('0.00'), 0);
    expect(PayrollService.parseAmount('1,209.90'), 1209.9);
    expect(PayrollService.parseAmount(''), isNull);
    expect(PayrollService.parseAmount('FALSE'), isNull);
    expect(PayrollService.parseAmount(null), isNull);
  });

  test('workspace columns are the defaults of every cycle', () async {
    final id = await linkedCycle();
    expect((await db.getCycleColumns(id)).agentSalaryCol, 'D');
    await db.saveWorkspaceColumns(
      const WorkspaceColumns(agentSalaryCol: 'F', agentUserIdCol: 'B'),
    );
    final cols = await db.getCycleColumns(id);
    expect(cols.agentSalaryCol, 'F');
    expect(cols.agentUserIdCol, 'B');
    final ws = await db.getWorkspaceColumns();
    expect(ws.mgmtShareCol, 'W');
    expect(ws.unmentionedLabelCols, ['E']);
    expect(
      const WorkspaceColumns(unmentionedLabelCols: ['L']).validate(),
      isNotNull,
    );
    expect(const WorkspaceColumns().validate(), isNull);
    expect(WorkspaceColumns.parseColumnList('a, e،F'), ['A', 'E', 'F']);
    expect(WorkspaceColumns.parseColumnList('A, 1'), isNull);
  });

  test('the unaudited list uses the workspace name column', () async {
    final id = await linkedCycle();
    await CycleService(db, () => fake).syncCycle(id);
    await db.saveWorkspaceColumns(const WorkspaceColumns(agentNameCol: 'B'));
    final pending = await payroll.unauditedAgentMembers(id);
    expect(pending.members.first.name, 'Abu');
  });

  test('SheetsApiException flags stay transient for the runner', () {
    expect(SheetsApiException('x', network: true).transient, isTrue);
  });
}
