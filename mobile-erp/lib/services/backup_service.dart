import 'dart:convert';
import 'dart:io' show gzip;
import 'dart:math';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:sqflite/sqflite.dart';

import '../data/app_database.dart';
import '../google/google_auth.dart';
import '../version.dart';

class BackupException implements Exception {
  BackupException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// What a backup holds (read before restoring).
class BackupInfo {
  const BackupInfo({
    required this.workspace,
    required this.createdAt,
    required this.appVersion,
    required this.schema,
    required this.counts,
  });
  final String workspace;
  final DateTime? createdAt;
  final String appVersion;
  final int schema;

  /// Rows per table.
  final Map<String, int> counts;

  int get entries => counts['acc_entries'] ?? 0;
  int get accounts => counts['acc_accounts'] ?? 0;
  int get cycles => counts['financial_cycles'] ?? 0;
}

/// A backup file on Google Drive.
class DriveBackup {
  const DriveBackup({
    required this.id,
    required this.name,
    required this.createdAt,
    required this.size,
    required this.workspace,
  });
  final String id;
  final String name;
  final DateTime? createdAt;
  final int size;
  final String workspace;
}

/// Backups of one workspace (its whole database: books, cycles, settings):
/// a gzip JSON file saved anywhere, or uploaded to the user's Google Drive
/// (files this app creates only, `drive.file`).
class BackupService {
  BackupService(this.db, this.auth, {http.Client? client})
    : _client = client ?? http.Client();
  final AppDatabase db;
  final GoogleAuth auth;
  final http.Client _client;

  static const format = 'lorkerp-backup';
  static const extension = 'lorkerp';
  static const _skip = {'sqlite_sequence', 'android_metadata'};

  Database get _raw => db.raw;

