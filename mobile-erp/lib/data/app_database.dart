import 'dart:convert';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import '../accounting/ledger.dart';

import 'workspace_columns.dart';

export 'workspace_columns.dart';

typedef Rows = List<List<String>>;

Rows decodeRows(String? json) {
  if (json == null || json.isEmpty) return <List<String>>[];
  try {
    final decoded = jsonDecode(json);
    if (decoded is! List) return <List<String>>[];
    return [
      for (final r in decoded)
        if (r is List)
          [for (final c in r) c == null ? '' : c.toString()]
        else
          <String>[],
    ];
  } catch (_) {
    return <List<String>>[];
  }
}

String? _str(Object? v) {
  final s = v?.toString().trim();
  return s == null || s.isEmpty ? null : s;
}

/// Mirrors ERP's `financial_cycles` row (audit-related columns only).
class Cycle {
  Cycle({
    required this.id,
    required this.name,
    required this.managementRows,
    required this.agentRows,
    this.managementCount = 0,
    this.agentCount = 0,
    this.managementSpreadsheetId,
    this.managementSheetName,
    this.agentSpreadsheetId,
    this.agentSheetName,
    this.transferDiscountPct = 0,
    this.userInfoHash,
    this.auditClosedAt,
    this.userInfoSpreadsheetId,
    this.userInfoSheetName,
    required this.createdAt,
    required this.updatedAt,
  });

  final int id;
  final String name;

  /// Empty in the light records returned by `listCycles`/`getCycleInfo`;
  /// loaded by `getCycle`.
  final Rows managementRows;
  final Rows agentRows;

  /// Row counts, available in light records too.
  final int managementCount;
  final int agentCount;
  final String? managementSpreadsheetId;
  final String? managementSheetName;
  final String? agentSpreadsheetId;
  final String? agentSheetName;
  final double transferDiscountPct;
  final String? userInfoHash;
  final DateTime? auditClosedAt;

  /// The user-info sheet of the cycle: chosen in the cycle form when it has
  /// no management sheet (3.4.0), or the last one synced with it.
  final String? userInfoSpreadsheetId;
  final String? userInfoSheetName;
  final DateTime createdAt;
  final DateTime updatedAt;

  /// A Google cycle: its agent sheet is in Google. The management sheet is
  /// optional since 3.4.0.
  bool get linkedToGoogle => agentSpreadsheetId != null;

  /// A cycle made without a management sheet («بدون جدول الإدارة» in the
  /// cycle form, owner's request 2026-11-23, 3.4.0) is audited with the
  /// user-info and agent sheets only (`runPayrollAuditCore(withoutManagement:)`).
  bool get withoutManagement =>
      managementSpreadsheetId == null && managementCount == 0;

  static Cycle fromRow(
    Map<String, Object?> r, {
    Rows? management,
    Rows? agent,
  }) => Cycle(
    id: r['id'] as int,
    name: (r['name'] ?? '').toString(),
    managementRows: management ?? const <List<String>>[],
    agentRows: agent ?? const <List<String>>[],
    managementCount:
        (r['management_count'] as num?)?.toInt() ?? management?.length ?? 0,
    agentCount: (r['agent_count'] as num?)?.toInt() ?? agent?.length ?? 0,
    managementSpreadsheetId: _str(r['management_spreadsheet_id']),
    managementSheetName: _str(r['management_sheet_name']),
    agentSpreadsheetId: _str(r['agent_spreadsheet_id']),
    agentSheetName: _str(r['agent_sheet_name']),
    transferDiscountPct: (r['transfer_discount_pct'] as num?)?.toDouble() ?? 0,
    userInfoHash: _str(r['payroll_audit_user_info_hash']),
    auditClosedAt: _date(r['payroll_audit_closed_at']),
    userInfoSpreadsheetId: _str(r['user_info_spreadsheet_id']),
    userInfoSheetName: _str(r['user_info_sheet_name']),
    createdAt: _date(r['created_at']) ?? DateTime.now(),
    updatedAt: _date(r['updated_at']) ?? DateTime.now(),
  );

  static DateTime? _date(Object? v) =>
      v == null ? null : DateTime.tryParse(v.toString());
}

class CycleColumns {
  const CycleColumns({
    this.mgmtUserIdCol = 'A',
    this.agentUserIdCol = 'A',
    this.agentSalaryCol = 'D',
  });
  final String mgmtUserIdCol;
  final String agentUserIdCol;
  final String agentSalaryCol;
}

/// ERP `payroll_cycle_cache`.
class CycleCache {
  CycleCache({
    required this.managementData,
    required this.agentData,
    this.managementSheetName,
    this.agentSheetName,
    required this.auditedAgentIds,
    required this.auditedMgmtIds,
    required this.foundInTargetSheetIds,
    this.staleAfter,
  });
  final Rows managementData;
  final Rows agentData;
  final String? managementSheetName;
  final String? agentSheetName;
  final Set<String> auditedAgentIds;
  final Set<String> auditedMgmtIds;
  final Set<String> foundInTargetSheetIds;

