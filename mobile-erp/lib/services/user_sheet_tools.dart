import 'dart:convert';

import '../data/app_database.dart';
import '../erp/normalize.dart';
import '../google/sheets_client.dart';
import 'adjustments_service.dart';
import 'payroll_service.dart' show mergedColorRequests;

/// Owner's request (2026-11-17): tools on the user-info sheet in the «فرز»
/// section. They only read that sheet and write new / other sheets of the
/// same spreadsheet (sorting) or the salary column (rounding); the audit,
/// the adjustments and the inquiry are not touched.
///
/// - **فرز**: copies every row to a sheet named after its value in a chosen
///   column (E by default); an empty value goes to the «غير مذكور» sheet.
///   Missing sheets are created; rows already in a sheet are not copied
///   again (by user id), so running it twice never duplicates.
/// - **جبر الرواتب**: rounds the salary column (L by default) with one of
///   four standard rounding rules, shows the difference and logs it.

/// The four rounding rules, by their usual (international) names.
enum RoundingMode {
  /// Round down / floor: 12.09 → 12, 19.53 → 19 (the default).
  floor,

  /// Round up / ceiling: 12.09 → 13, 19.53 → 20.
  ceil,

  /// Round half up (to the nearest whole number): 12.49 → 12, 12.5 → 13.
  halfUp,

  /// Banker's rounding (round half to even): 12.5 → 12, 13.5 → 14.
  halfEven;

  String get id => name;

  static RoundingMode of(String? id) => RoundingMode.values.firstWhere(
    (m) => m.name == id,
    orElse: () => RoundingMode.floor,
  );

  /// Arabic name.
  String get label => switch (this) {
    floor => 'جبر للأسفل',
    ceil => 'جبر للأعلى',
    halfUp => 'تقريب لأقرب عدد صحيح',
    halfEven => 'التقريب المصرفي',
  };

  /// The international term.
  String get term => switch (this) {
    floor => 'Round down (Floor)',
    ceil => 'Round up (Ceiling)',
    halfUp => 'Round half up',
    halfEven => "Banker's rounding (half to even)",
  };

  /// Examples shown next to the choice.
  String get example => switch (this) {
    floor => '12.09 ← 12 ، 19.53 ← 19 ، 95.79 ← 95',
    ceil => '12.09 ← 13 ، 19.53 ← 20 ، 95.79 ← 96',
    halfUp => '12.49 ← 12 ، 12.50 ← 13 ، 19.53 ← 20',
    halfEven => '12.50 ← 12 ، 13.50 ← 14 ، 19.53 ← 20',
  };

  /// Rounds [v] to a whole number. A tiny tolerance absorbs binary
  /// fractions (12.5 stored as 12.4999…, 13 stored as 12.9999…).
  double apply(double v) {
    const eps = 1e-9;
    switch (this) {
      case floor:
        return (v + eps).floorToDouble();
      case ceil:
        return (v - eps).ceilToDouble();
      case halfUp:
        return (v + 0.5 + eps).floorToDouble();
      case halfEven:
        final f = (v + eps).floorToDouble();
        final d = v - f;
        if ((d - 0.5).abs() < eps) return f % 2 == 0 ? f : f + 1;
        return d < 0.5 ? f : f + 1;
    }
  }
}

/// One salary changed by the rounding (row is 1-based, as in the sheet).
class RoundingChange {
  const RoundingChange(this.row, this.id, this.before, this.after);
  final int row;
  final String id;
  final double before;
  final double after;
  double get diff => before - after;

  List<Object> toJson() => [row, id, before, after];
  static RoundingChange fromJson(List<dynamic> j) => RoundingChange(
    (j[0] as num).toInt(),
    '${j[1]}',
    (j[2] as num).toDouble(),
    (j[3] as num).toDouble(),
  );
}

/// What a rounding will change (or changed).
class RoundingPlan {
  const RoundingPlan({
    required this.sheetTitle,
    required this.column,
    required this.mode,
    required this.changes,
    required this.salaries,
    required this.totalBefore,
  });
  final String sheetTitle;
  final String column;
  final RoundingMode mode;
  final List<RoundingChange> changes;

  /// Rows with a salary in the column.
  final int salaries;
  final double totalBefore;

