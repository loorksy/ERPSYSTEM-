import '../data/app_database.dart';
import '../erp/normalize.dart';
import '../google/sheets_client.dart';

class ColumnOption {
  const ColumnOption(this.letter, this.header);
  final String letter;
  final String header;
  String get label => header.isEmpty ? letter : '$letter - $header';
}

class SyncOutcome {
  const SyncOutcome(
    this.success,
    this.message, [
    this.detail,
    this.transient = false,
  ]);
  final bool success;
  final String message;
  final String? detail;

  /// Failed only because Google could not be reached; worth retrying.
  final bool transient;
}

/// Port of ERP's cycle routes (`routes/sheet.js`): create, edit, delete,
/// import from Google, sync snapshots, and the column lists.
class CycleService {
  CycleService(this.db, this.sheetsProvider);

  final AppDatabase db;
  final SheetsApi Function() sheetsProvider;

  /// ERP `readSheetFromGoogle`.
  Future<Rows> readSheetFromGoogle(
    String spreadsheetId,
    String? sheetName,
  ) async {
    final r = await fetchSheetWithFallback(
      sheetsProvider(),
      spreadsheetId,
      sheetName == null || sheetName.trim().isEmpty ? null : sheetName.trim(),
    );
    return r.values;
  }

  /// ERP `POST /import-google`. The management sheet is optional since
  /// 3.4.0 (audit without the management sheet): no id = no rows.
  Future<(Rows, Rows)> importFromGoogle({
    required String? managementSpreadsheetId,
    String? managementSheetName,
    required String agentSpreadsheetId,
    String? agentSheetName,
  }) async {
    final mId = managementSpreadsheetId?.trim() ?? '';
    final m =
        mId.isEmpty
            ? const <List<String>>[]
            : await readSheetFromGoogle(mId, managementSheetName);
    final a = await readSheetFromGoogle(
      agentSpreadsheetId.trim(),
      agentSheetName,
    );
    return (m, a);
  }

  /// ERP `POST /cycles`.
  Future<int> createCycle({
    required String name,
    Rows? managementRows,
    Rows? agentRows,
    String? managementSpreadsheetId,
    String? managementSheetName,
    String? agentSpreadsheetId,
    String? agentSheetName,
    double? transferDiscountPct,
    String? userInfoSpreadsheetId,
    String? userInfoSheetName,
  }) async {
    if (name.trim().isEmpty) throw Exception('أدخل اسم الدورة');
    var mRows = managementRows;
    var aRows = agentRows;
    final mSs = _clean(managementSpreadsheetId);
    final aSs = _clean(agentSpreadsheetId);
    if (aSs != null && (aRows == null || (mSs != null && mRows == null))) {
      mRows =
          mSs == null
              ? const <List<String>>[]
              : await readSheetFromGoogle(mSs, managementSheetName);
      aRows = await readSheetFromGoogle(aSs, agentSheetName);
    }
    final tdp = (transferDiscountPct ?? 0).clamp(0, 100).toDouble();
    final id = await db.insertCycle(
      name: name.trim(),
      managementRows: mRows,
      agentRows: aRows,
      managementSpreadsheetId: mSs,
      managementSheetName: managementSheetName,
      agentSpreadsheetId: aSs,
      agentSheetName: agentSheetName,
      transferDiscountPct: tdp,
    );
    final uiSs = _clean(userInfoSpreadsheetId);
    if (uiSs != null) {
      await db.updateCycle(id, {
        'user_info_spreadsheet_id': uiSs,
        'user_info_sheet_name': _clean(userInfoSheetName),
      });
    }
    return id;
  }

  /// ERP `PUT /cycles/:id`.
  Future<void> updateCycle(
    int id, {
    String? name,
    Rows? managementRows,
    Rows? agentRows,
    required String? managementSpreadsheetId,
    required String? managementSheetName,
    required String? agentSpreadsheetId,
    required String? agentSheetName,
    double? transferDiscountPct,
    String? userInfoSpreadsheetId,
    String? userInfoSheetName,
  }) async {
    final existing = await db.getCycleInfo(id);
    if (existing == null) throw Exception('الدورة غير موجودة');
    var mRows = managementRows;
    var aRows = agentRows;
    final mSs = _clean(managementSpreadsheetId);
    final aSs = _clean(agentSpreadsheetId);
    if (aSs != null && (aRows == null || (mSs != null && mRows == null))) {
      mRows =
          mSs == null
              ? const <List<String>>[]
              : await readSheetFromGoogle(mSs, managementSheetName);
      aRows = await readSheetFromGoogle(aSs, agentSheetName);
    }
    await db.updateCycle(id, {
      if (name != null) 'name': name.trim(),
      if (mRows != null) 'management_data': mRows,
      if (aRows != null) 'agent_data': aRows,
      'management_spreadsheet_id': mSs,
      'management_sheet_name': _clean(managementSheetName),
      'agent_spreadsheet_id': aSs,
      'agent_sheet_name': _clean(agentSheetName),
      if (transferDiscountPct != null)
        'transfer_discount_pct': transferDiscountPct.clamp(0, 100).toDouble(),
      if (_clean(userInfoSpreadsheetId) != null) ...{
        'user_info_spreadsheet_id': _clean(userInfoSpreadsheetId),
        'user_info_sheet_name': _clean(userInfoSheetName),
      },
    });
  }

  Future<void> deleteCycle(int id) => db.deleteCycle(id);