  Future<List<String>> _tables(DatabaseExecutor ex) async {
    final rows = await ex.rawQuery(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    return [
      for (final r in rows)
        if (!_skip.contains(r['name']) &&
            !(r['name'] as String).startsWith('sqlite_'))
          r['name'] as String,
    ];
  }

  static Object? _enc(Object? v) =>
      v is Uint8List ? {r'$b64': base64Encode(v)} : v;
  static Object? _dec(Object? v) =>
      v is Map && v.containsKey(r'$b64')
          ? base64Decode(v[r'$b64'] as String)
          : v;

  /// The backup file of this workspace.
  Future<Uint8List> export(String workspaceName) async {
    final tables = <String, Object?>{};
    for (final t in await _tables(_raw)) {
      final rows = await _raw.query(t);
      final columns =
          rows.isEmpty
              ? [
                for (final c in await _raw.rawQuery('PRAGMA table_info("$t")'))
                  c['name'] as String,
              ]
              : rows.first.keys.toList();
      tables[t] = {
        'columns': columns,
        'rows': [
          for (final r in rows) [for (final c in columns) _enc(r[c])],
        ],
      };
    }
    final json = jsonEncode({
      'format': format,
      'version': 1,
      'schema': AppDatabase.schemaVersion,
      'app': appVersion,
      'workspace': workspaceName,
      'createdAt': DateTime.now().toIso8601String(),
      'tables': tables,
    });
    return Uint8List.fromList(gzip.encode(utf8.encode(json)));
  }

  static Map<String, Object?> _decode(List<int> bytes) {
    try {
      final text = utf8.decode(gzip.decode(bytes));
      final m = jsonDecode(text) as Map<String, Object?>;
      if (m['format'] != format) {
        throw BackupException('الملف ليس نسخة احتياطية من LorkERP');
      }
      return m;
    } on BackupException {
      rethrow;
    } catch (_) {
      throw BackupException('الملف ليس نسخة احتياطية من LorkERP أو أنه تالف');
    }
  }

  static BackupInfo inspect(List<int> bytes) {
    final m = _decode(bytes);
    final tables = (m['tables'] as Map).cast<String, Object?>();
    return BackupInfo(
      workspace: '${m['workspace'] ?? ''}',
      createdAt: DateTime.tryParse('${m['createdAt']}'),
      appVersion: '${m['app'] ?? ''}',
      schema: (m['schema'] as num?)?.toInt() ?? 0,
      counts: {
        for (final e in tables.entries)
          e.key: ((e.value as Map)['rows'] as List).length,
      },
    );
  }

  /// Replaces everything in this workspace with the backup. Refused while an
  /// audit runs, or for a backup of a newer version of the app.
  Future<BackupInfo> restore(List<int> bytes) async {
    final m = _decode(bytes);
    final info = inspect(bytes);
    if (info.schema > AppDatabase.schemaVersion) {
      throw BackupException(
        'النسخة من إصدار أحدث من التطبيق (${info.appVersion}); حدّث التطبيق أولًا',
      );
    }
    if ((await db.pendingAuditJobs()).isNotEmpty) {
      throw BackupException(
        'يوجد تدقيق قيد التنفيذ؛ انتظر انتهاءه ثم استعد النسخة',
      );
    }
    final tables = (m['tables'] as Map).cast<String, Object?>();
    await _raw.transaction((txn) async {
      await txn.execute('PRAGMA defer_foreign_keys = ON');
      final current = await _tables(txn);
      for (final t in current) {
        await txn.delete(t);
      }
      for (final t in current) {
        final data = tables[t] as Map?;
        if (data == null) continue;
        final have = {
          for (final c in await txn.rawQuery('PRAGMA table_info("$t")'))
            c['name'] as String,
        };
        final columns = (data['columns'] as List).cast<String>();
        final keep = [
          for (var i = 0; i < columns.length; i++)
            if (have.contains(columns[i])) i,
        ];
        final batch = txn.batch();
        for (final row in (data['rows'] as List).cast<List>()) {
          batch.insert(t, {for (final i in keep) columns[i]: _dec(row[i])});
        }
        await batch.commit(noResult: true);
      }
    });
    return info;
  }

  // ----------------------------------------------------------------- drive

  static const _folderName = 'LorkERP';
  static const _keep = 20;

  Future<Map<String, String>> _headers() async => {
    'Authorization': 'Bearer ${await auth.accessToken()}',
  };

  Future<http.Response> _send(
    Future<http.Response> Function(Map<String, String> h) f,
  ) async {
    var r = await f(await _headers());
    if (r.statusCode == 401) {
      await auth.accessToken(forceRefresh: true);
      r = await f(await _headers());
    }
    if (r.statusCode == 403 && r.body.contains('insufficient')) {
      throw BackupException(
        'اسمح للتطبيق بحفظ الملفات في Google Drive: افصل حساب Google من الإعدادات ثم اربطه مجددًا',
      );
    }
    if (r.statusCode >= 400) {
      throw BackupException('تعذر الاتصال بـ Google Drive (${r.statusCode})');
    }
    return r;
  }

  /// A stable id of this workspace's books, so its backups are listed
  /// together even after the workspace is renamed.
  Future<String> bookId() async {
    var id = await db.getValue('backup_book_id');
    if (id == null) {
      final r = Random.secure();
      id =
          List.generate(
            16,
            (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
          ).join();
      await db.setValue('backup_book_id', id);
    }
    return id;
  }

  Future<String> _folder() async {
    final q =
        "mimeType = 'application/vnd.google-apps.folder' and name = '$_folderName' and trashed = false";
    final r = await _send(
      (h) => _client.get(
        Uri.https('www.googleapis.com', '/drive/v3/files', {
          'q': q,
          'fields': 'files(id)',
          'spaces': 'drive',
        }),
        headers: h,
      ),
    );
    final files = (jsonDecode(r.body) as Map)['files'] as List;
    if (files.isNotEmpty) return (files.first as Map)['id'] as String;
    final c = await _send(
      (h) => _client.post(
        Uri.https('www.googleapis.com', '/drive/v3/files', {'fields': 'id'}),
        headers: {...h, 'Content-Type': 'application/json'},
        body: jsonEncode({
          'name': _folderName,
          'mimeType': 'application/vnd.google-apps.folder',
        }),
      ),
    );
    return (jsonDecode(c.body) as Map)['id'] as String;
  }

  /// Uploads a backup of this workspace to Drive (folder «LorkERP») and
  /// keeps the newest [_keep] of this book.
  Future<DriveBackup> uploadToDrive(String workspaceName) async {
    final bytes = await export(workspaceName);
    final book = await bookId();
    final folder = await _folder();
    final stamp = DateTime.now()
        .toIso8601String()
        .substring(0, 16)
        .replaceAll(':', '-');
    final name =
        'LorkERP ${workspaceName.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_')} $stamp.$extension';
    const boundary = 'lorkerp-backup-boundary';
    final meta = jsonEncode({
      'name': name,
      'parents': [folder],
      'mimeType': 'application/gzip',
      'appProperties': {
        'lorkerp': 'backup',
        'book': book,
        'workspace': workspaceName,
      },
    });
    final body = <int>[
      ...utf8.encode(
        '--$boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n$meta\r\n',
      ),
      ...utf8.encode('--$boundary\r\nContent-Type: application/gzip\r\n\r\n'),
      ...bytes,
      ...utf8.encode('\r\n--$boundary--'),
    ];
    final r = await _send(
      (h) => _client.post(
        Uri.https('www.googleapis.com', '/upload/drive/v3/files', {
          'uploadType': 'multipart',
          'fields': 'id,name,size,createdTime,appProperties',
        }),
        headers: {
          ...h,
          'Content-Type': 'multipart/related; boundary=$boundary',
        },
        body: body,
      ),
    );
    await db.setValue('backup_last_drive', DateTime.now().toIso8601String());
    final created = _file(jsonDecode(r.body) as Map);
    try {
      final all = await listDrive(book: book);
      for (final old in all.skip(_keep)) {
        await deleteFromDrive(old.id);
      }
    } catch (_) {}
    return created;
  }

