import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import 'chart.dart';

/// A posting that breaks a rule of the ledger (unbalanced, empty, a group
/// account…); the message is shown to the user as is.
class LedgerException implements Exception {
  LedgerException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// One line of an account statement with the running balance.
class StatementLine {
  const StatementLine({
    required this.entryId,
    required this.number,
    required this.date,
    required this.memo,
    required this.kind,
    required this.debit,
    required this.credit,
    required this.balance,
    this.lineMemo = '',
    this.reversed = false,
  });
  final int entryId;
  final int number;
  final String date;
  final String memo;
  final String kind;
  final int debit;
  final int credit;

  /// Debit minus credit after this line (signed, cents).
  final int balance;
  final String lineMemo;
  final bool reversed;
}

/// The double-entry ledger of a workspace (its own SQLite database).
///
/// Rules (the web ERP broke several of them, see README):
/// - an entry has two lines or more, every line is either a debit or a
///   credit, and the debits equal the credits;
/// - only postable (non-group, non-archived) accounts take lines;
/// - a posted entry never changes: cancelling posts a reversing entry and
///   links the two, and a reversed entry cannot be reversed again;
/// - every write runs in one transaction.
class Ledger {
  Ledger(this._db);
  final Database _db;

  static Future<void> createTables(DatabaseExecutor db) async {
    await db.execute('''CREATE TABLE acc_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_id INTEGER REFERENCES acc_accounts(id),
      is_group INTEGER NOT NULL DEFAULT 0,
      role TEXT UNIQUE,
      system INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL)''');
    await db.execute('''CREATE TABLE acc_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER NOT NULL UNIQUE,
      date TEXT NOT NULL,
      memo TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT,
      reverses_id INTEGER REFERENCES acc_entries(id),
      reversed_by_id INTEGER REFERENCES acc_entries(id),
      created_at TEXT NOT NULL,
      meta TEXT)''');
    await db.execute(
      '''CREATE TABLE acc_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES acc_entries(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES acc_accounts(id),
      debit INTEGER NOT NULL DEFAULT 0,
      credit INTEGER NOT NULL DEFAULT 0,
      memo TEXT,
      CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND debit + credit > 0))''',
    );
    await db.execute('CREATE INDEX acc_lines_account ON acc_lines(account_id)');
    await db.execute('CREATE INDEX acc_lines_entry ON acc_lines(entry_id)');
    await db.execute('CREATE INDEX acc_entries_date ON acc_entries(date)');
    await createV7Tables(db);
  }

  /// Schema 7 (stage 2–3): parties and stock. Fresh databases get them from
  /// [createTables] too.
  static Future<void> createV7Tables(DatabaseExecutor db) async {
    await db.execute('''CREATE TABLE acc_parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL UNIQUE REFERENCES acc_accounts(id),
      kind TEXT NOT NULL,
      code TEXT,
      phone TEXT,
      percent INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL)''');
    await db.execute('''CREATE TABLE acc_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL UNIQUE REFERENCES acc_accounts(id),
      unit TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL)''');
    await db.execute('''CREATE TABLE acc_stock_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES acc_entries(id),
      item_id INTEGER NOT NULL REFERENCES acc_items(id),
      qty INTEGER NOT NULL,
      cost INTEGER NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      party_account_id INTEGER REFERENCES acc_accounts(id))''');
    await db.execute('CREATE INDEX acc_stock_item ON acc_stock_moves(item_id)');
    await db.execute('CREATE INDEX acc_entries_ref ON acc_entries(ref)');
  }

  /// From schema 6: entry details ([JournalEntry.meta]) and the v7 tables.
  static Future<void> upgradeTo7(DatabaseExecutor db) async {
    await db.execute('ALTER TABLE acc_entries ADD COLUMN meta TEXT');
    await createV7Tables(db);
  }

  static String _now() => DateTime.now().toIso8601String();

  static String today() {
    final d = DateTime.now();
    return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
  }

  // ------------------------------------------------------------ accounts