  /// ERP `stale_after`: the background sync skips the cycle until then.
  /// Null (as saved by an audit) means "refresh on the next sync".
  final DateTime? staleAfter;
}

class UserAuditStatus {
  const UserAuditStatus(this.status, this.source, this.details);
  final String status;
  final String? source;
  final Map<String, Object?>? details;
}

class AuditEntry {
  const AuditEntry(this.memberUserId, this.status, this.source, this.details);
  final String memberUserId;
  final String status;
  final String? source;
  final Map<String, Object?>? details;
}

class PayrollSettings {
  const PayrollSettings({
    this.discountRate = 0,
    this.agentColor = '#8b5cf6',
    this.managementColor = '#facc15',
  });
  final double discountRate;
  final String agentColor;
  final String managementColor;
}

/// A Google audit run in the background (see `AuditJobRunner`).
class AuditJob {
  const AuditJob({
    required this.id,
    required this.cycleId,
    required this.status,
    required this.request,
    required this.stepNext,
    required this.stepTotal,
    required this.progress,
    required this.error,
    required this.attempts,
    required this.seen,
    required this.createdAt,
    required this.updatedAt,
  });

  static const queued = 'queued';
  static const running = 'running';

  /// Interrupted (no internet, Google unreachable): resumes automatically.
  static const waiting = 'waiting';
  static const done = 'done';
  static const failed = 'failed';

  final int id;

  /// Null for jobs that belong to no cycle (additions and deductions).
  final int? cycleId;
  final String status;
  final Map<String, Object?> request;

  /// Index of the first plan step not yet done.
  final int stepNext;
  final int stepTotal;
  final String? progress;
  final String? error;
  final int attempts;

  /// The result was already announced in the app.
  final bool seen;
  final DateTime createdAt;
  final DateTime updatedAt;

  bool get active => status == queued || status == running || status == waiting;

  static Map<String, Object?>? _json(Object? v) {
    if (v == null) return null;
    try {
      final d = jsonDecode(v as String);
      return d is Map ? Map<String, Object?>.from(d) : null;
    } catch (_) {
      return null;
    }
  }

  static AuditJob fromRow(Map<String, Object?> r) => AuditJob(
    id: r['id'] as int,
    cycleId: r['cycle_id'] as int?,
    status: r['status'] as String,
    request: _json(r['request_json']) ?? const {},
    stepNext: (r['step_next'] as num?)?.toInt() ?? 0,
    stepTotal: (r['step_total'] as num?)?.toInt() ?? 0,
    progress: r['progress'] as String?,
    error: r['error'] as String?,
    attempts: (r['attempts'] as num?)?.toInt() ?? 0,
    seen: (r['seen'] as num?) == 1,
    createdAt: DateTime.tryParse(r['created_at'] as String) ?? DateTime.now(),
    updatedAt: DateTime.tryParse(r['updated_at'] as String) ?? DateTime.now(),
  );
}

class AuditRun {
  const AuditRun({
    required this.id,
    required this.cycleId,
    required this.createdAt,
    required this.mode,
    required this.payload,
  });
  final int id;
  final int cycleId;
  final DateTime createdAt;
  final String mode;
  final Map<String, Object?> payload;
}

/// All audit data lives in SQLite on the phone; no server is involved.
class AppDatabase {
  AppDatabase._(this._db);
  final Database _db;
  static const schemaVersion = 6;

  /// The raw database, for the ledger (same file, same transactions).
  Database get raw => _db;

  static Future<AppDatabase> open({
    String? path,
    DatabaseFactory? factory,
  }) async {
    final f = factory ?? databaseFactory;
    final location = path ?? p.join(await f.getDatabasesPath(), 'lork_erp.db');
    final db = await f.openDatabase(
      location,
      options: OpenDatabaseOptions(
        version: schemaVersion,
        onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
        onCreate: (db, version) => _create(db),
        onUpgrade: (db, oldVersion, newVersion) async {
          if (oldVersion < 2) {
            await db.execute(
              'ALTER TABLE payroll_cycle_cache ADD COLUMN stale_after TEXT',
            );
          }
          if (oldVersion < 3) await _createJobs(db);
          if (oldVersion < 4) {
            await db.execute(
              'ALTER TABLE financial_cycles ADD COLUMN management_count INTEGER NOT NULL DEFAULT 0',
            );
            await db.execute(
              'ALTER TABLE financial_cycles ADD COLUMN agent_count INTEGER NOT NULL DEFAULT 0',
            );
            await _createBlobs(db);
            await _moveDataToBlobs(db);
          }
          if (oldVersion >= 3 && oldVersion < 5) await _jobsWithoutCycle(db);
          if (oldVersion < 6) await Ledger.createTables(db);
        },
      ),
    );
    return AppDatabase._(db);
  }

