// In-memory stand-in for the Google Sheets API used by the audit services.
import 'package:lork_erp/erp/normalize.dart';
import 'package:lork_erp/google/sheets_client.dart';

class FakeSheets implements SheetsApi {
  final books = <String, Map<String, List<List<String>>>>{};
  final ids = <String, Map<String, int>>{};
  final colors = <String, Map<int, String>>{}; // "ss|sheetId" -> row -> rgb
  final cellColors =
      <String, Map<int, String>>{}; // "ss|sheetId|col" -> row -> rgb
  final log = <String>[];

  /// When it returns true for an operation, that call fails as if the
  /// internet dropped (used to test resuming).
  bool Function(String op, Object? payload)? failWhen;

  void _maybeFail(String op, Object? payload) {
    if (failWhen?.call(op, payload) ?? false) {
      log.add('NETWORK DOWN $op');
      throw SheetsApiException('no internet', network: true);
    }
  }

  int _next = 100;

  void add(String ss, String title, List<List<String>> rows) {
    books.putIfAbsent(ss, () => {})[title] = rows.map((r) => [...r]).toList();
    ids.putIfAbsent(ss, () => {})[title] = _next++;
  }

  (String, String, int, int?) _range(String range) {
    final m =
        RegExp(
          r"^'((?:[^']|'')*)'!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$",
        ).firstMatch(range)!;
    final title = m.group(1)!.replaceAll("''", "'");
    final col = m.group(2)!;
    final row = m.group(3)!.isEmpty ? 1 : int.parse(m.group(3)!);
    final end =
        m.group(5) == null || m.group(5)!.isEmpty
            ? null
            : int.parse(m.group(5)!);
    return (title, col, row, end);
  }

  @override
  Future<List<SpreadsheetFile>> listSpreadsheets() async => [
    for (final k in books.keys) SpreadsheetFile(k, 'ملف $k'),
  ];

  @override
  Future<SpreadsheetMeta> getSpreadsheet(String id) async {
    log.add('GET meta $id');
    final b = books[id] ?? (throw SheetsApiException('missing', status: 404));
    return SpreadsheetMeta(
      spreadsheetId: id,
      spreadsheetUrl: 'https://x/$id',
      sheets: [
        // Like Google, the grid is a little larger than the data.
        for (final t in b.keys)
          SheetProps(ids[id]![t]!, t, 26, b[t]!.length + 20),
      ],
    );
  }

  @override
  Future<List<List<String>>> valuesGet(String id, String range) async {
    log.add('GET values $id $range');
    final (title, _, row, end) = _range(range);
    final rows =
        books[id]![title] ??
        (throw SheetsApiException('Unable to parse range', status: 400));
    final from = row - 1;
    final to =
        end == null ? rows.length : (end < rows.length ? end : rows.length);
    if (from >= rows.length) return [];
    // Like Google, only the requested columns (e.g. 'Data'!L2:L9).
    final m = RegExp(r"!([A-Z]+)\d*(?::([A-Z]+)\d*)?$").firstMatch(range);
    final c0 = columnLetterToIndex(m?.group(1)) ?? 0;
    final c1 = m?.group(2) == null ? null : columnLetterToIndex(m!.group(2));
    final out = [
      for (final r in rows.sublist(from, to))
        [for (var c = c0; c < r.length && (c1 == null || c <= c1); c++) r[c]],
    ];
    for (final r in out) {
      while (r.isNotEmpty && r.last.isEmpty) {
        r.removeLast();
      }
    }
    while (out.isNotEmpty && out.last.every((c) => c.isEmpty)) {
      out.removeLast();
    }
    return out;
  }

  void _write(
    String id,
    String title,
    int col,
    int row,
    List<List<Object?>> values,
  ) {
    final rows = books[id]![title]!;
    for (var i = 0; i < values.length; i++) {
      while (rows.length < row + i) {
        rows.add([]);
      }
      final r = rows[row - 1 + i];
      for (var j = 0; j < values[i].length; j++) {
        while (r.length <= col + j) {
          r.add('');
        }
        final v = values[i][j];
        r[col + j] =
            v is double && v == v.truncateToDouble()
                ? '${v.toInt()}'
                : '${v ?? ''}';
      }
    }
  }

  @override
  Future<String?> valuesUpdate(
    String id,
    String range,
    List<List<Object?>> values,
  ) async {
    _maybeFail('valuesUpdate', range);
    log.add('UPDATE $id $range (${values.length} rows)');
    final (title, col, row, _) = _range(range);
    _write(id, title, columnLetterToIndex(col)!, row, values);
    return range;
  }