  /// The amount removed by the rounding (negative when it adds).
  double get difference =>
      _round2(changes.fold<double>(0, (a, c) => a + c.diff));
  double get totalAfter => _round2(totalBefore - difference);
}

/// One line of «سجل الفروقات».
class RoundingLogEntry {
  const RoundingLogEntry({
    required this.id,
    required this.at,
    required this.spreadsheet,
    required this.sheet,
    required this.column,
    required this.mode,
    required this.count,
    required this.totalBefore,
    required this.totalAfter,
    required this.difference,
  });
  final int id;
  final DateTime at;
  final String spreadsheet;
  final String sheet;
  final String column;
  final RoundingMode mode;
  final int count;
  final double totalBefore;
  final double totalAfter;
  final double difference;

  Map<String, Object> toJson() => {
    'id': id,
    'at': at.toIso8601String(),
    'spreadsheet': spreadsheet,
    'sheet': sheet,
    'column': column,
    'mode': mode.id,
    'count': count,
    'totalBefore': totalBefore,
    'totalAfter': totalAfter,
    'difference': difference,
  };

  static RoundingLogEntry fromJson(Map<String, dynamic> j) => RoundingLogEntry(
    id: (j['id'] as num).toInt(),
    at: DateTime.tryParse('${j['at']}') ?? DateTime.now(),
    spreadsheet: '${j['spreadsheet'] ?? ''}',
    sheet: '${j['sheet'] ?? ''}',
    column: '${j['column'] ?? ''}',
    mode: RoundingMode.of('${j['mode']}'),
    count: (j['count'] as num?)?.toInt() ?? 0,
    totalBefore: (j['totalBefore'] as num?)?.toDouble() ?? 0,
    totalAfter: (j['totalAfter'] as num?)?.toDouble() ?? 0,
    difference: (j['difference'] as num?)?.toDouble() ?? 0,
  );
}

/// One target sheet of a sort.
class SortGroup {
  SortGroup(this.value, this.sheetName, {required this.exists});

  /// The value of the column ('' for an empty one).
  final String value;
  final String sheetName;
  final bool exists;

  /// Data rows (0-based indexes into the read rows, header excluded).
  final rows = <int>[];
}

class SortPlan {
  const SortPlan({
    required this.sheetTitle,
    required this.column,
    required this.header,
    required this.rows,
    required this.groups,
  });
  final String sheetTitle;
  final String column;
  final List<String> header;
  final List<List<String>> rows;
  final List<SortGroup> groups;
  int get rowCount => groups.fold(0, (a, g) => a + g.rows.length);
}

class SortOutcome {
  const SortOutcome({
    required this.created,
    required this.copied,
    required this.skipped,
    this.colored = 0,
  });

  /// Sheets created by this run.
  final List<String> created;

  /// Rows copied per sheet.
  final Map<String, int> copied;

  /// Rows already in their sheet (not copied again).
  final int skipped;

  /// Rows coloured in the sorted sheet.
  final int colored;

  int get total => copied.values.fold(0, (a, b) => a + b);
}

double _round2(double v) => (v * 100).roundToDouble() / 100;

/// A whole amount as an integer (written as 40, not 40.0).
Object _num(double v) =>
    v == v.roundToDouble() && v.abs() < 1e15 ? v.toInt() : v;

/// A salary cell: ERP's locale parsing, plus the Arabic decimal and
/// thousands separators («١٢٫٠٩»، «١٬٢٠٠») that it does not read.
double _salary(String raw) => AdjustmentsService.parseLocaleDecimal(
  raw.replaceAll('\u066B', '.').replaceAll('\u066C', ','),
);

String _clean(String s) =>
    s
        .replaceAll(RegExp('[\u200B-\u200F\u2060\uFEFF\u202A-\u202E]'), '')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();

/// The result of «دمج» before it is written.
class MergePlan {
  const MergePlan({
    required this.sheetTitle,
    required this.resultTitle,
    required this.resultExists,
    required this.header,
    required this.rows,
    required this.sourceRows,
    required this.duplicates,
    this.message,
  });
  final String sheetTitle;

