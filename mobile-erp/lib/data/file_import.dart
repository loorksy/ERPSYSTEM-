import 'dart:convert';
import 'dart:typed_data';

import 'package:excel/excel.dart';
import 'package:file_picker/file_picker.dart';

import 'import_service.dart';

/// A spreadsheet file read on the phone (Excel `.xlsx` or CSV).
class ImportedFile {
  ImportedFile(this.fileName, this.sheets);
  final String fileName;

  /// Sheet name → rows (all cells as text), in workbook order.
  final Map<String, List<List<String>>> sheets;

  List<String> get sheetNames => sheets.keys.toList();
  List<List<String>> get firstSheetRows =>
      sheets.isEmpty ? <List<String>>[] : sheets.values.first;

  List<List<String>> rowsOf(String? sheetName) {
    if (sheetName == null || sheetName.isEmpty) return firstSheetRows;
    return sheets[sheetName] ?? firstSheetRows;
  }
}

class FileImportException implements Exception {
  const FileImportException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Lets the user pick a file and parses it like ERP's `/api/sheet/upload`.
Future<ImportedFile?> pickSpreadsheetFile() async {
  final picked = await FilePicker.platform.pickFiles(
    type: FileType.custom,
    allowedExtensions: const ['xlsx', 'csv', 'xls'],
    withData: true,
  );
  if (picked == null || picked.files.isEmpty) return null;
  final file = picked.files.single;
  final bytes = file.bytes;
  if (bytes == null) {
    throw const FileImportException('تعذر قراءة الملف المختار.');
  }
  if (bytes.length > 15 * 1024 * 1024) {
    throw const FileImportException('حجم الملف أكبر من 15 ميغابايت.');
  }
  return parseSpreadsheetBytes(file.name, bytes);
}

ImportedFile parseSpreadsheetBytes(String name, Uint8List bytes) {
  final lower = name.toLowerCase();
  if (lower.endsWith('.csv')) {
    String text;
    try {
      text = utf8.decode(bytes);
    } on FormatException {
      // ERP reads UTF-8 only; Arabic Excel CSVs are often Windows-1256.
      text = ImportService.decodeText(bytes, 'windows-1256');
    }
    return ImportedFile(name, {'CSV': parseCsvLikeErp(text)});
  }
  if (lower.endsWith('.xls')) {
    throw const FileImportException(
      'صيغة xls القديمة غير مدعومة على الهاتف. احفظ الملف بصيغة xlsx أو csv ثم أعد المحاولة.',
    );
  }
  Excel workbook;
  try {
    workbook = Excel.decodeBytes(bytes);
  } catch (_) {
    throw const FileImportException(
      'تعذر قراءة ملف Excel. تأكد أنه بصيغة xlsx.',
    );
  }
  final sheets = <String, List<List<String>>>{};
  for (final name in workbook.tables.keys) {
    final table = workbook.tables[name]!;
    final rows = <List<String>>[];
    for (final row in table.rows) {
      rows.add([for (final cell in row) _cellText(cell?.value)]);
    }
    while (rows.isNotEmpty && rows.last.every((c) => c.isEmpty)) {
      rows.removeLast();
    }
    sheets[name] = rows;
  }
  if (sheets.isEmpty) {
    throw const FileImportException('الملف لا يحتوي أوراقًا.');
  }
  return ImportedFile(name, sheets);
}

String _cellText(CellValue? value) {
  if (value == null) return '';
  return switch (value) {
    TextCellValue() => value.value.toString(),
    IntCellValue() => value.value.toString(),
    DoubleCellValue() => _double(value.value),
    BoolCellValue() => value.value ? 'TRUE' : 'FALSE',
    FormulaCellValue() => value.formula,
    _ => value.toString(),
  };
}

String _double(double v) {
  if (v == v.roundToDouble() && v.abs() < 1e15) return v.toInt().toString();
  return v.toString();
}

/// ERP `parseUploadedFile` for CSV (routes/sheet.js): split lines, drop
/// blank ones, a quote toggles quoting, comma (outside quotes) or tab ends
/// a cell, cells are trimmed.
List<List<String>> parseCsvLikeErp(String text) {
  final rows = <List<String>>[];
  for (final line in text.split(RegExp(r'\r?\n'))) {
    if (line.trim().isEmpty) continue;
    final out = <String>[];
    final cell = StringBuffer();
    var inQuotes = false;
    for (final unit in line.codeUnits) {
      if (unit == 0x22) {
        inQuotes = !inQuotes;
      } else if ((unit == 0x2c && !inQuotes) || unit == 0x09) {
        out.add(cell.toString().trim());
        cell.clear();
      } else {
        cell.writeCharCode(unit);
      }
    }
    out.add(cell.toString().trim());
    rows.add(out);
  }
  return rows;
}