  static Future<void> _create(DatabaseExecutor db) async {
    await db.execute('''CREATE TABLE financial_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      management_data TEXT,
      agent_data TEXT,
      management_spreadsheet_id TEXT,
      management_sheet_name TEXT,
      agent_spreadsheet_id TEXT,
      agent_sheet_name TEXT,
      transfer_discount_pct REAL NOT NULL DEFAULT 0,
      user_info_data TEXT,
      user_info_spreadsheet_id TEXT,
      user_info_sheet_name TEXT,
      payroll_audit_user_info_hash TEXT,
      payroll_audit_closed_at TEXT,
      management_count INTEGER NOT NULL DEFAULT 0,
      agent_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL)''');
    await db.execute('''CREATE TABLE payroll_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      discount_rate REAL NOT NULL DEFAULT 0,
      agent_color TEXT NOT NULL DEFAULT '#8b5cf6',
      management_color TEXT NOT NULL DEFAULT '#facc15',
      updated_at TEXT NOT NULL)''');
    await db.execute('''CREATE TABLE payroll_cycle_columns (
      cycle_id INTEGER PRIMARY KEY REFERENCES financial_cycles(id) ON DELETE CASCADE,
      mgmt_user_id_col TEXT NOT NULL DEFAULT 'A',
      agent_user_id_col TEXT NOT NULL DEFAULT 'A',
      agent_salary_col TEXT NOT NULL DEFAULT 'D',
      updated_at TEXT NOT NULL)''');
    await db.execute('''CREATE TABLE payroll_cycle_cache (
      cycle_id INTEGER PRIMARY KEY REFERENCES financial_cycles(id) ON DELETE CASCADE,
      management_data TEXT,
      agent_data TEXT,
      management_sheet_name TEXT,
      agent_sheet_name TEXT,
      audited_agent_ids TEXT,
      audited_mgmt_ids TEXT,
      found_in_target_sheet_ids TEXT,
      synced_at TEXT NOT NULL,
      stale_after TEXT)''');
    await db.execute('''CREATE TABLE payroll_user_audit_cache (
      cycle_id INTEGER NOT NULL REFERENCES financial_cycles(id) ON DELETE CASCADE,
      member_user_id TEXT NOT NULL,
      audit_status TEXT NOT NULL,
      audit_source TEXT,
      details_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (cycle_id, member_user_id))''');
    await db.execute('''CREATE TABLE local_workbooks (
      cycle_id INTEGER PRIMARY KEY REFERENCES financial_cycles(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL)''');
    await db.execute('''CREATE TABLE audit_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL REFERENCES financial_cycles(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      payload_json TEXT NOT NULL)''');
    await _createJobs(db);
    await _createBlobs(db);
    await Ledger.createTables(db);
    await db.execute('''CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT)''');
  }

