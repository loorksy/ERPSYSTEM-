import 'dart:typed_data';

import 'package:excel/excel.dart';

import '../services/payroll_service.dart';
import 'app_database.dart';

/// Builds the Excel workbook that holds the same results ERP writes to
/// Google: user-info table with salary/status, colored management and
/// agent sheets, and one sheet per destination name.
class WorkbookExport {
  static Uint8List encode(Cycle cycle, LocalWorkbookState state) {
    final workbook = Excel.createExcel();
    final initial = workbook.getDefaultSheet()!;
    final used = <String>{};

    String name(String raw) {
      final base =
          raw.replaceAll(RegExp(r"[\[\]:*?/\\'\x00-\x1f]"), '_').trim();
      final stem = base.isEmpty ? 'ورقة' : base;
      for (var n = 1; ; n++) {
        final suffix = n == 1 ? '' : ' ($n)';
        final prefix = String.fromCharCodes(
          stem.runes.take(31 - suffix.length),
        );
        final candidate = '$prefix$suffix';
        if (candidate.toLowerCase() != initial.toLowerCase() &&
            used.add(candidate.toLowerCase())) {
          return candidate;
        }
      }
    }

    Sheet sheet(String raw) {
      final s = workbook[name(raw)];
      s.isRTL = true;
      return s;
    }

    final uiName = state.userInfoSheetName;
    final userInfo = sheet(
      uiName == null || uiName.isEmpty || uiName == 'CSV'
          ? 'بيانات المستخدمين'
          : uiName,
    );
    for (final row in state.userInfoRows ?? const <List<Object?>>[]) {
      _append(userInfo, row);
    }
    final mgmt = sheet(cycle.managementSheetName ?? 'الإدارة');
    for (var i = 0; i < cycle.managementRows.length; i++) {
      _append(mgmt, cycle.managementRows[i], state.mgmtColors[i]);
    }
    final agent = sheet(cycle.agentSheetName ?? 'الوكيل');
    for (var i = 0; i < cycle.agentRows.length; i++) {
      _append(agent, cycle.agentRows[i], state.agentColors[i]);
    }
    for (final e in state.targets.entries) {
      final target = sheet(e.key);
      for (final r in e.value) {
        _append(target, r.values, r.color);
      }
    }
    workbook.setDefaultSheet(userInfo.sheetName);
    workbook.delete(initial);
    final bytes = workbook.encode();
    if (bytes == null) throw StateError('تعذر إنشاء ملف Excel.');
    return Uint8List.fromList(bytes);
  }

  static void _append(Sheet sheet, List<Object?> row, [String? color]) {
    final index = sheet.maxRows;
    final cells = <CellValue?>[
      for (final v in row)
        if (v is int)
          IntCellValue(v)
        else if (v is double)
          DoubleCellValue(v)
        else
          TextCellValue(v?.toString() ?? ''),
    ];
    sheet.appendRow(cells.isEmpty ? [TextCellValue('')] : cells);
    if (color == null || color.length != 7) return;
    final style = CellStyle(
      backgroundColorHex: ExcelColor.fromHexString(
        'FF${color.substring(1).toUpperCase()}',
      ),
    );
    for (var i = 0; i < (row.isEmpty ? 1 : row.length); i++) {
      sheet
          .cell(CellIndex.indexByColumnRow(columnIndex: i, rowIndex: index))
          .cellStyle = style;
    }
  }
}
