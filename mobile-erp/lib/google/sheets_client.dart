import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'google_auth.dart';

class SheetsApiException implements Exception {
  SheetsApiException(
    this.message, {
    this.status,
    this.reason,
    this.network = false,
  });
  final String message;
  final int? status;
  final String? reason;

  /// No answer from Google (no internet, DNS, timeout, connection reset).
  final bool network;

  /// Worth retrying later: lost connection, Google server errors and
  /// rate limits that outlasted [withSheetsRetry].
  bool get transient =>
      network || isRateLimit || (status != null && status! >= 500);

  bool get isRateLimit =>
      status == 429 ||
      reason == 'rateLimitExceeded' ||
      reason == 'userRateLimitExceeded' ||
      RegExp('quota exceeded|429', caseSensitive: false).hasMatch(message);

  @override
  String toString() => message;
}

class SpreadsheetFile {
  const SpreadsheetFile(this.id, this.name);
  final String id;
  final String name;
}

class SheetProps {
  const SheetProps(this.sheetId, this.title, [this.columnCount, this.rowCount]);
  final int sheetId;
  final String title;

  /// Number of columns in the sheet grid (null when unknown).
  final int? columnCount;

  /// Number of rows in the sheet grid (null when unknown).
  final int? rowCount;
}

class SpreadsheetMeta {
  const SpreadsheetMeta({
    required this.spreadsheetId,
    required this.spreadsheetUrl,
    required this.sheets,
    this.title,
  });
  final String spreadsheetId;
  final String? title;
  final String? spreadsheetUrl;
  final List<SheetProps> sheets;

  String get url =>
      spreadsheetUrl ??
      'https://docs.google.com/spreadsheets/d/$spreadsheetId/edit';
}

/// The subset of the Google Sheets / Drive APIs used by ERP's audit.
abstract class SheetsApi {
  Future<List<SpreadsheetFile>> listSpreadsheets();
  Future<SpreadsheetMeta> getSpreadsheet(String spreadsheetId);
  Future<List<List<String>>> valuesGet(String spreadsheetId, String range);
  Future<String?> valuesUpdate(
    String spreadsheetId,
    String range,
    List<List<Object?>> values,
  );
  Future<String?> valuesAppend(
    String spreadsheetId,
    String range,
    List<List<Object?>> values,
  );
  Future<List<Map<String, dynamic>>> batchUpdate(
    String spreadsheetId,
    List<Map<String, dynamic>> requests,
  );

  /// `values:batchUpdate` (USER_ENTERED): several ranges in one request.
  Future<void> valuesBatchUpdate(
    String spreadsheetId,
    List<(String range, List<List<Object?>> values)> data,
  );
  Future<String> createSpreadsheet(String title, List<String> sheetTitles);

  /// Background colour of each cell in [column] for rows 1..[rowCount]
  /// (index 0 = row 1); null where Google reports no colour.
  Future<List<Map<String, dynamic>?>> columnBackgrounds(
    String spreadsheetId,
    String sheetTitle,
    String column,
    int rowCount,
  );
}

/// A background that is not plain white (ERP colours audited rows).
bool isColoredBackground(Map<String, dynamic>? c) {
  if (c == null) return false;
  double v(String k) => (c[k] as num?)?.toDouble() ?? 0;
  return !(v('red') >= 0.999 && v('green') >= 0.999 && v('blue') >= 0.999);
}

/// REST implementation over the phone's Google access token.
class GoogleSheetsApi implements SheetsApi {
  GoogleSheetsApi(this.auth, {http.Client? client})
    : _client = client ?? http.Client();

  final GoogleAuth auth;
  final http.Client _client;

