import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/data/app_database.dart';
import 'package:lork_erp/erp/payroll_audit_engine.dart';
import 'dart:convert';
import 'dart:io';

import 'package:lork_erp/google/sheets_client.dart';
import 'package:lork_erp/services/audit_job_runner.dart';
import 'package:lork_erp/services/cycle_service.dart';
import 'package:lork_erp/services/cycle_sync_worker.dart';
import 'package:lork_erp/services/payroll_service.dart';
import 'package:lork_erp/services/search_service.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/fake_sheets.dart';

final mgmt = [
  ['رقم المستخدم', 'الاسم', 'الوكالة', 'المبلغ'],
  ['1001', 'أحمد', 'الشمال', '120'],
  ['1002', 'سارة', 'الشمال', '80'],
  ['1003', 'علي', 'الجنوب', '50'],
  ['1004', 'منى', 'الجنوب', '75'],
];
final agent = [
  ['رقم المستخدم', 'الاسم', 'ملاحظة', 'الراتب'],
  ['1001', 'أحمد', '', '100'],
  ['1002', 'سارة', '', '60'],
  ['1002', 'سارة', 'راتب ثانٍ', '40'],
  ['1007', 'باسم', '', '30'],
];
final userInfo = [
  ['الاسم', 'الهاتف', 'رقم المستخدم', 'الوكيل'],
  ['أحمد', '0991', '1001', 'وكيل الشمال'],
  ['سارة', '0992', '1002', 'وكيل الشمال'],
  ['علي', '0993', '1003', 'وكيل الجنوب'],
  ['خالد', '0995', '1009', 'وكيل الشمال'],
];