  static DriveBackup _file(Map f) => DriveBackup(
    id: f['id'] as String,
    name: (f['name'] as String?) ?? '',
    createdAt: DateTime.tryParse('${f['createdTime']}'),
    size: int.tryParse('${f['size']}') ?? 0,
    workspace: '${(f['appProperties'] as Map?)?['workspace'] ?? ''}',
  );

  /// The backups on Drive, newest first (all books, or one [book]).
  Future<List<DriveBackup>> listDrive({String? book}) async {
    var q =
        "appProperties has { key='lorkerp' and value='backup' } and trashed = false";
    if (book != null) {
      q += " and appProperties has { key='book' and value='$book' }";
    }
    final r = await _send(
      (h) => _client.get(
        Uri.https('www.googleapis.com', '/drive/v3/files', {
          'q': q,
          'orderBy': 'createdTime desc',
          'pageSize': '100',
          'fields': 'files(id,name,size,createdTime,appProperties)',
        }),
        headers: h,
      ),
    );
    return [
      for (final f in (jsonDecode(r.body) as Map)['files'] as List)
        _file(f as Map),
    ];
  }

  Future<Uint8List> downloadFromDrive(String id) async {
    final r = await _send(
      (h) => _client.get(
        Uri.https('www.googleapis.com', '/drive/v3/files/$id', {
          'alt': 'media',
        }),
        headers: h,
      ),
    );
    return r.bodyBytes;
  }

  Future<void> deleteFromDrive(String id) async {
    await _send(
      (h) => _client.delete(
        Uri.https('www.googleapis.com', '/drive/v3/files/$id'),
        headers: h,
      ),
    );
  }

  // ------------------------------------------------------------------ auto

  Future<bool> autoDrive() async =>
      await db.getValue('backup_auto_drive') == '1';
  Future<void> setAutoDrive(bool on) =>
      db.setValue('backup_auto_drive', on ? '1' : '0');

  Future<DateTime?> lastDrive() async =>
      DateTime.tryParse(await db.getValue('backup_last_drive') ?? '');
  Future<DateTime?> lastFile() async =>
      DateTime.tryParse(await db.getValue('backup_last_file') ?? '');
  Future<void> markFileSaved() =>
      db.setValue('backup_last_file', DateTime.now().toIso8601String());

  /// The daily Drive backup when the app opens (on, connected, and the last
  /// one older than a day). Errors are kept for the backup screen.
  Future<void> autoBackupIfDue(String workspaceName) async {
    if (!await autoDrive() || !auth.isConnected) return;
    final last = await lastDrive();
    if (last != null &&
        DateTime.now().difference(last) < const Duration(hours: 24)) {
      return;
    }
    try {
      await uploadToDrive(workspaceName);
      await db.setValue('backup_auto_error', null);
    } catch (e) {
      await db.setValue('backup_auto_error', '$e');
    }
  }

  Future<String?> autoError() => db.getValue('backup_auto_error');
}