  Future<Map<String, dynamic>> _send(
    String method,
    Uri uri, {
    Object? body,
    bool retried = false,
  }) async {
    final token = await auth.accessToken(forceRefresh: retried);
    final headers = <String, String>{
      'Authorization': 'Bearer $token',
      'Content-Type': 'application/json; charset=utf-8',
    };
    http.Response response;
    try {
      final req = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) req.body = jsonEncode(body);
      final streamed = await _client
          .send(req)
          .timeout(const Duration(seconds: 120));
      response = await http.Response.fromStream(
        streamed,
      ).timeout(const Duration(seconds: 120));
    } on TimeoutException {
      throw SheetsApiException(
        'انقطع الاتصال بـ Google (انتهت المهلة).',
        network: true,
      );
    } on Exception catch (e) {
      throw SheetsApiException(
        'لا يوجد اتصال بالإنترنت أو تعذر الوصول إلى Google.',
        network: true,
        reason: e.toString(),
      );
    }
    if (response.statusCode == 401 && !retried) {
      return _send(method, uri, body: body, retried: true);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      String message = 'رفض Google الطلب (${response.statusCode})';
      String? reason;
      try {
        final decoded = jsonDecode(utf8.decode(response.bodyBytes));
        final err = decoded is Map ? decoded['error'] : null;
        if (err is Map) {
          if (err['message'] is String) message = err['message'] as String;
          final errors = err['errors'];
          if (errors is List && errors.isNotEmpty && errors.first is Map) {
            reason = (errors.first as Map)['reason']?.toString();
          }
        }
      } catch (_) {}
      if (response.statusCode == 401) {
        message = 'انتهى تفويض Google. أعد ربط الحساب من الإعدادات.';
      } else if (reason == 'accessNotConfigured' ||
          message.contains('has not been used') ||
          message.contains('is disabled')) {
        final api =
            uri.host.startsWith('sheets')
                ? 'Google Sheets API'
                : 'Google Drive API';
        message =
            '$api غير مفعّلة في مشروع Google Cloud الخاص بالتطبيق. فعّلها من console.cloud.google.com ← APIs & Services ← Library ثم أعد المحاولة بعد دقائق.';
      } else if (response.statusCode == 403) {
        message =
            'لا يملك حساب Google صلاحية الوصول إلى هذا الملف أو تعديله. ($message)';
      } else if (response.statusCode == 404) {
        message =
            'الملف أو الورقة غير موجودة في Google، أو ليست مشاركة مع الحساب المتصل.';
      }
      throw SheetsApiException(
        message,
        status: response.statusCode,
        reason: reason,
      );
    }
    if (response.bodyBytes.isEmpty) return <String, dynamic>{};
    final decoded = jsonDecode(utf8.decode(response.bodyBytes));
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  /// [path] must already be percent-encoded (ids and A1 ranges go through
  /// `Uri.encodeComponent`); `Uri.https` would encode the `%` a second time.
  static Uri _sheets(String path, [Map<String, String>? query]) {
    final uri = Uri.parse('https://sheets.googleapis.com/v4/spreadsheets$path');
    return query == null ? uri : uri.replace(queryParameters: query);
  }

  @override
  Future<List<SpreadsheetFile>> listSpreadsheets() async {
    final json = await _send(
      'GET',
      Uri.https('www.googleapis.com', '/drive/v3/files', {
        'q':
            "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
        'pageSize': '200',
        'fields': 'files(id, name)',
        'orderBy': 'modifiedTime desc',
      }),
    );
    return [
      for (final f in (json['files'] as List? ?? const []))
        SpreadsheetFile(
          (f as Map)['id'].toString(),
          (f['name'] ?? f['id']).toString(),
        ),
    ];
  }

  @override
  Future<SpreadsheetMeta> getSpreadsheet(String spreadsheetId) async {
    final json = await _send(
      'GET',
      _sheets('/${Uri.encodeComponent(spreadsheetId)}', {
        'fields':
            'spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title,gridProperties(columnCount,rowCount)))',
      }),
    );
    return SpreadsheetMeta(
      spreadsheetId: (json['spreadsheetId'] ?? spreadsheetId).toString(),
      spreadsheetUrl: json['spreadsheetUrl'] as String?,
      title: (json['properties'] as Map?)?['title'] as String?,
      sheets: [
        for (final s in (json['sheets'] as List? ?? const []))
          SheetProps(
            ((s as Map)['properties']['sheetId'] as num).toInt(),
            (s['properties']['title'] ?? '').toString(),
            ((s['properties']['gridProperties'] as Map?)?['columnCount']
                    as num?)
                ?.toInt(),
            ((s['properties']['gridProperties'] as Map?)?['rowCount'] as num?)
                ?.toInt(),
          ),
      ],
    );
  }

