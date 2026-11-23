import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

/// A workspace (owner's request, 2026-11-17): a separate set of cycles,
/// audits, settings and columns — for example another company — in the
/// same app, with the same Google account.
class Workspace {
  const Workspace(this.id, this.name, this.file);
  final int id;
  final String name;

  /// Database file of the workspace, next to the registry.
  final String file;

  /// The workspace that holds the data of versions before 2.4.0.
  bool get isMain => id == WorkspaceRegistry.mainId;
}

/// The list of workspaces. Each workspace keeps all its data in its own
/// SQLite file, so workspaces never see each other's cycles, statuses,
/// jobs or settings. The first workspace uses the app's original file, so
/// nothing moves when the app is updated.
class WorkspaceRegistry {
  WorkspaceRegistry._(this._db, this.directory, this._factory);

  final Database _db;
  final DatabaseFactory _factory;

  /// Folder of the database files.
  final String directory;

  static const mainId = 1;
  static const mainFile = 'lork_erp.db';
  static const mainName = 'مساحة العمل الرئيسية';

  static Future<WorkspaceRegistry> open({
    String? directory,
    DatabaseFactory? factory,
  }) async {
    final f = factory ?? databaseFactory;
    final dir = directory ?? await f.getDatabasesPath();
    final db = await f.openDatabase(
      p.join(dir, 'workspaces.db'),
      options: OpenDatabaseOptions(
        version: 1,
        onCreate: (db, version) async {
          await db.execute('''CREATE TABLE workspaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            file TEXT NOT NULL,
            created_at TEXT NOT NULL
          )''');
          await db.execute(
            'CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)',
          );
          await db.insert('workspaces', {
            'id': mainId,
            'name': mainName,
            'file': mainFile,
            'created_at': DateTime.now().toIso8601String(),
          });
        },
      ),
    );
    return WorkspaceRegistry._(db, dir, f);
  }

  String pathOf(Workspace w) => p.join(directory, w.file);

  static Workspace _row(Map<String, Object?> r) => Workspace(
    r['id'] as int,
    (r['name'] as String?) ?? '',
    r['file'] as String,
  );

  Future<List<Workspace>> list() async =>
      (await _db.query('workspaces', orderBy: 'id')).map(_row).toList();

  Future<Workspace?> get(int id) async {
    final rows = await _db.query(
      'workspaces',
      where: 'id = ?',
      whereArgs: [id],
    );
    return rows.isEmpty ? null : _row(rows.first);
  }

  /// The workspace the app opens.
  Future<Workspace> active() async {
    final rows = await _db.query('kv', where: 'key = ?', whereArgs: ['active']);
    final id = rows.isEmpty ? null : int.tryParse('${rows.first['value']}');
    final w = id == null ? null : await get(id);
    return w ?? (await list()).first;
  }

  /// Settings ← المظهر, for the whole app: 'light', 'dark' or 'system'.
  Future<String> appearance() async {
    final rows = await _db.query(
      'kv',
      where: 'key = ?',
      whereArgs: ['appearance'],
    );
    final v = rows.isEmpty ? null : '${rows.first['value']}';
    return const ['light', 'dark', 'system'].contains(v) ? v! : 'system';
  }

  Future<void> setAppearance(String value) => _db.insert('kv', {
    'key': 'appearance',
    'value': value,
  }, conflictAlgorithm: ConflictAlgorithm.replace);

  Future<void> setActive(int id) => _db.insert('kv', {
    'key': 'active',
    'value': '$id',
  }, conflictAlgorithm: ConflictAlgorithm.replace);

  static String cleanName(String name) =>
      name.replaceAll(RegExp(r'\s+'), ' ').trim();

  Future<Workspace> create(String name) async {
    final clean = cleanName(name);
    if (clean.isEmpty) throw ArgumentError('اكتب اسم مساحة العمل');
    return _db.transaction((txn) async {
      final id = await txn.insert('workspaces', {
        'name': clean,
        'file': '',
        'created_at': DateTime.now().toIso8601String(),
      });
      final file = 'erp_audit_ws$id.db';
      await txn.update(
        'workspaces',
        {'file': file},
        where: 'id = ?',
        whereArgs: [id],
      );
      return Workspace(id, clean, file);
    });
  }

  Future<void> rename(int id, String name) async {
    final clean = cleanName(name);
    if (clean.isEmpty) throw ArgumentError('اكتب اسم مساحة العمل');
    await _db.update(
      'workspaces',
      {'name': clean},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// Removes the workspace and its database file. The main workspace and
  /// the open one cannot be deleted.
  Future<void> delete(int id) async {
    final w = await get(id);
    if (w == null) return;
    if (w.isMain) throw StateError('لا يمكن حذف مساحة العمل الرئيسية.');
    if ((await active()).id == id) {
      throw StateError('انتقل إلى مساحة عمل أخرى قبل حذف هذه.');
    }
    await _db.delete('workspaces', where: 'id = ?', whereArgs: [id]);
    await _factory.deleteDatabase(pathOf(w));
  }

  Future<void> close() => _db.close();
}