  /// «اسم الورقة_دمج».
  final String resultTitle;
  final bool resultExists;
  final List<Object> header;

  /// One row per name, sorted by name.
  final List<List<Object>> rows;

  /// Data rows read under the header.
  final int sourceRows;

  /// Names found on more than one row, with their row count.
  final Map<String, int> duplicates;

  /// Set when there is nothing to merge (the script's message).
  final String? message;
}

class UserSheetTools {
  UserSheetTools(this.db, this.sheetsProvider);

  final AppDatabase db;
  final SheetsApi Function() sheetsProvider;

  static const roundingModeKey = 'roundingModeV1';
  static const _logKey = 'roundingLogV1';
  static String _detailsKey(int id) => 'rounding/$id';

  // ------------------------------------------------------------ reading

  /// The exact sheet (its title, or the first sheet when empty) and its
  /// rows, without falling back to another sheet.
  Future<(SpreadsheetMeta, String, List<List<String>>)> read(
    String spreadsheetId,
    String sheetName,
  ) async {
    final sheets = sheetsProvider();
    final meta = await withSheetsRetry(
      () => sheets.getSpreadsheet(spreadsheetId),
    );
    if (meta.sheets.isEmpty) throw StateError('لا توجد أوراق في هذا الجدول.');
    final title =
        sheetName.trim().isEmpty
            ? meta.sheets.first.title
            : meta.sheets
                    .where((s) => s.title == sheetName.trim())
                    .map((s) => s.title)
                    .firstOrNull ??
                (throw StateError('الورقة «$sheetName» غير موجودة في الجدول.'));
    final rows = await fetchSheetValuesBatched(
      sheets,
      spreadsheetId,
      title,
      rowCount: sheetRowCount(meta, title),
    );
    return (meta, title, rows);
  }

  static String _cell(List<String> row, int col) =>
      col >= 0 && col < row.length ? row[col] : '';

  // --------------------------------------------------------------- sort

  /// Groups the data rows (row 1 is the header) by the value of [column].
  static SortPlan planSort(
    List<List<String>> rows, {
    required String sheetTitle,
    required String column,
    required String emptyLabel,
    required Iterable<String> existingTitles,
  }) {
    final col = columnLetterToIndex(column) ?? 4;
    final existing = {for (final t in existingTitles) t.toLowerCase(): t};
    final empty = _clean(emptyLabel).isEmpty ? 'غير مذكور' : _clean(emptyLabel);
    final groups = <String, SortGroup>{};
    for (var i = 1; i < rows.length; i++) {
      final row = rows[i];
      if (row.every((c) => c.trim().isEmpty)) continue;
      var value = _clean(_cell(row, col));
      var name = value.isEmpty ? empty : value;
      if (name.length > 100) name = name.substring(0, 100).trim();
      // Never write into the sheet being sorted.
      if (name.toLowerCase() == sheetTitle.toLowerCase()) name = '$name (فرز)';
      if (value.toLowerCase() == empty.toLowerCase()) value = '';
      final key = name.toLowerCase();
      final g = groups.putIfAbsent(
        key,
        () => SortGroup(
          value,
          existing[key] ?? name,
          exists: existing.containsKey(key),
        ),
      );
      g.rows.add(i);
    }
    final list =
        groups.values.toList()..sort((a, b) => b.rows.length - a.rows.length);
    return SortPlan(
      sheetTitle: sheetTitle,
      column: column,
      header: rows.isEmpty ? const [] : rows.first,
      rows: rows,
      groups: list,
    );
  }

  Future<SortPlan> previewSort({
    required String spreadsheetId,
    required String sheetName,
    required String column,
    required String emptyLabel,
  }) async {
    final (meta, title, rows) = await read(spreadsheetId, sheetName);
    return planSort(
      rows,
      sheetTitle: title,
      column: column,
      emptyLabel: emptyLabel,
      existingTitles: [for (final s in meta.sheets) s.title],
    );
  }