  @override
  Future<List<List<String>>> valuesGet(
    String spreadsheetId,
    String range,
  ) async {
    final json = await _send(
      'GET',
      _sheets(
        '/${Uri.encodeComponent(spreadsheetId)}/values/${Uri.encodeComponent(range)}',
      ),
    );
    return [
      for (final row in (json['values'] as List? ?? const []))
        [for (final cell in (row as List)) cell == null ? '' : cell.toString()],
    ];
  }

  @override
  Future<String?> valuesUpdate(
    String spreadsheetId,
    String range,
    List<List<Object?>> values,
  ) async {
    final json = await _send(
      'PUT',
      _sheets(
        '/${Uri.encodeComponent(spreadsheetId)}/values/${Uri.encodeComponent(range)}',
        {'valueInputOption': 'USER_ENTERED'},
      ),
      body: {'range': range, 'majorDimension': 'ROWS', 'values': values},
    );
    return json['updatedRange'] as String?;
  }

  @override
  Future<String?> valuesAppend(
    String spreadsheetId,
    String range,
    List<List<Object?>> values,
  ) async {
    final json = await _send(
      'POST',
      _sheets(
        '/${Uri.encodeComponent(spreadsheetId)}/values/${Uri.encodeComponent(range)}:append',
        {'valueInputOption': 'USER_ENTERED', 'insertDataOption': 'INSERT_ROWS'},
      ),
      body: {'majorDimension': 'ROWS', 'values': values},
    );
    final updates = json['updates'];
    return updates is Map ? updates['updatedRange'] as String? : null;
  }

  @override
  Future<List<Map<String, dynamic>>> batchUpdate(
    String spreadsheetId,
    List<Map<String, dynamic>> requests,
  ) async {
    final json = await _send(
      'POST',
      _sheets('/${Uri.encodeComponent(spreadsheetId)}:batchUpdate'),
      body: {'requests': requests},
    );
    return [
      for (final r in (json['replies'] as List? ?? const []))
        Map<String, dynamic>.from(r as Map),
    ];
  }

  @override
  Future<void> valuesBatchUpdate(
    String spreadsheetId,
    List<(String range, List<List<Object?>> values)> data,
  ) async {
    if (data.isEmpty) return;
    await _send(
      'POST',
      _sheets('/${Uri.encodeComponent(spreadsheetId)}/values:batchUpdate'),
      body: {
        'valueInputOption': 'USER_ENTERED',
        'data': [
          for (final (range, values) in data)
            {'range': range, 'majorDimension': 'ROWS', 'values': values},
        ],
      },
    );
  }

  @override
  Future<List<Map<String, dynamic>?>> columnBackgrounds(
    String spreadsheetId,
    String sheetTitle,
    String column,
    int rowCount,
  ) async {
    if (rowCount <= 0) return const [];
    final range =
        "'${escapeSheetTitleForRange(sheetTitle)}'!${column}1:$column$rowCount";
    final json = await _send(
      'GET',
      _sheets('/${Uri.encodeComponent(spreadsheetId)}', {
        'ranges': range,
        'fields':
            'sheets(data(startRow,rowData(values(effectiveFormat(backgroundColor)))))',
      }),
    );
    final out = List<Map<String, dynamic>?>.filled(rowCount, null);
    for (final sheet in (json['sheets'] as List? ?? const [])) {
      for (final block in ((sheet as Map)['data'] as List? ?? const [])) {
        final start = ((block as Map)['startRow'] as num?)?.toInt() ?? 0;
        final rows = block['rowData'] as List? ?? const [];
        for (var i = 0; i < rows.length && start + i < rowCount; i++) {
          final values = (rows[i] as Map)['values'] as List?;
          if (values == null || values.isEmpty) continue;
          final fmt = (values.first as Map)['effectiveFormat'] as Map?;
          final bg = fmt?['backgroundColor'];
          if (bg is Map) out[start + i] = Map<String, dynamic>.from(bg);
        }
      }
    }
    return out;
  }