  /// Adds the accounts of [defaultChart] that are missing (by code); safe
  /// to run at every start, so later versions can add accounts.
  Future<void> ensureSeeded() async {
    await _db.transaction((txn) async {
      final rows = await txn.query(
        'acc_accounts',
        columns: ['id', 'code', 'role'],
      );
      final byCode = {
        for (final r in rows) r['code'] as String: r['id'] as int,
      };
      final roles = {
        for (final r in rows)
          if (r['role'] != null) r['role'] as String: r['id'] as int,
      };
      // Default code → the account seeded for it (its children's parent).
      final seeded = <String, int>{};
      for (final (code, name, type, parent, group, role) in defaultChart) {
        if (role != null && roles.containsKey(role)) {
          seeded[code] = roles[role]!;
          continue;
        }
        var use = code;
        if (byCode.containsKey(code)) {
          // The code is the user's own account (added before this version
          // seeded it): keep theirs, seed this one under a free code.
          if (role == null) {
            seeded[code] = byCode[code]!;
            continue;
          }
          final prefix = code.substring(0, code.length - 1);
          use = [
            for (var n = 90; n < 100; n++) '$prefix$n',
          ].firstWhere((c) => !byCode.containsKey(c), orElse: () => '${code}9');
        }
        final id = await txn.insert('acc_accounts', {
          'code': use,
          'name': name,
          'type': type.name,
          'parent_id':
              parent == null ? null : (seeded[parent] ?? byCode[parent]),
          'is_group': group ? 1 : 0,
          'role': role,
          'system': 1,
          'created_at': _now(),
        });
        byCode[use] = id;
        seeded[code] = id;
        if (role != null) roles[role] = id;
      }
    });
  }

  Future<List<Account>> accounts({bool archived = false}) async {
    final rows = await _db.query(
      'acc_accounts',
      where: archived ? null : 'archived = 0',
      orderBy: 'code',
    );
    return rows.map(Account.fromRow).toList();
  }

  Future<Account?> account(int id) async {
    final rows = await _db.query(
      'acc_accounts',
      where: 'id = ?',
      whereArgs: [id],
    );
    return rows.isEmpty ? null : Account.fromRow(rows.first);
  }

  Future<Account> byRole(String role) async {
    final rows = await _db.query(
      'acc_accounts',
      where: 'role = ?',
      whereArgs: [role],
    );
    if (rows.isEmpty) {
      throw LedgerException('الحساب غير موجود في الشجرة ($role)');
    }
    return Account.fromRow(rows.first);
  }

  /// The postable accounts under the group of [role] (e.g. the funds).
  Future<List<Account>> childrenOfRole(
    String role, {
    bool archived = false,
  }) async {
    final group = await byRole(role);
    final all = await accounts(archived: archived);
    final ids = _descendants(all, group.id);
    return [
      for (final a in all)
        if (ids.contains(a.id) && !a.isGroup) a,
    ];
  }

  static Set<int> _descendants(List<Account> all, int root) {
    final out = <int>{root};
    var grew = true;
    while (grew) {
      grew = false;
      for (final a in all) {
        if (a.parentId != null && out.contains(a.parentId) && out.add(a.id)) {
          grew = true;
        }
      }
    }
    return out;
  }

  /// The next free code under [parent]: «1101» → «1102», a new group's
  /// first child gets «(parent)01».
  Future<String> nextCode(Account parent) async {
    final rows = await _db.query(
      'acc_accounts',
      columns: ['code'],
      where: 'parent_id = ?',
      whereArgs: [parent.id],
    );
    var max = 0;
    for (final r in rows) {
      final c = r['code'] as String;
      if (!c.startsWith(parent.code)) continue;
      final n = int.tryParse(c.substring(parent.code.length)) ?? 0;
      if (n > max) max = n;
    }
    final width = parent.code.length <= 1 ? 1 : 2;
    var next = max + 1;
    while (true) {
      final code = '${parent.code}${next.toString().padLeft(width, '0')}';
      final taken = await _db.query(
        'acc_accounts',
        columns: ['id'],
        where: 'code = ?',
        whereArgs: [code],
      );
      if (taken.isEmpty) return code;
      next++;
    }
  }