  /// Copies each group to its sheet: new sheets get the header row then
  /// the rows; existing sheets get only the rows whose user id ([idColumn])
  /// is not there yet (whole-row match when the id is empty).
  ///
  /// Owner's request: the sorted rows are then coloured with [color] in the
  /// sorted sheet itself (consecutive rows in one range, like the audit).
  Future<SortOutcome> runSort({
    required String spreadsheetId,
    required SortPlan plan,
    required String idColumn,
    String? color,
    void Function(String step, int done, int total)? onProgress,
  }) async {
    final sheets = sheetsProvider();
    final idCol = columnLetterToIndex(idColumn) ?? 2;
    final width = plan.rows.fold<int>(
      plan.header.length,
      (a, r) => r.length > a ? r.length : a,
    );
    // Sheets created since the preview are treated as existing.
    final meta = await withSheetsRetry(
      () => sheets.getSpreadsheet(spreadsheetId),
    );
    final present = {for (final s in meta.sheets) s.title.toLowerCase(): s};
    final toCreate = [
      for (final g in plan.groups)
        if (!present.containsKey(g.sheetName.toLowerCase())) g,
    ];
    final created = <String>[];
    for (var i = 0; i < toCreate.length; i += 40) {
      final part = toCreate.sublist(
        i,
        i + 40 > toCreate.length ? toCreate.length : i + 40,
      );
      await withSheetsRetry(
        () => sheets.batchUpdate(spreadsheetId, [
          for (final g in part)
            {
              'addSheet': {
                'properties': {
                  'title': g.sheetName,
                  'gridProperties': {
                    'rowCount':
                        g.rows.length + 21 > 1000 ? g.rows.length + 21 : 1000,
                    'columnCount': width > 26 ? width : 26,
                  },
                },
              },
            },
        ]),
      );
      created.addAll([for (final g in part) g.sheetName]);
    }
    final copied = <String, int>{};
    var skipped = 0;
    var done = 0;
    for (final g in plan.groups) {
      onProgress?.call(g.sheetName, done, plan.groups.length);
      final esc = escapeSheetTitleForRange(g.sheetName);
      final isNew = created.contains(g.sheetName);
      var rows = [for (final i in g.rows) plan.rows[i]];
      if (!isNew) {
        // Do not copy a row twice (a second run, or rows added by hand).
        final current = await fetchSheetValuesBatched(
          sheets,
          spreadsheetId,
          g.sheetName,
          rowCount: sheetRowCount(meta, g.sheetName),
        );
        final ids = <String>{};
        final whole = <String>{};
        for (final r in current) {
          final id = normalizeUserId(_cell(r, idCol));
          if (id.isNotEmpty) ids.add(id);
          whole.add(r.map((c) => c.trim()).join('\u0001'));
        }
        final keep = <List<String>>[];
        for (final r in rows) {
          final id = normalizeUserId(_cell(r, idCol));
          final dup =
              id.isNotEmpty
                  ? ids.contains(id)
                  : whole.contains(r.map((c) => c.trim()).join('\u0001'));
          if (dup) {
            skipped++;
          } else {
            keep.add(r);
            if (id.isNotEmpty) ids.add(id);
          }
        }
        rows = keep;
      }
      if (isNew) {
        final all = [plan.header, ...rows];
        for (var i = 0; i < all.length; i += 5000) {
          final end = i + 5000 > all.length ? all.length : i + 5000;
          await withSheetsRetry(
            () => sheets.valuesUpdate(
              spreadsheetId,
              "'$esc'!A${i + 1}",
              all.sublist(i, end),
            ),
          );
        }
      } else {
        for (var i = 0; i < rows.length; i += 5000) {
          final end = i + 5000 > rows.length ? rows.length : i + 5000;
          await withSheetsRetry(
            () => sheets.valuesAppend(
              spreadsheetId,
              "'$esc'!A1",
              rows.sublist(i, end),
            ),
          );
        }
      }
      copied[g.sheetName] = rows.length;
      done++;
    }
    var colored = 0;
    final source =
        meta.sheets.where((x) => x.title == plan.sheetTitle).firstOrNull;
    if (color != null && color.isNotEmpty && source != null) {
      onProgress?.call('تلوين «${plan.sheetTitle}»', done, plan.groups.length);
      final byRow = {
        for (final g in plan.groups)
          for (final i in g.rows) i: color,
      };
      final requests = mergedColorRequests(
        source.sheetId,
        byRow,
        source.columnCount ?? (width > 26 ? width : 26),
      );
      for (var i = 0; i < requests.length; i += 500) {
        final part = requests.sublist(
          i,
          i + 500 > requests.length ? requests.length : i + 500,
        );
        await withSheetsRetry(() => sheets.batchUpdate(spreadsheetId, part));
      }
      colored = byRow.length;
    }
    onProgress?.call('', done, plan.groups.length);
    return SortOutcome(
      created: created,
      copied: copied,
      skipped: skipped,
      colored: colored,
    );
  }