  @override
  Future<String?> valuesAppend(
    String id,
    String range,
    List<List<Object?>> values,
  ) async {
    _maybeFail('valuesAppend', range);
    log.add('APPEND $id $range (${values.length} rows)');
    final (title, _, _, _) = _range(range);
    final rows = books[id]![title]!;
    final start = rows.length + 1;
    _write(id, title, 0, start, values);
    return "'$title'!A$start:ZZ${start + values.length - 1}";
  }

  @override
  Future<List<Map<String, dynamic>>> batchUpdate(
    String id,
    List<Map<String, dynamic>> requests,
  ) async {
    _maybeFail('batchUpdate', requests);
    log.add(
      'BATCH $id ${requests.length} [${requests.map((r) => r.keys.first).toSet().join(',')}]',
    );
    final replies = <Map<String, dynamic>>[];
    for (final r in requests) {
      if (r['addSheet'] != null) {
        final t = r['addSheet']['properties']['title'] as String;
        if (books[id]!.keys.any((k) => k.toLowerCase() == t.toLowerCase())) {
          throw SheetsApiException(
            'A sheet with the name "$t" already exists.',
            status: 400,
          );
        }
        add(id, t, []);
        replies.add({
          'addSheet': {
            'properties': {'sheetId': ids[id]![t], 'title': t},
          },
        });
      } else if (r['repeatCell'] != null &&
          r['repeatCell']['cell']['userEnteredFormat']['backgroundColor'] !=
              null) {
        final range = r['repeatCell']['range'];
        final c =
            r['repeatCell']['cell']['userEnteredFormat']['backgroundColor']
                as Map;
        final hex =
            '#${[c['red'], c['green'], c['blue']].map((v) => ((v as num) * 255).round().toRadixString(16).padLeft(2, '0')).join()}';
        final byRow = colors.putIfAbsent('$id|${range['sheetId']}', () => {});
        for (
          var row = range['startRowIndex'] as int;
          row < (range['endRowIndex'] as int);
          row++
        ) {
          byRow[row] = hex;
        }
        // Per column too, for colours on single columns.
        for (
          var col = (range['startColumnIndex'] as int?) ?? 0;
          col < ((range['endColumnIndex'] as int?) ?? 0);
          col++
        ) {
          final cells = cellColors.putIfAbsent(
            '$id|${range['sheetId']}|$col',
            () => {},
          );
          for (
            var row = range['startRowIndex'] as int;
            row < (range['endRowIndex'] as int);
            row++
          ) {
            cells[row] = hex;
          }
        }
        replies.add({});
      } else if (r['updateCells'] != null &&
          r['updateCells']['fields'] == 'userEnteredValue') {
        // Clears the values of a whole sheet (Apps Script clearContents).
        final sheetId = r['updateCells']['range']['sheetId'];
        final title =
            ids[id]!.entries.firstWhere((e) => e.value == sheetId).key;
        books[id]![title]!.clear();
        replies.add({});
      }
    }
    return replies;
  }

  @override
  Future<void> valuesBatchUpdate(
    String id,
    List<(String range, List<List<Object?>> values)> data,
  ) async {
    _maybeFail('valuesBatchUpdate', data);
    log.add('BATCH VALUES $id ${data.length} ranges');
    for (final (range, values) in data) {
      final (title, col, row, _) = _range(range);
      _write(id, title, columnLetterToIndex(col)!, row, values);
    }
  }

  @override
  Future<String> createSpreadsheet(
    String title,
    List<String> sheetTitles,
  ) async {
    final id = 'new${_next++}';
    log.add('CREATE "$title" -> $id');
    books[id] = {};
    ids[id] = {};
    for (final t in sheetTitles) {
      add(id, t, []);
    }
    return id;
  }

  @override
  Future<List<Map<String, dynamic>?>> columnBackgrounds(
    String spreadsheetId,
    String sheetTitle,
    String column,
    int rowCount,
  ) async {
    log.add('GET colors $spreadsheetId $sheetTitle');
    final byRow =
        colors['$spreadsheetId|${ids[spreadsheetId]![sheetTitle]}'] ?? {};
    return [
      for (var i = 0; i < rowCount; i++)
        byRow[i] == null
            ? {'red': 1, 'green': 1, 'blue': 1}
            : {
              'red': int.parse(byRow[i]!.substring(1, 3), radix: 16) / 255,
              'green': int.parse(byRow[i]!.substring(3, 5), radix: 16) / 255,
              'blue': int.parse(byRow[i]!.substring(5, 7), radix: 16) / 255,
            },
    ];
  }
}