  @override
  Future<String> createSpreadsheet(
    String title,
    List<String> sheetTitles,
  ) async {
    final json = await _send(
      'POST',
      _sheets(''),
      body: {
        'properties': {'title': title},
        'sheets': [
          for (final t in sheetTitles)
            {
              'properties': {'title': t},
            },
        ],
      },
    );
    final id = json['spreadsheetId'] as String?;
    if (id == null || id.isEmpty) {
      throw SheetsApiException('فشل إنشاء جدول الدورة في Google');
    }
    return id;
  }
}

// ---------------------------------------------------------------------------
// Port of services/googleSheetsReadHelpers.js
// ---------------------------------------------------------------------------

const int sheetBatchRows = 5000;

Future<void> sleepMs(int ms) =>
    Future<void>.delayed(Duration(milliseconds: ms));

final Random _jitter = Random();

/// ERP `withSheetsRetry`: retries only on rate limiting (429).
Future<T> withSheetsRetry<T>(
  Future<T> Function() fn, {
  int maxAttempts = 12,
  void Function(String message)? onWait,
}) async {
  Object? lastErr;
  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } on SheetsApiException catch (e) {
      lastErr = e;
      if (e.isRateLimit) {
        final backoffSec = min(120, max(5, 4 * pow(2, attempt).toInt()));
        final waitMs = backoffSec * 1000 + _jitter.nextInt(500);
        onWait?.call(
          'حد طلبات Google — انتظار ${(waitMs / 1000).round()} ثانية ثم إعادة المحاولة (${attempt + 1}/$maxAttempts)',
        );
        await sleepMs(waitMs);
        continue;
      }
      rethrow;
    }
  }
  throw lastErr ?? SheetsApiException('فشل طلب Google');
}

String escapeSheetTitleForRange(String title) => title.replaceAll("'", "''");

String rangeA1ZZ(String title, int startRow, int endRow) =>
    "'${escapeSheetTitleForRange(title)}'!A$startRow:ZZ$endRow";

String rangeWholeSheet(String title) =>
    "'${escapeSheetTitleForRange(title)}'!A:ZZ";

/// ERP `fetchSheetValuesBatched`, without ERP's 150,000-row cap (the
/// owner asked for no row limit).
///
/// Bug fix: Google drops empty rows at the end of each range, so ERP
/// stopped at the first short batch and missed every row after a gap of
/// empty rows on a batch boundary. With the sheet's [rowCount] every batch
/// up to the end of the grid is read, and rows keep their positions.
Future<List<List<String>>> fetchSheetValuesBatched(
  SheetsApi sheets,
  String spreadsheetId,
  String title, {
  int startRow = 1,
  int? rowCount,
}) async {
  final all = <List<String>>[];
  var row = startRow;
  for (;;) {
    if (rowCount != null && row > rowCount) break;
    final endRow = row + sheetBatchRows - 1;
    final batch = await withSheetsRetry(
      () => sheets.valuesGet(spreadsheetId, rangeA1ZZ(title, row, endRow)),
    );
    if (rowCount == null) {
      if (batch.isEmpty) break;
      all.addAll(batch);
      if (batch.length < sheetBatchRows) break;
    } else if (batch.isNotEmpty) {
      // Keep positions: pad the empty rows skipped since the last batch.
      while (all.length < row - startRow) {
        all.add(<String>[]);
      }
      all.addAll(batch);
    }
    row = endRow + 1;
  }
  return all;
}

/// Row count of [title] in [meta], when Google reported it.
/// Stops with a clear message when a chosen sheet is not in the
/// spreadsheet (renamed or deleted after it was chosen); Google itself
/// only answers «Unable to parse range».
void requireSheet(SpreadsheetMeta meta, String title, String what) {
  if (meta.sheets.any((s) => s.title == title)) return;
  final names = [for (final s in meta.sheets) '«${s.title}»'].join('، ');
  throw SheetsApiException(
    'الورقة «$title» غير موجودة في $what${meta.title == null ? '' : ' «${meta.title}»'}؛ ربما حُذفت أو تغيّر اسمها. الأوراق الموجودة: $names. اختر الورقة من جديد.',
    status: 400,
  );
}

int? sheetRowCount(SpreadsheetMeta meta, String title) {
  for (final s in meta.sheets) {
    if (s.title == title) return s.rowCount;
  }
  return null;
}

class SheetFetchResult {
  const SheetFetchResult(this.values, this.sheetTitleUsed);
  final List<List<String>> values;
  final String? sheetTitleUsed;
}