  /// A new account under [parentId] (its type is the parent's).
  Future<Account> addAccount({
    required String name,
    required int parentId,
    String? code,
    bool isGroup = false,
    String note = '',
    String? role,
  }) async {
    final n = name.trim();
    if (n.isEmpty) throw LedgerException('اكتب اسم الحساب');
    final parent = await account(parentId);
    if (parent == null) throw LedgerException('الحساب الأب غير موجود');
    if (!parent.isGroup) {
      throw LedgerException(
        '«${parent.name}» حساب فرعي يقبل القيود؛ اختر حسابًا رئيسيًا (مجموعة) ليكون الأب',
      );
    }
    final c =
        (code ?? '').trim().isEmpty ? await nextCode(parent) : code!.trim();
    final dup = await _db.query(
      'acc_accounts',
      columns: ['name'],
      where: 'code = ?',
      whereArgs: [c],
    );
    if (dup.isNotEmpty) {
      throw LedgerException('الرمز $c مستخدم للحساب «${dup.first['name']}»');
    }
    final id = await _db.insert('acc_accounts', {
      'code': c,
      'name': n,
      'type': parent.type.name,
      'parent_id': parent.id,
      'is_group': isGroup ? 1 : 0,
      'role': role,
      'system': 0,
      'note': note,
      'created_at': _now(),
    });
    return (await account(id))!;
  }

