import 'dart:async';

import '../data/app_database.dart';
import '../erp/normalize.dart';
import '../google/sheets_client.dart';

/// Port of ERP `services/cycleSyncWorker.js`: while enabled (ERP
/// `google_sheets_config.sync_enabled`, off by default) every Google-linked
/// cycle whose search cache is stale is re-read from Google every two
/// minutes, and the cache is kept for five minutes.
///
/// Bug fix: ERP put every user id of the management/agent sheets into the
/// "coloured" sets, so the search showed everybody as «مدقق يدوي». The rule
/// documented in ERP's search plan is presence + row colour; a row counts
/// as coloured when its id cell has a non-white background.
class CycleSyncWorker {
  CycleSyncWorker(this.db, this.sheetsProvider);

  final AppDatabase db;
  final SheetsApi Function() sheetsProvider;

  static const enabledKey = 'cycleSyncEnabled';
  static const interval = Duration(milliseconds: 120000);
  static const ttl = Duration(minutes: 5);

  Timer? _timer;
  bool _running = false;

  Future<bool> isEnabled() async => (await db.getValue(enabledKey)) == '1';

  Future<void> setEnabled(bool enabled) async {
    await db.setValue(enabledKey, enabled ? '1' : '0');
    if (enabled) {
      start();
      unawaited(runOnce());
    } else {
      stop();
    }
  }

  void start() {
    _timer ??= Timer.periodic(interval, (_) => runOnce());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// ERP `runCycleSyncOnce`. Returns how many cycles were refreshed.
  Future<int> runOnce() async {
    if (_running) return 0;
    _running = true;
    var synced = 0;
    try {
      if (!await isEnabled()) return 0;
      for (final cycle in await db.listCycles()) {
        if (!cycle.linkedToGoogle) continue;
        try {
          final staleAfter = await db.cacheStaleAfter(cycle.id);
          if (staleAfter != null && staleAfter.isAfter(DateTime.now())) {
            continue;
          }
          await syncSingleCycle(cycle);
          synced++;
        } catch (_) {
          // ERP logs the failure and moves on to the next cycle.
        }
      }
    } catch (_) {
      // Not connected to Google, or the database is closing.
    } finally {
      _running = false;
    }
    return synced;
  }

  /// ERP `syncSingleCycle`.
  Future<void> syncSingleCycle(Cycle cycle) async {
    final sheets = sheetsProvider();
    final mgmtSsId = cycle.managementSpreadsheetId;
    final agentSsId = cycle.agentSpreadsheetId!;
    // A period without a management sheet (3.4.0) syncs its agent sheet only.
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
    );
    final cols = await db.getCycleColumns(cycle.id);
    final mgmtIdx = columnLetterToIndex(cols.mgmtUserIdCol) ?? 0;
    final agentIdx = columnLetterToIndex(cols.agentUserIdCol) ?? 0;

    Future<Set<String>> coloredIds(
      String spreadsheetId,
      String? sheetTitle,
      Rows rows,
      int idCol,
      String idLetter,
    ) async {
      final ids = <String>{};
      if (sheetTitle == null || rows.length < 2) return ids;
      final colors = await withSheetsRetry(
        () => sheets.columnBackgrounds(
          spreadsheetId,
          sheetTitle,
          idLetter,
          rows.length,
        ),
      );
      // ERP treats the first row as the header (`slice(1)`).
      for (var i = 1; i < rows.length; i++) {
        final id = normalizeUserId(cellAt(rows[i], idCol));
        if (id.isEmpty) continue;
        if (i < colors.length && isColoredBackground(colors[i])) ids.add(id);
      }
      return ids;
    }

    final auditedMgmtIds =
        mgmtSsId == null
            ? <String>{}
            : await coloredIds(
              mgmtSsId,
              mgmt.sheetTitleUsed,
              mgmt.values,
              mgmtIdx,
              columnIndexToLetter(mgmtIdx),
            );
    final auditedAgentIds = await coloredIds(
      agentSsId,
      agent.sheetTitleUsed,
      agent.values,
      agentIdx,
      columnIndexToLetter(agentIdx),
    );

    await db.saveCycleCache(
      cycle.id,
      CycleCache(
        managementData: mgmt.values,
        agentData: agent.values,
        managementSheetName: mgmt.sheetTitleUsed ?? cycle.managementSheetName,
        agentSheetName: agent.sheetTitleUsed ?? cycle.agentSheetName,
        auditedAgentIds: auditedAgentIds,
        auditedMgmtIds: auditedMgmtIds,
        foundInTargetSheetIds: <String>{},
        staleAfter: DateTime.now().add(ttl),
      ),
    );
  }
}