  // ----------------------------------------------------------- rounding

  /// The salaries of [column] (row 1 is the header) that [mode] changes.
  /// Empty and non-numeric cells are left alone.
  static RoundingPlan planRounding(
    List<List<String>> rows, {
    required String sheetTitle,
    required String column,
    required String idColumn,
    required RoundingMode mode,
  }) {
    final col = columnLetterToIndex(column) ?? 11;
    final idCol = columnLetterToIndex(idColumn) ?? 2;
    final changes = <RoundingChange>[];
    var salaries = 0;
    var total = 0.0;
    for (var i = 1; i < rows.length; i++) {
      final raw = _cell(rows[i], col).trim();
      if (raw.isEmpty) continue;
      final v = _salary(raw);
      if (v.isNaN) continue;
      salaries++;
      total += v;
      final after = mode.apply(v);
      if (_round2(after) != _round2(v)) {
        changes.add(
          RoundingChange(
            i + 1,
            _cell(rows[i], idCol).trim(),
            _round2(v),
            after,
          ),
        );
      }
    }
    return RoundingPlan(
      sheetTitle: sheetTitle,
      column: column,
      mode: mode,
      changes: changes,
      salaries: salaries,
      totalBefore: _round2(total),
    );
  }

  Future<RoundingPlan> previewRounding({
    required String spreadsheetId,
    required String sheetName,
    required String column,
    required String idColumn,
    required RoundingMode mode,
  }) async {
    final (_, title, rows) = await read(spreadsheetId, sheetName);
    return planRounding(
      rows,
      sheetTitle: title,
      column: column,
      idColumn: idColumn,
      mode: mode,
    );
  }

  /// Writes the rounded salaries of [plan], after checking that none of
  /// them changed in the sheet since the preview; then logs the operation.
  Future<RoundingLogEntry> applyRounding({
    required String spreadsheetId,
    required String spreadsheetName,
    required RoundingPlan plan,
  }) async {
    final sheets = sheetsProvider();
    final (_, title, rows) = await read(spreadsheetId, plan.sheetTitle);
    final col = columnLetterToIndex(plan.column) ?? 11;
    for (final c in plan.changes) {
      final i = c.row - 1;
      final now = i < rows.length ? _salary(_cell(rows[i], col)) : double.nan;
      if (now.isNaN || _round2(now) != c.before) {
        throw StateError(
          'تغيّرت الرواتب في الورقة منذ المعاينة (الصف ${c.row}). أعد المحاولة.',
        );
      }
    }
    // Consecutive rows in one range, several ranges per request.
    final esc = escapeSheetTitleForRange(title);
    final data = <(String, List<List<Object?>>)>[];
    var i = 0;
    while (i < plan.changes.length) {
      var j = i;
      while (j + 1 < plan.changes.length &&
          plan.changes[j + 1].row == plan.changes[j].row + 1) {
        j++;
      }
      final first = plan.changes[i].row;
      final last = plan.changes[j].row;
      data.add((
        "'$esc'!${plan.column}$first:${plan.column}$last",
        [
          for (var k = i; k <= j; k++) [plan.changes[k].after.toInt()],
        ],
      ));
      i = j + 1;
    }
    for (var k = 0; k < data.length; k += 400) {
      final part = data.sublist(
        k,
        k + 400 > data.length ? data.length : k + 400,
      );
      await withSheetsRetry(
        () => sheets.valuesBatchUpdate(spreadsheetId, part),
      );
    }
    final entry = RoundingLogEntry(
      id: DateTime.now().microsecondsSinceEpoch,
      at: DateTime.now(),
      spreadsheet: spreadsheetName,
      sheet: title,
      column: plan.column,
      mode: plan.mode,
      count: plan.changes.length,
      totalBefore: plan.totalBefore,
      totalAfter: plan.totalAfter,
      difference: plan.difference,
    );
    await _addLog(entry, plan.changes);
    return entry;
  }