  Future<void> renameAccount(int id, String name, {String? note}) async {
    final n = name.trim();
    if (n.isEmpty) throw LedgerException('اكتب اسم الحساب');
    await _db.update(
      'acc_accounts',
      {'name': n, if (note != null) 'note': note},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// Hides an account from pickers; only with a zero balance.
  Future<void> setArchived(int id, bool archived) async {
    final a = await account(id);
    if (a == null) return;
    if (archived) {
      if (a.role == Roles.mainFund) {
        throw LedgerException('لا يمكن أرشفة الصندوق الرئيسي');
      }
      final bal = await balanceOf(id);
      if (bal != 0) {
        throw LedgerException(
          'رصيد «${a.name}» ليس صفرًا؛ حوّله أولًا ثم أرشف الحساب',
        );
      }
    }
    await _db.update(
      'acc_accounts',
      {'archived': archived ? 1 : 0},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// Deletes an account the user added that has no lines and no children.
  Future<void> deleteAccount(int id) async {
    final a = await account(id);
    if (a == null) return;
    if (a.system) {
      throw LedgerException(
        '«${a.name}» من حسابات النظام؛ يمكن تغيير اسمه لا حذفه',
      );
    }
    final kids = await _db.query(
      'acc_accounts',
      columns: ['id'],
      where: 'parent_id = ?',
      whereArgs: [id],
      limit: 1,
    );
    if (kids.isNotEmpty) {
      throw LedgerException('للحساب حسابات فرعية؛ احذفها أولًا');
    }
    final used = await _db.query(
      'acc_lines',
      columns: ['id'],
      where: 'account_id = ?',
      whereArgs: [id],
      limit: 1,
    );
    if (used.isNotEmpty) {
      throw LedgerException(
        'على الحساب قيود؛ يمكن أرشفته عندما يصبح رصيده صفرًا',
      );
    }
    await _db.delete('acc_accounts', where: 'id = ?', whereArgs: [id]);
  }

  // ------------------------------------------------------------- posting

  Future<JournalEntry> post(EntryDraft draft) =>
      _db.transaction((txn) => _post(txn, draft));

  /// Runs [action] in one transaction (several entries, or an entry and
  /// its stock moves, all or nothing).
  Future<T> transaction<T>(Future<T> Function(Transaction txn) action) =>
      _db.transaction(action);

  /// [post] inside a [transaction].
  Future<JournalEntry> postIn(Transaction txn, EntryDraft draft) =>
      _post(txn, draft);

  /// Checks run before an entry is reversed (e.g. stock that would go below
  /// zero); a guard throws [LedgerException] to refuse.
  final reverseGuards =
      <Future<void> Function(Transaction txn, JournalEntry e)>[];

  /// The raw database (for the modules built on the ledger).
  Database get db => _db;

  Future<JournalEntry> _post(
    Transaction txn,
    EntryDraft draft, {
    int? reverses,
  }) async {
    final memo = draft.memo.trim();
    if (memo.isEmpty) throw LedgerException('اكتب بيان القيد');
    if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(draft.date)) {
      throw LedgerException('تاريخ القيد غير صحيح');
    }
    final lines = [
      for (final l in draft.lines)
        if (l.debit != 0 || l.credit != 0) l,
    ];
    if (lines.length < 2) throw LedgerException('القيد يحتاج سطرين على الأقل');
    var debit = 0, credit = 0;
    for (final l in lines) {
      if (l.debit < 0 || l.credit < 0) {
        throw LedgerException('المبالغ لا تكون سالبة');
      }
      if (l.debit > 0 && l.credit > 0) {
        throw LedgerException('السطر الواحد إما مدين أو دائن');
      }
      debit += l.debit;
      credit += l.credit;
    }
    if (debit != credit) {
      throw LedgerException(
        'القيد غير متوازن: المدين ${_fmt(debit)} والدائن ${_fmt(credit)}',
      );
    }
    final ids = {for (final l in lines) l.accountId}.toList();
    final rows = await txn.query(
      'acc_accounts',
      where: 'id IN (${List.filled(ids.length, '?').join(',')})',
      whereArgs: ids,
    );
    final byId = {for (final r in rows) r['id'] as int: Account.fromRow(r)};
    for (final id in ids) {
      final a = byId[id];
      if (a == null) throw LedgerException('حساب غير موجود في القيد');
      if (a.isGroup) {
        throw LedgerException('«${a.name}» حساب رئيسي؛ اختر حسابًا فرعيًا منه');
      }
      if (a.archived && reverses == null) {
        throw LedgerException('«${a.name}» مؤرشف');
      }
    }
    final next = await txn.rawQuery(
      'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM acc_entries',
    );
    final number = next.first['n'] as int;
    final id = await txn.insert('acc_entries', {
      'number': number,
      'date': draft.date,
      'memo': memo,
      'kind': draft.kind,
      'ref': draft.ref,
      'reverses_id': reverses,
      'created_at': _now(),
      'meta': draft.meta == null ? null : jsonEncode(draft.meta),
    });
    for (final l in lines) {
      await txn.insert('acc_lines', {
        'entry_id': id,
        'account_id': l.accountId,
        'debit': l.debit,
        'credit': l.credit,
        'memo': l.memo,
      });
    }
    final row =
        (await txn.query(
          'acc_entries',
          where: 'id = ?',
          whereArgs: [id],
        )).first;
    return JournalEntry.fromRow(row, lines);
  }

  /// Cancels [entryId] with a reversing entry (debits and credits swapped)
  /// dated [date] (default today); the two are linked.
  Future<JournalEntry> reverse(int entryId, {String? date, String? memo}) =>
      _db.transaction((txn) async {
        final rows = await txn.query(
          'acc_entries',
          where: 'id = ?',
          whereArgs: [entryId],
        );
        if (rows.isEmpty) throw LedgerException('القيد غير موجود');
        final e = JournalEntry.fromRow(rows.first);
        if (e.reversedById != null) {
          throw LedgerException('القيد رقم ${e.number} مُلغى من قبل');
        }
        if (e.reversesId != null) {
          throw LedgerException('هذا قيد إلغاء؛ لا يُلغى');
        }
        final lines = await _lines(txn, entryId);
        for (final g in reverseGuards) {
          await g(txn, JournalEntry.fromRow(rows.first, lines));
        }
        final rev = await _post(
          txn,
          EntryDraft(
            date: date ?? today(),
            memo: memo ?? 'إلغاء القيد رقم ${e.number}: ${e.memo}',
            kind: EntryKind.reversal,
            ref: e.ref,
            lines: [for (final l in lines) l.swapped],
          ),
          reverses: entryId,
        );
        await txn.update(
          'acc_entries',
          {'reversed_by_id': rev.id},
          where: 'id = ?',
          whereArgs: [entryId],
        );
        return rev;
      });

  // ------------------------------------------------------------- queries

  static Future<List<JournalLine>> _lines(
    DatabaseExecutor db,
    int entryId,
  ) async {
    final rows = await db.query(
      'acc_lines',
      where: 'entry_id = ?',
      whereArgs: [entryId],
      orderBy: 'id',
    );
    return [
      for (final r in rows)
        JournalLine(
          accountId: r['account_id'] as int,
          debit: r['debit'] as int,
          credit: r['credit'] as int,
          memo: (r['memo'] as String?) ?? '',
        ),
    ];
  }

  Future<JournalEntry?> entry(int id) async {
    final rows = await _db.query(
      'acc_entries',
      where: 'id = ?',
      whereArgs: [id],
    );
    if (rows.isEmpty) return null;
    return JournalEntry.fromRow(rows.first, await _lines(_db, id));
  }

  /// Entries newest first, optionally of one account, one kind or a range.
  Future<List<JournalEntry>> entries({
    String? from,
    String? to,
    String? kind,
    int? accountId,
    int limit = 100,
    int offset = 0,
  }) async {
    final where = <String>[];
    final args = <Object?>[];
    if (from != null) {
      where.add('e.date >= ?');
      args.add(from);
    }
    if (to != null) {
      where.add('e.date <= ?');
      args.add(to);
    }
    if (kind != null) {
      where.add('e.kind = ?');
      args.add(kind);
    }
    if (accountId != null) {
      where.add(
        'EXISTS (SELECT 1 FROM acc_lines l WHERE l.entry_id = e.id AND l.account_id = ?)',
      );
      args.add(accountId);
    }
    final rows = await _db.rawQuery(
      'SELECT e.* FROM acc_entries e ${where.isEmpty ? '' : 'WHERE ${where.join(' AND ')}'} '
      'ORDER BY e.date DESC, e.number DESC LIMIT ? OFFSET ?',
      [...args, limit, offset],
    );
    return [
      for (final r in rows)
        JournalEntry.fromRow(r, await _lines(_db, r['id'] as int)),
    ];
  }

  /// Debit minus credit per postable account, up to [to] (inclusive) and
  /// from [from] when given.
  Future<Map<int, int>> balances({String? from, String? to}) async {
    final where = <String>[];
    final args = <Object?>[];
    if (from != null) {
      where.add('e.date >= ?');
      args.add(from);
    }
    if (to != null) {
      where.add('e.date <= ?');
      args.add(to);
    }
    final rows = await _db.rawQuery(
      'SELECT l.account_id AS a, SUM(l.debit) - SUM(l.credit) AS b '
      'FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id '
      '${where.isEmpty ? '' : 'WHERE ${where.join(' AND ')}'} GROUP BY l.account_id',
      args,
    );
    return {
      for (final r in rows) r['a'] as int: (r['b'] as num?)?.toInt() ?? 0,
    };
  }

  /// Debit minus credit of one account (and its children for a group).
  Future<int> balanceOf(int accountId, {String? to}) async {
    final all = await accounts(archived: true);
    final ids = _descendants(all, accountId);
    final b = await balances(to: to);
    var sum = 0;
    for (final id in ids) {
      sum += b[id] ?? 0;
    }
    return sum;
  }

  /// The lines of [accountId] in date order with the running balance; the
  /// opening balance is the sum before [from].
  Future<({int opening, List<StatementLine> lines})> statement(
    int accountId, {
    String? from,
    String? to,
  }) async {
    var opening = 0;
    if (from != null) {
      final r = await _db.rawQuery(
        'SELECT SUM(l.debit) - SUM(l.credit) AS b FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id '
        'WHERE l.account_id = ? AND e.date < ?',
        [accountId, from],
      );
      opening = (r.first['b'] as num?)?.toInt() ?? 0;
    }
    final where = ['l.account_id = ?'];
    final args = <Object?>[accountId];
    if (from != null) {
      where.add('e.date >= ?');
      args.add(from);
    }
    if (to != null) {
      where.add('e.date <= ?');
      args.add(to);
    }
    final rows = await _db.rawQuery(
      'SELECT e.id, e.number, e.date, e.memo, e.kind, e.reversed_by_id, l.debit, l.credit, l.memo AS lmemo '
      'FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE ${where.join(' AND ')} '
      'ORDER BY e.date, e.number, l.id',
      args,
    );
    var running = opening;
    final out = <StatementLine>[];
    for (final r in rows) {
      final d = r['debit'] as int;
      final c = r['credit'] as int;
      running += d - c;
      out.add(
        StatementLine(
          entryId: r['id'] as int,
          number: r['number'] as int,
          date: r['date'] as String,
          memo: r['memo'] as String,
          kind: r['kind'] as String,
          debit: d,
          credit: c,
          balance: running,
          lineMemo: (r['lmemo'] as String?) ?? '',
          reversed: r['reversed_by_id'] != null,
        ),
      );
    }
    return (opening: opening, lines: out);
  }

  static String _fmt(int cents) {
    final neg = cents < 0;
    final a = cents.abs();
    return '${neg ? '-' : ''}${a ~/ 100}.${(a % 100).toString().padLeft(2, '0')}';
  }
}