  /// ERP `POST /cycles/:id/sync` (management + agent snapshots).
  Future<SyncOutcome> syncCycle(
    int id, {
    String? userInfoSpreadsheetId,
    String? userInfoSheetName,
  }) async {
    try {
      return await _syncCycle(id, userInfoSpreadsheetId, userInfoSheetName);
    } on SheetsApiException catch (e) {
      return SyncOutcome(false, e.message, null, e.transient);
    } catch (e) {
      final m = e.toString();
      return SyncOutcome(false, m.isEmpty ? 'فشلت مزامنة الدورة من Google' : m);
    }
  }

  Future<SyncOutcome> _syncCycle(
    int id,
    String? userInfoSpreadsheetId,
    String? userInfoSheetName,
  ) async {
    final cycle = await db.getCycleInfo(id);
    if (cycle == null) return const SyncOutcome(false, 'الدورة غير موجودة');
    final mgmtSsId = cycle.managementSpreadsheetId;
    final agentSsId = cycle.agentSpreadsheetId;
    if (agentSsId == null) {
      return const SyncOutcome(
        false,
        'هذه الدورة غير مرتبطة بجداول Google. أنشئ دورة جديدة من شاشة الدورات مصدرها Google Sheets ثم احفظها لتفعيل المزامنة.',
      );
    }
    final sheets = sheetsProvider();
    // The management sheet is optional since 3.4.0.
    final mgmt =
        mgmtSsId == null
            ? const SheetFetchResult(<List<String>>[], null)
            : await fetchSheetWithFallback(
              sheets,
              mgmtSsId,
              cycle.managementSheetName,
            );
    final agent = await fetchSheetWithFallback(
      sheets,
      agentSsId,
      cycle.agentSheetName,
      mgmtSsId == agentSsId ? mgmt.sheetTitleUsed : null,
    );

    var userInfoSynced = false;
    var userInfoRowsCount = 0;
    String? userInfoSheetUsed;
    final uiSs = userInfoSpreadsheetId?.trim() ?? '';
    if (uiSs.isNotEmpty) {
      final pref = userInfoSheetName?.trim() ?? '';
      final ui = await fetchSheetWithFallback(
        sheets,
        uiSs,
        pref.isEmpty ? null : pref,
      );
      userInfoRowsCount = ui.values.length;
      userInfoSheetUsed = ui.sheetTitleUsed ?? (pref.isEmpty ? null : pref);
      await db.updateCycle(id, {
        'management_data': mgmt.values,
        'agent_data': agent.values,
        'management_sheet_name':
            mgmt.sheetTitleUsed ?? cycle.managementSheetName,
        'agent_sheet_name': agent.sheetTitleUsed ?? cycle.agentSheetName,
        'user_info_data': ui.values,
        'user_info_spreadsheet_id': uiSs,
        'user_info_sheet_name': userInfoSheetUsed,
      });
      userInfoSynced = true;
    } else {
      await db.updateCycle(id, {
        'management_data': mgmt.values,
        'agent_data': agent.values,
        'management_sheet_name':
            mgmt.sheetTitleUsed ?? cycle.managementSheetName,
        'agent_sheet_name': agent.sheetTitleUsed ?? cycle.agentSheetName,
      });
    }

    var detail = 'الإدارة: ${mgmt.values.length} صف';
    if (mgmt.sheetTitleUsed != null) {
      detail += ' (ورقة "${mgmt.sheetTitleUsed}")';
    }
    detail += '، الوكيل: ${agent.values.length} صف';
    if (agent.sheetTitleUsed != null) {
      detail += ' (ورقة "${agent.sheetTitleUsed}")';
    }
    if (userInfoSynced) {
      detail += '، بيانات المستخدمين: $userInfoRowsCount صف';
      if (userInfoSheetUsed != null) detail += ' (ورقة "$userInfoSheetUsed")';
    }
    return SyncOutcome(
      true,
      userInfoSynced
          ? 'تمت مزامنة جداول الدورة وبيانات المستخدمين من Google'
          : 'تمت مزامنة جداول الدورة من Google',
      detail,
    );
  }

  /// ERP `GET /spreadsheet-columns`: header row of a Google sheet.
  Future<List<ColumnOption>> googleColumns(
    String spreadsheetId,
    String? sheetName,
  ) async {
    final sheets = sheetsProvider();
    final meta = await withSheetsRetry(
      () => sheets.getSpreadsheet(spreadsheetId),
    );
    final title =
        sheetName != null && sheetName.trim().isNotEmpty
            ? sheetName.trim()
            : (meta.sheets.isEmpty ? 'Sheet1' : meta.sheets.first.title);
    if (meta.sheets.isNotEmpty) {
      requireSheet(meta, title, 'جدول بيانات المستخدمين');
    }
    final rows = await withSheetsRetry(
      () => sheets.valuesGet(
        spreadsheetId,
        "'${escapeSheetTitleForRange(title)}'!A1:ZZ1",
      ),
    );
    return columnsFromHeader(rows.isEmpty ? const <String>[] : rows.first);
  }

  static List<ColumnOption> columnsFromHeader(
    List<String> headerRow, {
    int minColumns = 26,
  }) {
    final maxCol =
        headerRow.length > minColumns ? headerRow.length : minColumns;
    return [
      for (var i = 0; i < maxCol; i++)
        ColumnOption(
          columnIndexToLetter(i),
          i < headerRow.length ? headerRow[i].trim() : '',
        ),
    ];
  }

  static String? _clean(String? v) {
    final s = v?.trim();
    return s == null || s.isEmpty ? null : s;
  }
}