  // -------------------------------------------------------------- merge

  /// The owner's Apps Script `mergeSalaries` (أداة دمج الرواتب): rows with
  /// the same name (trimmed) become one row; their salaries are added up;
  /// in the other columns an empty cell takes the new value and a different
  /// value is joined with « / » (once). Rows without a name, or whose salary
  /// is not a number, are left out. Names are sorted like JavaScript's
  /// `sort()`.
  static MergePlan planMerge(
    List<List<String>> rows, {
    required String sheetTitle,
    required int headerRow,
    required String nameColumn,
    required String salaryColumn,
    required Iterable<String> existingTitles,
  }) {
    final resultTitle = '${sheetTitle}_دمج';
    final exists = existingTitles.any(
      (t) => t.toLowerCase() == resultTitle.toLowerCase(),
    );
    // `getLastColumn()`: the widest row of the sheet.
    final lastCol = rows.fold<int>(0, (a, r) => r.length > a ? r.length : a);
    List<Object> padded(List<String> r) => [
      for (var j = 0; j < lastCol; j++) j < r.length ? r[j] : '',
    ];
    final header =
        headerRow - 1 < rows.length ? padded(rows[headerRow - 1]) : <Object>[];
    if (rows.length <= headerRow) {
      return MergePlan(
        sheetTitle: sheetTitle,
        resultTitle: resultTitle,
        resultExists: exists,
        header: header,
        rows: const [],
        sourceRows: 0,
        duplicates: const {},
        message: 'لا توجد بيانات بعد صف العناوين.',
      );
    }
    final nameCol = (columnLetterToIndex(nameColumn) ?? 0);
    final salaryCol = (columnLetterToIndex(salaryColumn) ?? 11);
    final merged = <String, List<Object>>{};
    final totals = <String, double>{};
    final counts = <String, int>{};
    for (var i = headerRow; i < rows.length; i++) {
      final row = padded(rows[i]);
      final name = nameCol < lastCol ? '${row[nameCol]}'.trim() : '';
      if (name.isEmpty) continue;
      final rawSalary = salaryCol < lastCol ? '${row[salaryCol]}' : '';
      // `Number(x)`: an empty cell counts as 0, text is not a number.
      final salary = rawSalary.trim().isEmpty ? 0.0 : _salary(rawSalary);
      if (salary.isNaN) continue;
      counts[name] = (counts[name] ?? 0) + 1;
      final stored = merged[name];
      if (stored == null) {
        final copy = [...row];
        if (salaryCol < lastCol) copy[salaryCol] = _num(salary);
        merged[name] = copy;
        totals[name] = salary;
        continue;
      }
      final total = totals[name]! + salary;
      totals[name] = total;
      if (salaryCol < lastCol) stored[salaryCol] = _num(total);
      for (var j = 0; j < lastCol; j++) {
        if (j == salaryCol) continue;
        final oldVal = stored[j];
        final newVal = row[j];
        if (newVal == '') continue;
        if (oldVal == '') {
          stored[j] = newVal;
          continue;
        }
        final oldStr = '$oldVal'.trim();
        final newStr = '$newVal'.trim();
        if (oldStr.isEmpty) {
          stored[j] = newStr;
        } else if (oldStr != newStr) {
          final parts = [for (final p in oldStr.split(' / ')) p.trim()];
          if (!parts.contains(newStr)) stored[j] = '$oldStr / $newStr';
        }
      }
    }
    final names = merged.keys.toList()..sort();
    return MergePlan(
      sheetTitle: sheetTitle,
      resultTitle: resultTitle,
      resultExists: exists,
      header: header,
      rows: [for (final n in names) merged[n]!],
      sourceRows: rows.length - headerRow,
      duplicates: {
        for (final e in counts.entries)
          if (e.value > 1) e.key: e.value,
      },
    );
  }