  static Future<void> _createJobs(DatabaseExecutor db) =>
      db.execute('''CREATE TABLE audit_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER REFERENCES financial_cycles(id) ON DELETE CASCADE,
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

  // ---------------------------------------------------------------- blobs
  //
  // Android cannot read a single SQLite value larger than ~2 MB (cursor
  // window), so sheet snapshots, plans and results are stored as chunks.
  // This keeps the number of rows unlimited (owner's request).

  /// Schema 5: jobs that belong to no cycle (additions and deductions).
  /// SQLite cannot drop NOT NULL in place, so the table is rebuilt with
  /// the same columns in the same order and every row is copied.
  static Future<void> _jobsWithoutCycle(DatabaseExecutor db) async {
    await db.execute('ALTER TABLE audit_jobs RENAME TO audit_jobs_v4');
    await _createJobs(db);
    await db.execute('INSERT INTO audit_jobs SELECT * FROM audit_jobs_v4');
    await db.execute('DROP TABLE audit_jobs_v4');
  }

  static Future<void> _createBlobs(DatabaseExecutor db) =>
      db.execute('''CREATE TABLE blobs (
      key TEXT NOT NULL,
      idx INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (key, idx))''');

  /// UTF-16 code units per chunk (at most ~600 KB of UTF-8).
  static const blobChunk = 200000;

  static Future<void> _writeBlob(
    DatabaseExecutor db,
    String key,
    String? text,
  ) async {
    await db.delete('blobs', where: 'key = ?', whereArgs: [key]);
    if (text == null) return;
    var idx = 0;
    var start = 0;
    while (start < text.length) {
      var end = start + blobChunk;
      if (end >= text.length) {
        end = text.length;
      } else {
        // Never split a surrogate pair (emoji, styled letters in names).
        final unit = text.codeUnitAt(end - 1);
        if (unit >= 0xD800 && unit <= 0xDBFF) end--;
      }
      await db.insert('blobs', {
        'key': key,
        'idx': idx++,
        'data': text.substring(start, end),
      });
      start = end;
    }
  }

  Future<void> putBlob(String key, String? text) =>
      _db.transaction((txn) => _writeBlob(txn, key, text));

  Future<String?> getBlob(String key) async {
    final rows = await _db.query(
      'blobs',
      columns: ['data'],
      where: 'key = ?',
      whereArgs: [key],
      orderBy: 'idx',
    );
    if (rows.isEmpty) return null;
    final out = StringBuffer();
    for (final r in rows) {
      out.write(r['data'] as String);
    }
    return out.toString();
  }

  Future<void> _deleteBlobs(String prefix) =>
      _db.delete('blobs', where: 'key LIKE ?', whereArgs: ['$prefix%']);

  static String _cycleKey(int id, String part) => 'cycle/$id/$part';
  static String _cacheKey(int id, String part) => 'cache/$id/$part';
  static String _jobKey(int id, String part) => 'job/$id/$part';

  /// Schema 4: moves the large values written by earlier versions.
  static Future<void> _moveDataToBlobs(DatabaseExecutor db) async {
    Future<void> move(
      String table,
      String idColumn,
      String column,
      String Function(int id) key, {
      String? countColumn,
      Object? emptyValue,
    }) async {
      final ids = await db.query(table, columns: [idColumn]);
      for (final r in ids) {
        final id = r[idColumn] as int;
        String? text;
        try {
          final v = await db.query(
            table,
            columns: [column],
            where: '$idColumn = ?',
            whereArgs: [id],
          );
          text = v.isEmpty ? null : v.first[column] as String?;
        } catch (_) {
          continue; // too large to read: nothing usable to move
        }
        if (text == null || text.isEmpty) continue;
        await _writeBlob(db, key(id), text);
        await db.update(
          table,
          {
            column: emptyValue,
            if (countColumn != null) countColumn: decodeRows(text).length,
          },
          where: '$idColumn = ?',
          whereArgs: [id],
        );
      }
    }

    await move(
      'financial_cycles',
      'id',
      'management_data',
      (id) => _cycleKey(id, 'management'),
      countColumn: 'management_count',
    );
    await move(
      'financial_cycles',
      'id',
      'agent_data',
      (id) => _cycleKey(id, 'agent'),
      countColumn: 'agent_count',
    );
    await move(
      'financial_cycles',
      'id',
      'user_info_data',
      (id) => _cycleKey(id, 'userinfo'),
    );
    await move(
      'payroll_cycle_cache',
      'cycle_id',
      'management_data',
      (id) => _cacheKey(id, 'management'),
    );
    await move(
      'payroll_cycle_cache',
      'cycle_id',
      'agent_data',
      (id) => _cacheKey(id, 'agent'),
    );
    await move(
      'local_workbooks',
      'cycle_id',
      'state_json',
      (id) => 'workbook/$id',
      emptyValue: '',
    );
    await move('audit_jobs', 'id', 'plan_json', (id) => _jobKey(id, 'plan'));
    await move(
      'audit_jobs',
      'id',
      'result_json',
      (id) => _jobKey(id, 'result'),
    );
  }

  static String _now() => DateTime.now().toIso8601String();

  // ---------------------------------------------------------- audit jobs

  Future<int> createAuditJob(int? cycleId, Map<String, Object?> request) {
    final now = _now();
    return _db.insert('audit_jobs', {
      'cycle_id': cycleId,
      'status': AuditJob.queued,
      'request_json': jsonEncode(request),
      'progress': 'في الانتظار...',
      'created_at': now,
      'updated_at': now,
    });
  }

  /// Job columns without the (large) plan, for the progress display.
  static const _jobSummaryColumns = [
    'id',
    'cycle_id',
    'status',
    'request_json',
    'step_next',
    'step_total',
    'progress',
    'error',
    'attempts',
    'seen',
    'created_at',
    'updated_at',
  ];

  Future<AuditJob?> getAuditJob(int id) async {
    final rows = await _db.query(
      'audit_jobs',
      columns: _jobSummaryColumns,
      where: 'id = ?',
      whereArgs: [id],
    );
    return rows.isEmpty ? null : AuditJob.fromRow(rows.first);
  }

  /// Jobs that still have work to do, oldest first.
  Future<List<AuditJob>> pendingAuditJobs() async {
    final rows = await _db.query(
      'audit_jobs',
      columns: _jobSummaryColumns,
      where: 'status IN (?, ?, ?)',
      whereArgs: [AuditJob.queued, AuditJob.running, AuditJob.waiting],
      orderBy: 'id',
    );
    return rows.map(AuditJob.fromRow).toList();
  }

  /// The latest job that belongs to no cycle (additions and deductions).
  Future<AuditJob?> latestCyclelessJob() async {
    final rows = await _db.query(
      'audit_jobs',
      columns: _jobSummaryColumns,
      where: 'cycle_id IS NULL',
      orderBy: 'id DESC',
      limit: 1,
    );
    return rows.isEmpty ? null : AuditJob.fromRow(rows.first);
  }

  /// Read only: the jobs of a cycle, newest first (periods list).
  Future<List<AuditJob>> auditJobsOfCycle(int cycleId, {int limit = 20}) async {
    final rows = await _db.query(
      'audit_jobs',
      columns: _jobSummaryColumns,
      where: 'cycle_id = ?',
      whereArgs: [cycleId],
      orderBy: 'id DESC',
      limit: limit,
    );
    return rows.map(AuditJob.fromRow).toList();
  }

  Future<AuditJob?> latestAuditJob(int cycleId) async {
    final rows = await _db.query(
      'audit_jobs',
      columns: _jobSummaryColumns,
      where: 'cycle_id = ?',
      whereArgs: [cycleId],
      orderBy: 'id DESC',
      limit: 1,
    );
    return rows.isEmpty ? null : AuditJob.fromRow(rows.first);
  }

  /// Takes the job for [owner] (the app or the background worker) unless
  /// another runner holds a valid lease. One atomic UPDATE, so two runners
  /// can never both win.
  Future<bool> claimAuditJob(int id, String owner, Duration lease) async {
    final now = DateTime.now();
    final n = await _db.rawUpdate(
      'UPDATE audit_jobs SET lease_owner = ?, lease_until = ?, updated_at = ? '
      'WHERE id = ? AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)',
      [
        owner,
        now.add(lease).toIso8601String(),
        now.toIso8601String(),
        id,
        now.toIso8601String(),
        owner,
      ],
    );
    return n == 1;
  }

  Future<void> releaseAuditJob(int id) => _db.update(
    'audit_jobs',
    {'lease_owner': null, 'lease_until': null},
    where: 'id = ?',
    whereArgs: [id],
  );

  /// `plan_json` / `result_json` in [fields] are stored as blobs.
  Future<void> updateAuditJob(int id, Map<String, Object?> fields) async {
    final row = Map<String, Object?>.from(fields);
    for (final part in const ['plan', 'result']) {
      final key = '${part}_json';
      if (row.containsKey(key)) {
        await putBlob(_jobKey(id, part), row.remove(key) as String?);
      }
    }
    row['updated_at'] = _now();
    await _db.update('audit_jobs', row, where: 'id = ?', whereArgs: [id]);
  }

  Future<Map<String, Object?>?> getAuditJobPlan(int id) async =>
      AuditJob._json(await getBlob(_jobKey(id, 'plan')));

  Future<Map<String, Object?>?> getAuditJobResult(int id) async =>
      AuditJob._json(await getBlob(_jobKey(id, 'result')));

  /// Read only: the outcome counts of a job's saved result (total, agent,
  /// management, notFound, noSalary) for the periods list, taken from the first part
  /// of the saved JSON so the per-user rows are not loaded.
  Future<List<int>?> getAuditJobSummaryCounts(int id) async {
    final rows = await _db.query(
      'blobs',
      columns: ['data'],
      where: 'key = ? AND idx = 0',
      whereArgs: [_jobKey(id, 'result')],
    );
    if (rows.isEmpty) return null;
    final m = RegExp(
      r'"summary":\{"total":(\d+),"agent":(\d+),"management":(\d+),"notFound":(\d+)(?:,"noSalary":(\d+))?\}',
    ).firstMatch(rows.first['data'] as String);
    if (m == null) return null;
    // «بدون راتب» (3.4.0) is 0 in results saved before it existed.
    return [for (var g = 1; g <= 5; g++) int.parse(m.group(g) ?? '0')];
  }

  // ---------------------------------------------------------------- cycles

  static const _cycleColumns = [
    'id',
    'name',
    'management_spreadsheet_id',
    'management_sheet_name',
    'agent_spreadsheet_id',
    'agent_sheet_name',
    'transfer_discount_pct',
    'user_info_spreadsheet_id',
    'user_info_sheet_name',
    'payroll_audit_user_info_hash',
    'payroll_audit_closed_at',
    'management_count',
    'agent_count',
    'created_at',
    'updated_at',
  ];

  /// Light records (names, links, row counts) without the sheet data.
  Future<List<Cycle>> listCycles() async {
    final rows = await _db.query(
      'financial_cycles',
      columns: _cycleColumns,
      orderBy: 'created_at DESC, id DESC',
    );
    return rows.map((r) => Cycle.fromRow(r)).toList();
  }

  /// One cycle without its sheet data.
  Future<Cycle?> getCycleInfo(int id) async {
    final rows = await _db.query(
      'financial_cycles',
      columns: _cycleColumns,
      where: 'id = ?',
      whereArgs: [id],
    );
    return rows.isEmpty ? null : Cycle.fromRow(rows.first);
  }

  /// One cycle with its management and agent snapshots.
  Future<Cycle?> getCycle(int id) async {
    final rows = await _db.query(
      'financial_cycles',
      columns: _cycleColumns,
      where: 'id = ?',
      whereArgs: [id],
    );
    if (rows.isEmpty) return null;
    return Cycle.fromRow(
      rows.first,
      management: decodeRows(await getBlob(_cycleKey(id, 'management'))),
      agent: decodeRows(await getBlob(_cycleKey(id, 'agent'))),
    );
  }

  Future<int> insertCycle({
    required String name,
    required Rows? managementRows,
    required Rows? agentRows,
    String? managementSpreadsheetId,
    String? managementSheetName,
    String? agentSpreadsheetId,
    String? agentSheetName,
    double transferDiscountPct = 0,
  }) async {
    final now = _now();
    final id = await _db.insert('financial_cycles', {
      'name': name,
      'management_count': managementRows?.length ?? 0,
      'agent_count': agentRows?.length ?? 0,
      'management_spreadsheet_id': _str(managementSpreadsheetId),
      'management_sheet_name': _str(managementSheetName),
      'agent_spreadsheet_id': _str(agentSpreadsheetId),
      'agent_sheet_name': _str(agentSheetName),
      'transfer_discount_pct': transferDiscountPct,
      'created_at': now,
      'updated_at': now,
    });
    if (managementRows != null) {
      await putBlob(_cycleKey(id, 'management'), jsonEncode(managementRows));
    }
    if (agentRows != null) {
      await putBlob(_cycleKey(id, 'agent'), jsonEncode(agentRows));
    }
    return id;
  }

  /// Only the provided fields change (like ERP `PUT /cycles/:id`).
  Future<void> updateCycle(int id, Map<String, Object?> fields) async {
    const blobParts = {
      'management_data': 'management',
      'agent_data': 'agent',
      'user_info_data': 'userinfo',
    };
    final values = <String, Object?>{};
    for (final e in blobParts.entries) {
      if (!fields.containsKey(e.key)) continue;
      final rows = fields[e.key];
      await putBlob(
        _cycleKey(id, e.value),
        rows == null ? null : jsonEncode(rows),
      );
      if (e.value == 'management') {
        values['management_count'] = rows is List ? rows.length : 0;
      }
      if (e.value == 'agent') {
        values['agent_count'] = rows is List ? rows.length : 0;
      }
    }
    fields.forEach((key, value) {
      if (blobParts.containsKey(key)) return;
      if (value is List) {
        values[key] = jsonEncode(value);
      } else if (value is String && key.endsWith('_id') ||
          value is String && key.endsWith('_name')) {
        values[key] = _str(value);
      } else {
        values[key] = value;
      }
    });
    values['updated_at'] = _now();
    await _db.update(
      'financial_cycles',
      values,
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  Future<void> deleteCycle(int id) async {
    final jobs = await _db.query(
      'audit_jobs',
      columns: ['id'],
      where: 'cycle_id = ?',
      whereArgs: [id],
    );
    for (final j in jobs) {
      await _deleteBlobs('job/${j['id']}/');
    }
    await _deleteBlobs('cycle/$id/');
    await _deleteBlobs('cache/$id/');
    await _deleteBlobs('workbook/$id');
    await _db.delete('financial_cycles', where: 'id = ?', whereArgs: [id]);
  }

  Future<void> setAuditClosed(int id, bool closed) async {
    if (closed) {
      await _db.rawUpdate(
        'UPDATE financial_cycles SET payroll_audit_closed_at = COALESCE(payroll_audit_closed_at, ?), updated_at = ? WHERE id = ?',
        [_now(), _now(), id],
      );
    } else {
      await _db.rawUpdate(
        'UPDATE financial_cycles SET payroll_audit_closed_at = NULL, updated_at = ? WHERE id = ?',
        [_now(), id],
      );
    }
  }

  // -------------------------------------------------------------- settings

  Future<PayrollSettings> getPayrollSettings() async {
    final rows = await _db.query('payroll_settings', where: 'id = 1');
    if (rows.isEmpty) return const PayrollSettings();
    final r = rows.first;
    return PayrollSettings(
      discountRate: (r['discount_rate'] as num?)?.toDouble() ?? 0,
      agentColor: (r['agent_color'] as String?) ?? '#8b5cf6',
      managementColor: (r['management_color'] as String?) ?? '#facc15',
    );
  }

  Future<void> savePayrollSettings(PayrollSettings s) =>
      _db.insert('payroll_settings', {
        'id': 1,
        'discount_rate': s.discountRate,
        'agent_color': s.agentColor,
        'management_color': s.managementColor,
        'updated_at': _now(),
      }, conflictAlgorithm: ConflictAlgorithm.replace);

  // --------------------------------------------------------------- columns

  /// Columns saved for the cycle by its last audit; before that, the
  /// workspace defaults (Settings).
  Future<CycleColumns> getCycleColumns(int cycleId) async {
    final rows = await _db.query(
      'payroll_cycle_columns',
      where: 'cycle_id = ?',
      whereArgs: [cycleId],
    );
    final ws = await getWorkspaceColumns();
    if (rows.isEmpty) {
      return CycleColumns(
        mgmtUserIdCol: ws.mgmtUserIdCol,
        agentUserIdCol: ws.agentUserIdCol,
        agentSalaryCol: ws.agentSalaryCol,
      );
    }
    final r = rows.first;
    return CycleColumns(
      mgmtUserIdCol: (r['mgmt_user_id_col'] as String?) ?? ws.mgmtUserIdCol,
      agentUserIdCol: (r['agent_user_id_col'] as String?) ?? ws.agentUserIdCol,
      agentSalaryCol: (r['agent_salary_col'] as String?) ?? ws.agentSalaryCol,
    );
  }

  /// Default columns of this workspace (each workspace has its own
  /// database, so its own columns).
  Future<WorkspaceColumns> getWorkspaceColumns() async {
    final raw = await getValue(WorkspaceColumns.storageKey);
    if (raw == null) return const WorkspaceColumns();
    try {
      return WorkspaceColumns.fromJson(jsonDecode(raw));
    } catch (_) {
      return const WorkspaceColumns();
    }
  }

  Future<void> saveWorkspaceColumns(WorkspaceColumns c) =>
      setValue(WorkspaceColumns.storageKey, jsonEncode(c.toJson()));

  Future<void> saveCycleColumns(int cycleId, CycleColumns c) =>
      _db.insert('payroll_cycle_columns', {
        'cycle_id': cycleId,
        'mgmt_user_id_col': c.mgmtUserIdCol,
        'agent_user_id_col': c.agentUserIdCol,
        'agent_salary_col': c.agentSalaryCol,
        'updated_at': _now(),
      }, conflictAlgorithm: ConflictAlgorithm.replace);

  // ----------------------------------------------------------------- cache

  static const _cacheColumns = [
    'cycle_id',
    'management_sheet_name',
    'agent_sheet_name',
    'audited_agent_ids',
    'audited_mgmt_ids',
    'found_in_target_sheet_ids',
    'synced_at',
    'stale_after',
  ];

  Future<bool> hasCycleCache(int cycleId) async {
    final rows = await _db.query(
      'payroll_cycle_cache',
      columns: ['cycle_id'],
      where: 'cycle_id = ?',
      whereArgs: [cycleId],
    );
    return rows.isNotEmpty;
  }

  /// Ids the search shows as audited from the cache (audited by the last
  /// bulk audit or the selective audit, or coloured rows found by the
  /// background sync), without loading the cached sheets.
  Future<Set<String>> cacheAuditedIds(int cycleId) async {
    final rows = await _db.query(
      'payroll_cycle_cache',
      columns: ['audited_agent_ids', 'audited_mgmt_ids'],
      where: 'cycle_id = ?',
      whereArgs: [cycleId],
    );
    final out = <String>{};
    if (rows.isEmpty) return out;
    for (final key in const ['audited_agent_ids', 'audited_mgmt_ids']) {
      try {
        final d = jsonDecode((rows.first[key] ?? '[]').toString());
        if (d is List) out.addAll(d.map((e) => e.toString()));
      } catch (_) {}
    }
    return out;
  }

  /// ERP `stale_after` of the cycle cache (null when absent or unset).
  Future<DateTime?> cacheStaleAfter(int cycleId) async {
    final rows = await _db.query(
      'payroll_cycle_cache',
      columns: ['stale_after'],
      where: 'cycle_id = ?',
      whereArgs: [cycleId],
    );
    if (rows.isEmpty) return null;
    return DateTime.tryParse((rows.first['stale_after'] ?? '').toString());
  }

  Future<CycleCache?> getCycleCache(int cycleId) async {
    final rows = await _db.query(
      'payroll_cycle_cache',
      columns: _cacheColumns,
      where: 'cycle_id = ?',
      whereArgs: [cycleId],
    );
    if (rows.isEmpty) return null;
    final r = rows.first;
    Set<String> ids(Object? v) {
      try {
        final d = jsonDecode((v ?? '[]').toString());
        return d is List ? d.map((e) => e.toString()).toSet() : <String>{};
      } catch (_) {
        return <String>{};
      }
    }

    return CycleCache(
      managementData: decodeRows(
        await getBlob(_cacheKey(cycleId, 'management')),
      ),
      agentData: decodeRows(await getBlob(_cacheKey(cycleId, 'agent'))),
      managementSheetName: _str(r['management_sheet_name']),
      agentSheetName: _str(r['agent_sheet_name']),
      auditedAgentIds: ids(r['audited_agent_ids']),
      auditedMgmtIds: ids(r['audited_mgmt_ids']),
      foundInTargetSheetIds: ids(r['found_in_target_sheet_ids']),
      staleAfter: DateTime.tryParse((r['stale_after'] ?? '').toString()),
    );
  }

  Future<void> saveCycleCache(int cycleId, CycleCache c) async {
    await putBlob(
      _cacheKey(cycleId, 'management'),
      jsonEncode(c.managementData),
    );
    await putBlob(_cacheKey(cycleId, 'agent'), jsonEncode(c.agentData));
    await _db.insert('payroll_cycle_cache', {
      'cycle_id': cycleId,
      'management_sheet_name': c.managementSheetName,
      'agent_sheet_name': c.agentSheetName,
      'audited_agent_ids': jsonEncode(c.auditedAgentIds.toList()),
      'audited_mgmt_ids': jsonEncode(c.auditedMgmtIds.toList()),
      'found_in_target_sheet_ids': jsonEncode(c.foundInTargetSheetIds.toList()),
      'synced_at': _now(),
      'stale_after': c.staleAfter?.toIso8601String(),
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  // ---------------------------------------------------------- user status

  Future<void> saveUserAuditStatuses(
    int cycleId,
    List<AuditEntry> entries,
  ) async {
    if (entries.isEmpty) return;
    final byMid = <String, AuditEntry>{};
    for (final e in entries) {
      final mid = e.memberUserId.trim();
      if (mid.isNotEmpty) byMid[mid] = e;
    }
    final batch = _db.batch();
    final now = _now();
    byMid.forEach((mid, e) {
      batch.insert('payroll_user_audit_cache', {
        'cycle_id': cycleId,
        'member_user_id': mid,
        'audit_status': e.status,
        'audit_source': e.source,
        'details_json': e.details == null ? null : jsonEncode(e.details),
        'updated_at': now,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    });
    await batch.commit(noResult: true);
  }

  Future<UserAuditStatus?> getUserAuditStatus(
    int cycleId,
    String memberId,
  ) async {
    final rows = await _db.query(
      'payroll_user_audit_cache',
      where: 'cycle_id = ? AND member_user_id = ?',
      whereArgs: [cycleId, memberId],
    );
    if (rows.isEmpty) return null;
    final r = rows.first;
    Map<String, Object?>? details;
    try {
      final d =
          r['details_json'] == null
              ? null
              : jsonDecode(r['details_json'] as String);
      if (d is Map) details = Map<String, Object?>.from(d);
    } catch (_) {}
    return UserAuditStatus(
      (r['audit_status'] as String?) ?? 'غير مدقق',
      r['audit_source'] as String?,
      details,
    );
  }

  Future<Set<String>> auditedMemberIds(int cycleId) async {
    final rows = await _db.query(
      'payroll_user_audit_cache',
      columns: ['member_user_id'],
      where: 'cycle_id = ? AND audit_status = ?',
      whereArgs: [cycleId, 'مدقق'],
    );
    return rows.map((r) => r['member_user_id'].toString()).toSet();
  }

  Future<int> countAudited(int cycleId) async {
    final r = await _db.rawQuery(
      "SELECT COUNT(*) AS n FROM payroll_user_audit_cache WHERE cycle_id = ? AND audit_status = 'مدقق'",
      [cycleId],
    );
    return (r.first['n'] as num?)?.toInt() ?? 0;
  }

  // ------------------------------------------------------- local workbook

  Future<Map<String, Object?>?> getLocalWorkbook(int cycleId) async {
    final text = await getBlob('workbook/$cycleId');
    if (text == null || text.isEmpty) return null;
    try {
      final d = jsonDecode(text);
      return d is Map ? Map<String, Object?>.from(d) : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> saveLocalWorkbook(
    int cycleId,
    Map<String, Object?> state,
  ) async {
    await putBlob('workbook/$cycleId', jsonEncode(state));
    await _db.insert('local_workbooks', {
      'cycle_id': cycleId,
      'state_json': '',
      'updated_at': _now(),
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  // ------------------------------------------------------------- run log

  Future<void> addAuditRun(
    int cycleId,
    String mode,
    Map<String, Object?> payload,
  ) => _db.insert('audit_runs', {
    'cycle_id': cycleId,
    'created_at': _now(),
    'mode': mode,
    'payload_json': jsonEncode(payload),
  });

  Future<List<AuditRun>> listAuditRuns(int cycleId, {int limit = 20}) async {
    final rows = await _db.query(
      'audit_runs',
      where: 'cycle_id = ?',
      whereArgs: [cycleId],
      orderBy: 'id DESC',
      limit: limit,
    );
    return [
      for (final r in rows)
        AuditRun(
          id: r['id'] as int,
          cycleId: r['cycle_id'] as int,
          createdAt:
              DateTime.tryParse(r['created_at'] as String) ?? DateTime.now(),
          mode: r['mode'] as String,
          payload: Map<String, Object?>.from(
            jsonDecode(r['payload_json'] as String) as Map,
          ),
        ),
    ];
  }

  // ------------------------------------------------------------------- kv

  Future<String?> getValue(String key) async {
    final rows = await _db.query('kv', where: 'key = ?', whereArgs: [key]);
    return rows.isEmpty ? null : rows.first['value'] as String?;
  }

  Future<void> setValue(String key, String? value) => _db.insert('kv', {
    'key': key,
    'value': value,
  }, conflictAlgorithm: ConflictAlgorithm.replace);

  Future<void> close() => _db.close();
}
