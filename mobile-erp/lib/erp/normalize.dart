/// Port of `services/payrollSearchService.js` normalization helpers from ERP.
library;

import 'js_compat.dart';

final RegExp _invisible = RegExp(
  '[\u200B-\u200D\u2060\uFEFF\u200E\u200F\u202A-\u202E]',
);
final RegExp _separators = RegExp('[,\u060C\u066C\\s]');
const String _arabicDigits = '٠١٢٣٤٥٦٧٨٩';
const String _persianDigits = '۰۱۲۳۴۵۶۷۸۹';

/// ERP `normalizeForNumber`.
String normalizeForNumber(Object? value) {
  if (value == null) return '';
  var out = value.toString().replaceAll(_invisible, '').trim();
  for (var i = 0; i < 10; i++) {
    out = out
        .replaceAll(_arabicDigits[i], '$i')
        .replaceAll(_persianDigits[i], '$i');
  }
  return out.replaceAll(_separators, '');
}

/// ERP `normalizeUserId`: numeric identifiers are floored, like the server.
String normalizeUserId(Object? value) {
  final s = normalizeForNumber(value);
  if (s.isEmpty) return '';
  final n = jsParseFloat(s);
  if (jsIsFiniteNumber(n)) return jsNumberToString(jsFloor(n));
  return s;
}

/// ERP `columnLetterToIndex`: A → 0 … Z → 25, AA → 26. Invalid → null.
int? columnLetterToIndex(String? letter) {
  if (letter == null || letter.isEmpty) return null;
  final s = letter.trim().toUpperCase();
  var idx = 0;
  for (final unit in s.codeUnits) {
    final c = unit - 65;
    if (c < 0 || c > 25) return null;
    idx = idx * 26 + (c + 1);
  }
  return idx - 1;
}

/// ERP `columnIndexToLetter` / `columnLetter`.
String columnIndexToLetter(int index) {
  var s = '';
  var n = index + 1;
  while (n > 0) {
    final r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - 1) ~/ 26;
  }
  return s.isEmpty ? 'A' : s;
}

/// Reads `row[index]` like JavaScript: missing cells are `null`.
String? cellAt(List<String>? row, int? index) {
  if (row == null || index == null || index < 0 || index >= row.length) {
    return null;
  }
  return row[index];
}