/// ERP `fetchSheetWithFallback`.
Future<SheetFetchResult> fetchSheetWithFallback(
  SheetsApi sheets,
  String spreadsheetId,
  String? preferredSheetName, [
  String? excludeSheetTitle,
]) async {
  final meta = await withSheetsRetry(
    () => sheets.getSpreadsheet(spreadsheetId),
  );
  final titles = [
    for (final s in meta.sheets)
      if (s.title.isNotEmpty) s.title,
  ];
  if (titles.isEmpty) return const SheetFetchResult([], null);

  final preferred = preferredSheetName?.trim();
  final exclude = excludeSheetTitle?.trim();
  final toTry = <String>[];
  if (preferred != null && preferred.isNotEmpty && preferred != exclude) {
    toTry.add(preferred);
  }
  for (final t in titles) {
    if (t != exclude && !toTry.contains(t)) toTry.add(t);
  }
  if (toTry.isEmpty) toTry.add(titles.first);

  var best = const SheetFetchResult([], null);
  for (final title in toTry) {
    try {
      final values = await fetchSheetValuesBatched(
        sheets,
        spreadsheetId,
        title,
        rowCount: sheetRowCount(meta, title),
      );
      if (values.length > best.values.length) {
        best = SheetFetchResult(values, title);
      }
      if (values.isNotEmpty &&
          preferred != null &&
          preferred.isNotEmpty &&
          title == preferred) {
        return SheetFetchResult(values, title);
      }
    } catch (_) {
      // try next sheet
    }
  }
  if (best.values.isNotEmpty) return best;
  try {
    final values = await fetchSheetValuesBatched(
      sheets,
      spreadsheetId,
      toTry.first,
      rowCount: sheetRowCount(meta, toTry.first),
    );
    return SheetFetchResult(values, toTry.first);
  } catch (_) {}
  return SheetFetchResult(const [], toTry.first);
}

/// ERP `batchUpdateRequestsInChunks` (defaults: 8 requests, 1.5 s apart).
Future<void> batchUpdateRequestsInChunks(
  SheetsApi sheets,
  String spreadsheetId,
  List<Map<String, dynamic>> requests, {
  int chunkSize = 8,
  int delayMs = 1500,
  void Function(int done, int total)? onProgress,
}) async {
  if (requests.isEmpty) return;
  for (var i = 0; i < requests.length; i += chunkSize) {
    final chunk = requests.sublist(i, min(i + chunkSize, requests.length));
    await withSheetsRetry(() => sheets.batchUpdate(spreadsheetId, chunk));
    onProgress?.call(min(i + chunkSize, requests.length), requests.length);
    if (i + chunkSize < requests.length && delayMs > 0) await sleepMs(delayMs);
  }
}

/// Last column (exclusive) to color: ERP uses 200, limited to the grid so a
/// narrow sheet does not reject the range.
int colorEndColumn(SpreadsheetMeta meta, int sheetId, [int minimum = 1]) {
  for (final s in meta.sheets) {
    if (s.sheetId == sheetId && s.columnCount != null) {
      final c = s.columnCount! < minimum ? minimum : s.columnCount!;
      return c > 200 ? 200 : c;
    }
  }
  return 200;
}

/// ERP `getSheetIdByTitle`.
int? getSheetIdByTitle(SpreadsheetMeta meta, String? title) {
  if (meta.sheets.isEmpty) return null;
  final t = title?.trim();
  if (t != null && t.isNotEmpty) {
    for (final s in meta.sheets) {
      if (s.title == t) return s.sheetId;
    }
    return null;
  }
  return meta.sheets.first.sheetId;
}

/// ERP `parseRangeStartRowIndex0`: `'Sheet'!A7:ZZ9` → 6.
int parseRangeStartRowIndex0(String? updatedRange) {
  final m = RegExp(r'![A-Za-z]+(\d+)').firstMatch(updatedRange ?? '');
  if (m == null) return 0;
  return max(0, int.parse(m.group(1)!) - 1);
}

String googleSheetUrl(String spreadsheetId) =>
    'https://docs.google.com/spreadsheets/d/$spreadsheetId/edit';