  Future<MergePlan> previewMerge({
    required String spreadsheetId,
    required String sheetName,
    required int headerRow,
    required String nameColumn,
    required String salaryColumn,
  }) async {
    final (meta, title, rows) = await read(spreadsheetId, sheetName);
    return planMerge(
      rows,
      sheetTitle: title,
      headerRow: headerRow < 1 ? 1 : headerRow,
      nameColumn: nameColumn,
      salaryColumn: salaryColumn,
      existingTitles: [for (final s in meta.sheets) s.title],
    );
  }

  /// Writes the merge into «اسم الورقة_دمج» (created, or its contents cleared
  /// like `clearContents()`): the header row, then one row per name.
  Future<String> runMerge({
    required String spreadsheetId,
    required MergePlan plan,
  }) async {
    if (plan.message != null) return plan.message!;
    final sheets = sheetsProvider();
    final meta = await withSheetsRetry(
      () => sheets.getSpreadsheet(spreadsheetId),
    );
    final existing =
        meta.sheets
            .where(
              (s) => s.title.toLowerCase() == plan.resultTitle.toLowerCase(),
            )
            .firstOrNull;
    final width = plan.header.length > 26 ? plan.header.length : 26;
    if (existing == null) {
      await withSheetsRetry(
        () => sheets.batchUpdate(spreadsheetId, [
          {
            'addSheet': {
              'properties': {
                'title': plan.resultTitle,
                'gridProperties': {
                  'rowCount':
                      plan.rows.length + 21 > 1000
                          ? plan.rows.length + 21
                          : 1000,
                  'columnCount': width,
                },
              },
            },
          },
        ]),
      );
    } else {
      await withSheetsRetry(
        () => sheets.batchUpdate(spreadsheetId, [
          {
            'updateCells': {
              'range': {'sheetId': existing.sheetId},
              'fields': 'userEnteredValue',
            },
          },
          if ((existing.rowCount ?? 0) < plan.rows.length + 1)
            {
              'appendDimension': {
                'sheetId': existing.sheetId,
                'dimension': 'ROWS',
                'length': plan.rows.length + 1 - (existing.rowCount ?? 0),
              },
            },
        ]),
      );
    }
    final title = existing?.title ?? plan.resultTitle;
    final esc = escapeSheetTitleForRange(title);
    final all = <List<Object?>>[plan.header, ...plan.rows];
    for (var i = 0; i < all.length; i += 5000) {
      final end = i + 5000 > all.length ? all.length : i + 5000;
      await withSheetsRetry(
        () => sheets.valuesUpdate(
          spreadsheetId,
          "'$esc'!A${i + 1}",
          all.sublist(i, end),
        ),
      );
    }
    return 'تم الدمج بنجاح. تم إنشاء ورقة: $title بعدد أسماء: ${plan.rows.length}';
  }

  // -------------------------------------------------------------- log

  Future<List<RoundingLogEntry>> log() async {
    final raw = await db.getValue(_logKey);
    if (raw == null) return const [];
    try {
      return [
        for (final e in jsonDecode(raw) as List)
          RoundingLogEntry.fromJson(Map<String, dynamic>.from(e as Map)),
      ];
    } catch (_) {
      return const [];
    }
  }

  Future<void> _addLog(
    RoundingLogEntry entry,
    List<RoundingChange> changes,
  ) async {
    final list = [entry, ...await log()];
    // Keep the last 200 operations.
    for (final old in list.skip(200)) {
      await db.putBlob(_detailsKey(old.id), null);
    }
    await db.putBlob(
      _detailsKey(entry.id),
      jsonEncode([for (final c in changes) c.toJson()]),
    );
    await db.setValue(
      _logKey,
      jsonEncode([for (final e in list.take(200)) e.toJson()]),
    );
  }

  Future<List<RoundingChange>> logDetails(int id) async {
    final raw = await db.getBlob(_detailsKey(id));
    if (raw == null) return const [];
    return [
      for (final c in jsonDecode(raw) as List)
        RoundingChange.fromJson(c as List<dynamic>),
    ];
  }

  // ---------------------------------------------------------- settings

  Future<RoundingMode> defaultMode() async =>
      RoundingMode.of(await db.getValue(roundingModeKey));

  Future<void> setDefaultMode(RoundingMode m) =>
      db.setValue(roundingModeKey, m.id);
}