void main() {
  sqfliteFfiInit();
  late AppDatabase db;
  late FakeSheets fake;
  late PayrollService payroll;
  late SearchService search;

  setUp(() async {
    db = await AppDatabase.open(
      path: inMemoryDatabasePath,
      factory: databaseFactoryFfiNoIsolate,
    );
    fake =
        FakeSheets()
          ..add('cyc', 'الإدارة', mgmt)
          ..add('cyc', 'الوكيل', agent)
          ..add('cyc', 'وكيل الشمال', [
            mgmt[0],
            ['1001', 'أحمد', 'الشمال', '120'],
          ])
          ..add('ui', 'Sheet1', userInfo);
    payroll = PayrollService(db, () => fake);
    search = SearchService(db, () => fake);
  });

  tearDown(() => db.close());

  PayrollRequest request(int id, {bool force = false}) => PayrollRequest(
    cycleId: id,
    userInfo: const GoogleUserInfo('ui', null),
    discountRate: 10,
    agentColor: '#8b5cf6',
    managementColor: '#facc15',
    columns: const AuditColumns(),
    forceReaudit: force,
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

  test('Google mode writes what ERP payroll-execute writes', () async {
    final id = await linkedCycle();
    final r = await payroll.execute(request(id));
    expect(r.success, isTrue, reason: r.message);
    expect(r.cycleSynced, isTrue);
    expect(r.summary!.agent, 2);
    expect(r.summary!.management, 1);
    expect(r.summary!.notFound, 1);

    // 1001 already existed in «وكيل الشمال»; only 1002 is appended.
    expect(fake.books['cyc']!['وكيل الشمال']!.map((e) => e.first), [
      'رقم المستخدم',
      '1001',
      '1002',
    ]);
    expect(fake.books['cyc']!['وكيل الجنوب'], [
      ['1003', 'علي', 'الجنوب', '50'],
    ]);
    final ui = fake.books['ui']!['Sheet1']!;
    expect([for (final row in ui.skip(1)) row[11]], ['90', '90', '0', '0']);
    expect(
      [for (final row in ui.skip(1)) row[12]],
      ['سحب وكيل', 'سحب وكيل راتبين', 'سحب ادارة', 'غير موجود'],
    );
    final mgmtColors = fake.colors['cyc|${fake.ids['cyc']!['الإدارة']}']!;
    expect(mgmtColors, {1: '#8b5cf6', 2: '#8b5cf6', 3: '#facc15'});
    final agentColors = fake.colors['cyc|${fake.ids['cyc']!['الوكيل']}']!;
    expect(agentColors, {1: '#8b5cf6', 2: '#8b5cf6', 3: '#8b5cf6'});
  });

  test('re-running never copies an audited row twice', () async {
    final id = await linkedCycle();
    await payroll.execute(request(id));
    await payroll.execute(request(id, force: true));
    await payroll.execute(request(id, force: true));
    expect(fake.books['cyc']!['وكيل الشمال']!.length, 3);
    expect(fake.books['cyc']!['وكيل الجنوب']!.length, 1);
  });

  test('after an audit, only the new information is audited', () async {
    final id = await linkedCycle();
    final first = await payroll.execute(request(id));
    expect(first.success, isTrue, reason: first.message);
    final ui = fake.books['ui']!['Sheet1']!;
    // The owner edits an audited row by hand, then adds information: a new
    // user (1004, in the management sheet) and the management and agent
    // rows of 1009 (not found in the first audit).
    ui[1][12] = 'يدوي';
    ui.add(['منى', '0996', '1004', 'وكيل الجنوب']);
    fake.books['cyc']!['الإدارة']!.add(['1009', 'خالد', 'الشمال', '70']);
    fake.books['cyc']!['الوكيل']!.add(['1009', 'خالد', '', '70']);
    fake.colors.clear();
    final log = fake.log.length;

    final r = await payroll.execute(request(id));
    expect(r.success, isTrue, reason: r.message);
    expect(r.message.startsWith('دُققت المعلومات الجديدة فقط'), isTrue);
    expect(r.message.contains('2 مستخدم (1 سحب وكالة، 1 سحب إدارة)'), isTrue);
    // Audited users are left as they are.
    expect(ui[1][12], 'يدوي');
    // The new information is written, coloured and copied once.
    expect([ui[4][11], ui[4][12]], ['63', 'سحب وكيل']);
    expect([ui[5][11], ui[5][12]], ['0', 'سحب ادارة']);
    expect(fake.colors['cyc|${fake.ids['cyc']!['الإدارة']}'], {
      4: '#facc15',
      5: '#8b5cf6',
    });
    expect(fake.colors['cyc|${fake.ids['cyc']!['الوكيل']}'], {5: '#8b5cf6'});
    expect(fake.books['cyc']!['وكيل الجنوب']!.map((e) => e.first), [
      '1003',
      '1004',
    ]);
    expect(fake.books['cyc']!['وكيل الشمال']!.map((e) => e.first), [
      'رقم المستخدم',
      '1001',
      '1002',
      '1009',
    ]);
    expect(
      fake.log.skip(log).where((l) => l.startsWith('BATCH VALUES')).length,
      1,
    );
    expect(await db.auditedMemberIds(id), {
      '1001',
      '1002',
      '1003',
      '1004',
      '1009',
    });

    // Nothing new: nothing is written, coloured or copied.
    final quiet = fake.log.length;
    final again = await payroll.execute(request(id));
    expect(again.success, isTrue, reason: again.message);
    expect(again.message.startsWith('لا توجد معلومات جديدة'), isTrue);
    expect(
      fake.log
          .skip(quiet)
          .where((l) => l.startsWith('BATCH') || l.startsWith('APPEND')),
      isEmpty,
    );
    // The full audit is still there: it rewrites every row like ERP.
    final full = await payroll.execute(request(id, force: true));
    expect(full.success, isTrue);
    expect(ui[1][12], 'سحب وكيل');
    expect(fake.books['cyc']!['وكيل الجنوب']!.length, 2);
    expect(fake.books['cyc']!['وكيل الشمال']!.length, 4);
  });

  test('a deleted or renamed user-info sheet gives a clear message', () async {
    final id = await linkedCycle();
    final r = await payroll.execute(
      PayrollRequest(
        cycleId: id,
        userInfo: const GoogleUserInfo('ui', 'تدقيق'),
        discountRate: 10,
        agentColor: '#8b5cf6',
        managementColor: '#facc15',
        columns: const AuditColumns(),
      ),
    );
    expect(r.success, isFalse);
    expect(r.message.contains('الورقة «تدقيق» غير موجودة'), isTrue);
    expect(r.message.contains('«Sheet1»'), isTrue);
    // Nothing was written.
    expect(fake.log.any((l) => l.startsWith('BATCH')), isFalse);
  });

  test('a cycle from files gets its own Google spreadsheet', () async {
    final id = await db.insertCycle(
      name: 'ملفات',
      managementRows: mgmt,
      agentRows: agent,
    );
    final r = await payroll.execute(request(id));
    expect(r.success, isTrue, reason: r.message);
    final cycle = await db.getCycle(id);
    expect(cycle!.linkedToGoogle, isTrue);
    expect(cycle.managementSheetName, 'الإدارة');
    expect(cycle.agentSheetName, 'الوكيل');
    final book = fake.books[cycle.managementSpreadsheetId]!;
    expect(book.keys, containsAll(['الإدارة', 'الوكيل', 'وكيل الشمال']));
  });

  test('search and selective audit', () async {
    final id = await linkedCycle();
    await payroll.execute(request(id));
    final s = await search.searchUser(id, '١٠٠٢', 10);
    expect(s.hits.single.logicalStatus, statusAgentTwo);
    expect(s.hits.single.salaryAfter, 90);
    expect(s.hits.single.auditStatus, 'مدقق');

    final ia = await search.executeIndividual(
      cycleId: id,
      memberIdRaw: '1004',
      targetSheetTitle: 'يدوي',
      createIfMissing: true,
      agentColor: '#8b5cf6',
      managementColor: '#facc15',
    );
    expect(ia.success, isTrue, reason: ia.message);
    expect(fake.books['cyc']!['يدوي'], [
      ['1004', 'منى', 'الجنوب', '75'],
    ]);
    final after = await search.searchUser(id, '1004', 0);
    expect(after.hits.single.auditStatus, 'مدقق');
    expect(after.hits.single.auditSource, 'تدقيق من أداة البحث');
  });

  test('local mode keeps the same effects in a workbook', () async {
    final id = await db.insertCycle(
      name: 'محلية',
      managementRows: mgmt,
      agentRows: agent,
    );
    final r = await payroll.execute(
      PayrollRequest(
        cycleId: id,
        userInfo: LocalUserInfo('ui.csv', 'CSV', userInfo),
        discountRate: null,
        agentColor: '#8b5cf6',
        managementColor: '#facc15',
        columns: const AuditColumns(),
      ),
    );
    expect(r.success, isTrue, reason: r.message);
    expect(r.localOnly, isTrue);
    expect(fake.log, isEmpty);
    final state = LocalWorkbookState.fromJson(await db.getLocalWorkbook(id));
    expect(state.targets.keys, ['وكيل الشمال', 'وكيل الجنوب']);
    expect(state.mgmtColors, {1: '#8b5cf6', 2: '#8b5cf6', 3: '#facc15'});
    expect(state.userInfoRows![1][11], 100);
    expect(state.userInfoRows![1][12], 'سحب وكيل');
  });

  test('search reads only the cycle cache, like ERP', () async {
    final id = await linkedCycle();
    final before = await search.searchUser(id, '1001', 0);
    expect(before.success, isFalse);
    expect(before.message, contains('لم تتم مزامنة الدورة بعد'));
    final all = await search.searchAcrossCycles('1001', 0);
    expect(all.success, isFalse);
  });

  test(
    'cycle sync stores the user-info snapshot (ERP /cycles/:id/sync)',
    () async {
      final id = await linkedCycle();
      final cycles = CycleService(db, () => fake);
      final r = await cycles.syncCycle(id, userInfoSpreadsheetId: 'ui');
      expect(r.success, isTrue, reason: r.message);
      expect(r.message, 'تمت مزامنة جداول الدورة وبيانات المستخدمين من Google');
      final cycle = await db.getCycle(id);
      expect(cycle!.managementRows.length, mgmt.length);

      final local = await db.insertCycle(
        name: 'ملفات',
        managementRows: mgmt,
        agentRows: agent,
      );
      final unlinked = await cycles.syncCycle(local);
      expect(unlinked.success, isFalse);
      expect(unlinked.message, contains('غير مرتبطة بجداول Google'));
    },
  );

  test('background sync marks coloured rows as manually audited', () async {
    final id = await linkedCycle();
    fake.colors['cyc|${fake.ids['cyc']!['الإدارة']}'] = {2: '#facc15'};
    fake.colors['cyc|${fake.ids['cyc']!['الوكيل']}'] = {
      2: '#8b5cf6',
      3: '#8b5cf6',
    };
    final worker = CycleSyncWorker(db, () => fake);
    expect(await worker.runOnce(), 0, reason: 'off by default, like ERP');
    await db.setValue(CycleSyncWorker.enabledKey, '1');
    expect(await worker.runOnce(), 1);
    final cache = await db.getCycleCache(id);
    expect(cache!.auditedMgmtIds, {'1002'});
    expect(cache.auditedAgentIds, {'1002'});
    expect(cache.staleAfter!.isAfter(DateTime.now()), isTrue);
    expect(await worker.runOnce(), 0, reason: 'cache still fresh');

    final s = await search.searchUser(id, '1002', 0);
    expect(s.hits.single.auditStatus, 'مدقق');
    expect(s.hits.single.auditSource, 'مدقق يدوي');
    final other = await search.searchUser(id, '1001', 0);
    expect(other.hits.single.auditStatus, 'غير مدقق');
  });

  test(
    'duplicated ids do not stop the audit, are copied once and reported',
    () async {
      final id = await linkedCycle();
      fake.add('ui2', 'Sheet1', [
        ...userInfo,
        ['سارة', '0996', '1002', 'وكيل الجنوب'],
        ['أحمد', '0997', '1001', 'وكيل الشمال'],
      ]);
      final r = await payroll.execute(
        PayrollRequest(
          cycleId: id,
          userInfo: const GoogleUserInfo('ui2', null),
          discountRate: 10,
          agentColor: '#8b5cf6',
          managementColor: '#facc15',
          columns: const AuditColumns(),
        ),
      );
      expect(r.success, isTrue, reason: r.message);
      expect([for (final d in r.duplicates) d.userId], ['1001', '1002']);
      expect(r.duplicates.first.rows, [2, 7]);
      expect(r.duplicates.last.rows, [3, 6]);
      // 1002 is copied once, to the sheet of its first row only.
      expect(fake.books['cyc']!['وكيل الشمال']!.map((e) => e.first), [
        'رقم المستخدم',
        '1001',
        '1002',
      ]);
      expect(fake.books['cyc']!['وكيل الجنوب'], [
        ['1003', 'علي', 'الجنوب', '50'],
      ]);
      final ui = fake.books['ui2']!['Sheet1']!;
      expect(ui[5][12], 'مكرر (الصف 3)');
      expect(ui[6][12], 'مكرر (الصف 2)');
      expect(ui[5][11], '');
      expect(ui[2][11], '90');
    },
  );

  test('colouring is one request per sheet with merged ranges', () async {
    final id = await linkedCycle();
    await payroll.execute(request(id));
    final colourBatches = [
      for (final l in fake.log)
        if (l.startsWith('BATCH') && l.contains('repeatCell')) l,
    ];
    // management: rows 1-2 agent colour + row 3 management colour;
    // agent: rows 1-3 in one range.
    expect(colourBatches, [
      'BATCH cyc 2 [repeatCell]',
      'BATCH cyc 1 [repeatCell]',
    ]);
  });

  test(
    'an interrupted audit resumes where it stopped, without duplicates',
    () async {
      final id = await linkedCycle();
      final runner = AuditJobRunner(
        db,
        payroll,
        CycleService(db, () => fake),
        retryDelays: const [],
      );
      final jobId = await db.createAuditJob(id, request(id).toJson());
      var down = true;
      fake.failWhen =
          (op, payload) =>
              down &&
              op == 'batchUpdate' &&
              (payload as List).first.containsKey('repeatCell');

      expect(await runner.runPending(), isFalse);
      var job = await db.getAuditJob(jobId);
      expect(job!.status, AuditJob.waiting);
      expect(job.stepNext < job.stepTotal, isTrue);
      expect(fake.books['cyc']!['وكيل الشمال']!.length, 3);

      down = false;
      expect(await runner.runPending(), isTrue);
      job = await db.getAuditJob(jobId);
      expect(job!.status, AuditJob.done);
      expect(job.stepNext, job.stepTotal);
      expect(fake.books['cyc']!['وكيل الشمال']!.length, 3);
      expect(fake.books['cyc']!['وكيل الجنوب']!.length, 1);
      expect(fake.colors['cyc|${fake.ids['cyc']!['الإدارة']}'], {
        1: '#8b5cf6',
        2: '#8b5cf6',
        3: '#facc15',
      });
      final result = PayrollResult.fromJson(
        (await db.getAuditJobResult(jobId))!,
      );
      expect(result.success, isTrue);
      expect((await db.getCycleCache(id))!.auditedAgentIds, {'1001', '1002'});
    },
  );

  test('agent-sheet users not audited yet (id from A, name from C)', () async {
    final id = await linkedCycle();
    await payroll.execute(request(id));
    final pending = await payroll.unauditedAgentMembers(id);
    expect(pending.agentTotal, 3);
    expect([for (final m in pending.members) m.id], ['1007']);
    expect(pending.members.single.row, 5);
  });

  test('large snapshots (> 2 MB, emoji on chunk edges) round-trip', () async {
    final big = [
      ['رقم المستخدم', 'الاسم', 'الوكالة'],
      for (var i = 0; i < 40000; i++)
        ['${100000 + i}', '𝐑𝐌𝐖𝐒𝐇𝐀 🧿 سارة $i', 'الشمال'],
    ];
    expect(utf8.encode(jsonEncode(big)).length > 2 * 1024 * 1024, isTrue);
    final id = await db.insertCycle(
      name: 'كبيرة',
      managementRows: big,
      agentRows: big,
    );
    final cycle = await db.getCycle(id);
    expect(jsonEncode(cycle!.managementRows), jsonEncode(big));
    expect(cycle.managementCount, big.length);
    final light = (await db.listCycles()).firstWhere((c) => c.id == id);
    expect(light.managementRows, isEmpty);
    expect(light.agentCount, big.length);

    // A surrogate pair exactly on a chunk boundary stays intact.
    final edge = '${'x' * (AppDatabase.blobChunk - 1)}🧿tail';
    await db.putBlob('t/edge', edge);
    expect(await db.getBlob('t/edge'), edge);
  });

  test('reading a sheet keeps rows after empty rows on a batch edge', () async {
    final rows = <List<String>>[
      for (var i = 1; i <= 12000; i++)
        (i >= 4990 && i <= 5010) ? <String>[] : ['$i', 'x'],
    ];
    fake.add('big', 'S', rows);
    final meta = await fake.getSpreadsheet('big');
    final read = await fetchSheetValuesBatched(
      fake,
      'big',
      'S',
      rowCount: sheetRowCount(meta, 'S'),
    );
    expect(read.length, 12000);
    expect(read[4988], ['4989', 'x']);
    expect(read[5010], ['5011', 'x']);
    expect(read.last, ['12000', 'x']);
  });

  test('upgrading from schema 3 moves the stored sheets', () async {
    final dir = Directory.systemTemp.createTempSync('erp_v3');
    final path = '${dir.path}/old.db';
    final old = await databaseFactoryFfiNoIsolate.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 3,
        onCreate: (d, _) async {
          await d.execute('''CREATE TABLE financial_cycles (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            management_data TEXT, agent_data TEXT,
            management_spreadsheet_id TEXT, management_sheet_name TEXT,
            agent_spreadsheet_id TEXT, agent_sheet_name TEXT,
            transfer_discount_pct REAL NOT NULL DEFAULT 0,
            user_info_data TEXT, user_info_spreadsheet_id TEXT,
            user_info_sheet_name TEXT, payroll_audit_user_info_hash TEXT,
            payroll_audit_closed_at TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL)''');
          await d.execute('''CREATE TABLE payroll_cycle_cache (
            cycle_id INTEGER PRIMARY KEY, management_data TEXT,
            agent_data TEXT, management_sheet_name TEXT,
            agent_sheet_name TEXT, audited_agent_ids TEXT,
            audited_mgmt_ids TEXT, found_in_target_sheet_ids TEXT,
            synced_at TEXT NOT NULL, stale_after TEXT)''');
          await d.execute('''CREATE TABLE local_workbooks (
            cycle_id INTEGER PRIMARY KEY, state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL)''');
          await d.execute('''CREATE TABLE audit_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id INTEGER NOT NULL,
            status TEXT NOT NULL, request_json TEXT NOT NULL,
            plan_json TEXT, step_next INTEGER NOT NULL DEFAULT 0,
            step_total INTEGER NOT NULL DEFAULT 0, progress TEXT,
            error TEXT, result_json TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            seen INTEGER NOT NULL DEFAULT 0, lease_owner TEXT,
            lease_until TEXT, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL)''');
          for (final t in const [
            'CREATE TABLE payroll_settings (id INTEGER PRIMARY KEY)',
            'CREATE TABLE payroll_cycle_columns (cycle_id INTEGER PRIMARY KEY)',
            'CREATE TABLE payroll_user_audit_cache (cycle_id INTEGER, member_user_id TEXT)',
            'CREATE TABLE audit_runs (id INTEGER PRIMARY KEY)',
            'CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)',
          ]) {
            await d.execute(t);
          }
        },
      ),
    );
    final now = DateTime.now().toIso8601String();
    await old.insert('financial_cycles', {
      'id': 1,
      'name': 'قديمة',
      'management_data': jsonEncode(mgmt),
      'agent_data': jsonEncode(agent),
      'created_at': now,
      'updated_at': now,
    });
    await old.insert('payroll_cycle_cache', {
      'cycle_id': 1,
      'management_data': jsonEncode(mgmt),
      'agent_data': jsonEncode(agent),
      'audited_agent_ids': '["1001"]',
      'audited_mgmt_ids': '[]',
      'synced_at': now,
    });
    await old.close();

    final upgraded = await AppDatabase.open(
      path: path,
      factory: databaseFactoryFfiNoIsolate,
    );
    final cycle = await upgraded.getCycle(1);
    expect(cycle!.managementRows, mgmt);
    expect(cycle.agentRows, agent);
    expect(cycle.managementCount, mgmt.length);
    final cache = await upgraded.getCycleCache(1);
    expect(cache!.agentData, agent);
    expect(cache.auditedAgentIds, {'1001'});
    await upgraded.close();
  });

  // ---- 3.4.0: audit without the management sheet (owner's request) ----

  group('without management', () {
    PayrollRequest noMgmt(int id, {bool force = false}) => PayrollRequest(
      cycleId: id,
      userInfo: const GoogleUserInfo('ui', null),
      discountRate: 10,
      agentColor: '#8b5cf6',
      managementColor: '#facc15',
      columns: const AuditColumns(),
      forceReaudit: force,
      withoutManagement: true,
    );

    test('uses the user-info and agent sheets only', () async {
      // 1003 is in the agent sheet with a salary of 0; 1009 is not there.
      fake.books['cyc']!['الوكيل']!.add(['1003', 'علي', '', '0']);
      final id = await linkedCycle();
      final booksBefore = {
        for (final e in fake.books['cyc']!.entries) e.key: e.value.length,
      };
      final r = await payroll.execute(noMgmt(id));
      expect(r.success, isTrue, reason: r.message);
      expect(r.summary!.agent, 2);
      expect(r.summary!.management, 0);
      expect(r.summary!.noSalary, 1);
      expect(r.summary!.notFound, 1);

      final ui = fake.books['ui']!['Sheet1']!;
      expect([for (final row in ui.skip(1)) row[11]], ['90', '90', '0', '0']);
      expect(
        [for (final row in ui.skip(1)) row[12]],
        ['سحب وكيل', 'سحب وكيل راتبين', 'بدون راتب', 'غير موجود'],
      );
      // Nothing copied, no agency sheet added, the management sheet not
      // read or coloured; the agent rows of the found users coloured.
      expect({
        for (final e in fake.books['cyc']!.entries) e.key: e.value.length,
      }, booksBefore);
      expect(fake.log.where((l) => l.contains('الإدارة')), isEmpty);
      expect(fake.colors['cyc|${fake.ids['cyc']!['الإدارة']}'], isNull);
      expect(fake.colors['cyc|${fake.ids['cyc']!['الوكيل']}'], {
        1: '#8b5cf6',
        2: '#8b5cf6',
        3: '#8b5cf6',
        5: '#8b5cf6',
      });
    });

    test('a cycle made without management is audited without it', () async {
      // The cycle form: «بدون جدول الإدارة» + the user-info sheet.
      final cycles = CycleService(db, () => fake);
      final id = await cycles.createCycle(
        name: 'وكيل فقط',
        agentSpreadsheetId: 'cyc',
        agentSheetName: 'الوكيل',
        userInfoSpreadsheetId: 'ui',
        userInfoSheetName: 'Sheet1',
      );
      final cycle = await db.getCycleInfo(id);
      expect(cycle!.linkedToGoogle, isTrue);
      expect(cycle.withoutManagement, isTrue);
      expect(cycle.userInfoSpreadsheetId, 'ui');
      expect(cycle.userInfoSheetName, 'Sheet1');
      // No switch in the request: the cycle decides.
      final r = await payroll.execute(request(id));
      expect(r.success, isTrue, reason: r.message);
      expect(r.summary!.agent, 2);
      expect(r.summary!.management, 0);
      expect(r.summary!.notFound, 2);
      expect(fake.log.where((l) => l.contains('الإدارة')), isEmpty);
      // A cycle with a management sheet keeps the ERP audit.
      final linked = await db.getCycleInfo(await linkedCycle());
      expect(linked!.withoutManagement, isFalse);
    });

    test('the next audit is incremental; «بدون راتب» users are kept', () async {
      fake.books['cyc']!['الوكيل']!.add(['1003', 'علي', '', '0']);
      final id = await linkedCycle();
      await payroll.execute(noMgmt(id));
      final ui = fake.books['ui']!['Sheet1']!;
      ui.add(['منى', '0996', '1004', 'وكيل الجنوب']);
      fake.books['cyc']!['الوكيل']!.add(['1004', 'منى', '', '50']);
      final r = await payroll.execute(noMgmt(id));
      expect(r.success, isTrue, reason: r.message);
      expect(r.message, contains('1 سحب وكالة'));
      expect(ui.last[11], '45');
      expect(ui.last[12], 'سحب وكيل');
      expect(ui[3][12], 'بدون راتب');
    });

    test('the request keeps the method in a background job', () {
      final j = noMgmt(1).toJson();
      expect(PayrollRequest.fromJson(j).withoutManagement, isTrue);
      expect(
        PayrollRequest.fromJson(request(1).toJson()).withoutManagement,
        isFalse,
      );
    });
  });
}
