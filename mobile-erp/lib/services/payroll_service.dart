import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../data/app_database.dart';
import '../erp/js_compat.dart';
import '../erp/normalize.dart';
import '../erp/payroll_audit_engine.dart';
import '../google/sheets_client.dart';
import 'payroll_models.dart';

export 'payroll_models.dart';

/// ERP `hashUserInfoRows`.
String hashUserInfoRows(Rows rows) =>
    sha256.convert(utf8.encode(jsonEncode(rows))).toString();

/// ERP `resolvePayrollDiscountRatePct`.
double resolveDiscount(double? requested, PayrollSettings settings) {
  if (requested == null || requested.isNaN) return settings.discountRate;
  return requested;
}

/// Result of preparing a Google audit: either the plan of writes or a
/// failure that stops the audit (as ERP's response with success: false).
class PreparedAudit {
  const PreparedAudit.plan(AuditPlan this.plan) : failure = null;
  const PreparedAudit.fail(PayrollResult this.failure) : plan = null;
  final AuditPlan? plan;
  final PayrollResult? failure;
}

/// The bulk audit — a port of ERP `POST /api/sheet/payroll-execute`
/// running on the phone.
///
/// The Google audit is split in two: [prepareGoogle] reads and computes
/// exactly like ERP and returns the list of writes; [runStep] performs one
/// write and may be repeated safely (copies re-check the target sheet, the
/// other writes overwrite the same cells), so an interrupted audit resumes
/// from the first unfinished step. Accounting side effects of ERP are not
/// part of the audit app (owner's decision).
///
/// Owner's request (2026-11-17), different from ERP: a duplicated id in
/// the user-info sheet no longer stops the audit. Its first row is audited
/// normally, the other rows are not copied again and get «مكرر (الصف N)»,
/// and every duplicate (id + rows) is reported.
class PayrollService {
  PayrollService(this.db, this.sheetsProvider);

  final AppDatabase db;

  /// Returns the Google client, or throws when the account is not connected.
  final SheetsApi Function() sheetsProvider;

  /// Runs the whole audit in this isolate (local files, tests). The app
  /// runs Google audits as background jobs (see `AuditJobRunner`).
  Future<PayrollResult> execute(
    PayrollRequest req, {
    Progress? onProgress,
  }) async {
    final progress = onProgress ?? (_) {};
    try {
      final ui = req.userInfo;
      if (ui is LocalUserInfo) return await _executeLocal(req, ui, progress);
      final prepared = await prepareGoogle(req, progress);
      final plan = prepared.plan;
      if (plan == null) return prepared.failure!;
      while (!plan.complete) {
        await runStep(plan, plan.next, progress);
        plan.next++;
      }
      return plan.result;
    } on SheetsApiException catch (e) {
      return PayrollResult.fail(e.message);
    } catch (e) {
      return PayrollResult.fail(
        e.toString().isEmpty ? 'فشل تنفيذ التدقيق' : e.toString(),
      );
    }
  }

  // ======================================================================
  // Google mode: reads and decisions identical to ERP payroll-execute
  // ======================================================================

  Future<PreparedAudit> prepareGoogle(
    PayrollRequest req,
    Progress progress,
  ) async {
    final ui = req.userInfo as GoogleUserInfo;
    final settings = await db.getPayrollSettings();
    final discountRatePct = resolveDiscount(req.discountRate, settings);
    final cycle = await db.getCycle(req.cycleId);
    if (cycle == null) {
      return PreparedAudit.fail(PayrollResult.fail('الدورة المالية غير موجودة'));
    }

    final sheets = sheetsProvider();
    var managementRows = cycle.managementRows;
    var agentRows = cycle.agentRows;
    final mgmtSsId = cycle.managementSpreadsheetId;
    final mgmtSheetName = cycle.managementSheetName;
    final agentSsId = cycle.agentSpreadsheetId;
    final agentSheetNameCycle = cycle.agentSheetName;

    // A cycle without a management sheet is audited without it (3.4.0).
    final noMgmt = req.withoutManagement || cycle.withoutManagement;
    var cycleSynced = false;
    if (noMgmt && agentSsId != null) {
      // Audit without the management sheet: only the agent sheet is read.
      progress('1/2 مزامنة جدول الوكيل من Google...');
      try {
        final agentResult = await fetchSheetWithFallback(
          sheets,
          agentSsId,
          agentSheetNameCycle,
        );
        agentRows = agentResult.values;
        await db.updateCycle(cycle.id, {
          'agent_data': agentRows,
          'agent_sheet_name': agentResult.sheetTitleUsed ?? agentSheetNameCycle,
        });
        cycleSynced = true;
      } on SheetsApiException catch (e) {
        if (e.transient) rethrow;
      } catch (_) {}
    } else if (mgmtSsId != null && agentSsId != null) {
      progress('1/2 مزامنة جداول الدورة من Google...');
      try {
        final mgmtResult = await fetchSheetWithFallback(
          sheets,
          mgmtSsId,
          mgmtSheetName,
        );
        final agentResult = await fetchSheetWithFallback(
          sheets,
          agentSsId,
          agentSheetNameCycle,
          mgmtSsId == agentSsId ? mgmtResult.sheetTitleUsed : null,
        );
        managementRows = mgmtResult.values;
        agentRows = agentResult.values;
        await db.updateCycle(cycle.id, {
          'management_data': managementRows,
          'agent_data': agentRows,
          'management_sheet_name': mgmtResult.sheetTitleUsed ?? mgmtSheetName,
          'agent_sheet_name': agentResult.sheetTitleUsed ?? agentSheetNameCycle,
        });
        cycleSynced = true;
      } on SheetsApiException catch (e) {
        // ERP continues with the saved snapshots when the sync fails; a
        // lost connection is retried by the job instead.
        if (e.transient) rethrow;
      } catch (_) {}
    }

    progress('1/2 قراءة جدول بيانات المستخدمين...');
    final spreadsheetId = ui.spreadsheetId;
    final meta = await withSheetsRetry(
      () => sheets.getSpreadsheet(spreadsheetId),
    );
    final mainSheetTitle = userInfoSheetTitle(meta, ui);
    requireSheet(meta, mainSheetTitle, 'جدول بيانات المستخدمين');
    // ERP reads 'title'!A:ZZ in one request; reading in batches gives the
    // same rows and works for sheets of any size.
    final allRows = await fetchSheetValuesBatched(
      sheets,
      spreadsheetId,
      mainSheetTitle,
      rowCount: sheetRowCount(meta, mainSheetTitle),
    );
    final spreadsheetUrl = meta.url;

    final userInfoHash = hashUserInfoRows(allRows);
    // Owner's request (3.3.0): after a successful audit, the next one
    // audits only the new information — users without «مدقق» in this
    // period (new rows, or users not found before) — and leaves the
    // audited users' cells, colours and copies as they are. New rows in
    // the management or agent sheets count, so the unchanged-hash stop of
    // ERP only applies to a period never audited. [forceReaudit] runs the
    // whole audit again like ERP.
    final auditedMemberIds = await db.auditedMemberIds(cycle.id);
    final incremental = auditedMemberIds.isNotEmpty && !req.forceReaudit;
    if (!incremental &&
        cycle.userInfoHash != null &&
        cycle.userInfoHash == userInfoHash &&
        !req.forceReaudit) {
      return PreparedAudit.fail(
        PayrollResult.fail(
          'لم يتغيّر جدول بيانات المستخدمين من آخر تدقيق ناجح. عدّل الجدول ثم أعد المحاولة.',
          code: 'USER_INFO_UNCHANGED',
          url: spreadsheetUrl,
        ),
      );
    }

    final out = runPayrollAuditCore(
      managementRows: managementRows,
      agentRows: agentRows,
      userInfoRows: allRows,
      columns: req.columns,
      discountRatePct: discountRatePct,
      agentColor: req.agentColor,
      managementColor: req.managementColor,
      emptyTitle: req.emptyTitle,
      withoutManagement: noMgmt,
    );
    final duplicates = findDuplicateGroups(out);
    if (duplicates.isNotEmpty) {
      progress(
        '1/2 تم العثور على ${duplicates.length} رقم مكرر في جدول بيانات المستخدمين — يُدقق أول صف لكل رقم فقط',
      );
    }
    final skipped = {for (final d in duplicates) ...d.skippedRows};
    final grouped = groupByTitle(out, skipped);

    // Target sheet names from the title column (ERP column D).
    final titleToSheetName = <String, String>{};
    final usedNames = <String>{};
    for (final title in grouped.order) {
      var st = safeSheetTitle(title);
      while (usedNames.contains(st)) {
        st = '${st}_${usedNames.length}';
      }
      usedNames.add(st);
      titleToSheetName[title] = st;
    }
    final seenLower = <String>{};
    final sheetNamesOrdered = [
      for (final t in grouped.order)
        if (seenLower.add(titleToSheetName[t]!.toLowerCase()))
          titleToSheetName[t]!,
    ];

    final steps = <Map<String, Object?>>[];
    if (noMgmt ? agentSsId == null : (mgmtSsId == null || agentSsId == null)) {
      // ERP creates a spreadsheet for a cycle built from uploaded files
      // (the app's audit button only reaches this for linked cycles).
      steps.add({'k': 'createCycleSpreadsheet', 'name': cycle.name});
    }
    final copies = <Map<String, Object?>>[];
    final cycleMgmtCol = out.cycleMgmtCol;
    for (final title in grouped.order) {
      final items = grouped.byTitle[title]!;
      final seenInBatch = <String>{};
      final rows = <List<String>>[];
      for (final it in items) {
        final id = normalizeUserId(cellAt(it.managementRow, cycleMgmtCol));
        if (id.isEmpty || auditedMemberIds.contains(id)) continue;
        if (!seenInBatch.add(id)) continue;
        rows.add(it.managementRow);
      }
      if (rows.isEmpty) continue;
      copies.add({
        'k': 'copy',
        'sheet': titleToSheetName[title],
        'idCol': cycleMgmtCol,
        'rows': rows,
      });
    }
    // An incremental audit only creates the sheets it copies into.
    final names =
        incremental
            ? [
              for (final c in copies)
                if (seenLower.add('+${(c['sheet'] as String).toLowerCase()}'))
                  c['sheet'] as String,
            ]
            : sheetNamesOrdered;
    if (names.isNotEmpty) steps.add({'k': 'addSheets', 'names': names});
    steps.addAll(copies);

    final writes = salaryStatusColumns(req, out, duplicates);
    final newIds = <String>{
      for (final r in out.results)
        if (r.userId.isNotEmpty && !auditedMemberIds.contains(r.userId))
          r.userId,
    };
    if (incremental) {
      final cells = _newRowCells(
        writes,
        mainSheetTitle,
        rows: {
          for (final r in out.results)
            if (newIds.contains(r.userId)) r.rowIndex,
          for (final d in duplicates) ...d.skippedRows,
        },
      );
      if (cells.isNotEmpty) {
        steps.add({
          'k': 'cells',
          'what': 'الراتب والحالة للمستخدمين الجدد',
          'ss': spreadsheetId,
          'data': cells,
        });
      }
    } else if (writes.salaryValues.isNotEmpty) {
      final t = escapeSheetTitleForRange(mainSheetTitle);
      steps.add({
        'k': 'values',
        'what': 'الراتب',
        'ss': spreadsheetId,
        'range':
            "'$t'!${writes.salaryColLetter}${writes.minRow}:${writes.salaryColLetter}${writes.maxRow}",
        'values': writes.salaryValues,
      });
      steps.add({
        'k': 'values',
        'what': 'الحالة',
        'ss': spreadsheetId,
        'range':
            "'$t'!${writes.statusColLetter}${writes.minRow}:${writes.statusColLetter}${writes.maxRow}",
        'values': writes.statusValues,
      });
    }
    final colors = sourceColors(out, onlyIds: incremental ? newIds : null);
    if (colors.mgmt.isNotEmpty) {
      steps.add({
        'k': 'color',
        'sheetOf': 'management',
        'rows': {for (final e in colors.mgmt.entries) '${e.key}': e.value},
      });
    }
    if (colors.agent.isNotEmpty) {
      steps.add({
        'k': 'color',
        'sheetOf': 'agent',
        'rows': {for (final e in colors.agent.entries) '${e.key}': e.value},
      });
    }
    steps.add({'k': incremental ? 'finishMerge' : 'finish'});

    var summary = buildResult(
      out: out,
      spreadsheetUrl: spreadsheetUrl,
      cycleSynced: cycleSynced,
      localOnly: false,
      duplicates: duplicates,
    );
    if (incremental && summary.success && (summary.summary?.total ?? 0) > 0) {
      summary = summary.withMessage(
        incrementalMessage(
          out,
          newIds,
          before: auditedMemberIds.length,
          copied: [for (final c in copies) ...(c['rows'] as List)].length,
        ),
      );
    }
    return PreparedAudit.plan(
      AuditPlan(
        cycleId: cycle.id,
        steps: steps,
        next: 0,
        result: summary,
        finish:
            incremental
                ? {
                  ...finishData(out, userInfoHash, onlyIds: newIds),
                  'mode': 'google-incremental',
                }
                : finishData(out, userInfoHash),
      ),
    );
  }

  /// The salary and status cells of [rows] only, as ranges of consecutive
  /// rows (an incremental audit leaves the other rows as they are).
  static List<List<Object?>> _newRowCells(
    ColumnWrites writes,
    String sheetTitle, {
    required Set<int> rows,
  }) {
    final t = escapeSheetTitleForRange(sheetTitle);
    final sorted = [
      for (final r in rows)
        if (r >= writes.minRow && r <= writes.maxRow) r,
    ]..sort();
    final data = <List<Object?>>[];
    var i = 0;
    while (i < sorted.length) {
      var j = i;
      while (j + 1 < sorted.length && sorted[j + 1] == sorted[j] + 1) {
        j++;
      }
      final a = sorted[i], b = sorted[j];
      for (final (col, values) in [
        (writes.salaryColLetter, writes.salaryValues),
        (writes.statusColLetter, writes.statusValues),
      ]) {
        data.add([
          "'$t'!$col$a:$col$b",
          values.sublist(a - writes.minRow, b - writes.minRow + 1),
        ]);
      }
      i = j + 1;
    }
    return data;
  }

  /// What an incremental audit did, for the results card.
  static String incrementalMessage(
    AuditCoreOutput out,
    Set<String> newIds, {
    required int before,
    required int copied,
  }) {
    final agent = <String>{}, mgmt = <String>{}, missing = <String>{};
    final noSalary = <String>{};
    for (final r in out.results) {
      if (!newIds.contains(r.userId)) continue;
      if (isAgentType(r.type)) {
        agent.add(r.userId);
      } else if (r.type == typeManagement) {
        mgmt.add(r.userId);
      } else if (r.type == typeNotFound) {
        missing.add(r.userId);
      } else if (r.type == typeNoSalary) {
        noSalary.add(r.userId);
      }
    }
    final audited = agent.length + mgmt.length + noSalary.length;
    final kept = 'المدققون من قبل ($before) لم يُعَد تدقيقهم.';
    if (audited == 0) {
      return missing.isEmpty
          ? 'لا توجد معلومات جديدة لتدقيقها. $kept'
          : 'لا توجد معلومات جديدة مطابقة: أُعيد فحص ${missing.length} غير موجود فقط. $kept';
    }
    // Audit without the management sheet (3.4.0): nothing is copied.
    if (out.mgmtDataRows.isEmpty && mgmt.isEmpty && copied == 0) {
      return 'دُققت المعلومات الجديدة فقط: $audited مستخدم (${agent.length} سحب وكالة، ${noSalary.length} بدون راتب)${missing.isEmpty ? '' : '، و${missing.length} غير موجود'}. $kept';
    }
    return 'دُققت المعلومات الجديدة فقط: $audited مستخدم (${agent.length} سحب وكالة، ${mgmt.length} سحب إدارة)${missing.isEmpty ? '' : '، و${missing.length} غير موجود'}، ونُسخ $copied صف إلى جدول الإدارة. $kept';
  }

  /// ERP: the chosen user-info sheet, or the first sheet.
  static String userInfoSheetTitle(SpreadsheetMeta meta, GoogleUserInfo ui) {
    final firstSheet = meta.sheets.isEmpty ? null : meta.sheets.first;
    final requestedTitle = ui.sheetName?.trim() ?? '';
    return requestedTitle.isNotEmpty
        ? requestedTitle
        : (firstSheet?.title ?? 'Sheet1');
  }

  /// Human-readable label of a step, for the progress line.
  static String describeStep(Map<String, Object?> step) {
    switch (step['k']) {
      case 'createCycleSpreadsheet':
        return '2/2 إنشاء جدول Google للدورة...';
      case 'addSheets':
        return '2/2 إنشاء أوراق الوجهة في جدول الإدارة...';
      case 'copy':
        final n = (step['rows'] as List).length;
        return '2/2 نسخ $n صف إلى ورقة «${step['sheet']}»...';
      case 'values':
      case 'cells':
        return '2/2 كتابة ${step['what']} في جدول بيانات المستخدمين...';
      case 'color':
        final n = (step['rows'] as Map).length;
        return step['sheetOf'] == 'management'
            ? '2/2 تلوين $n صف في ورقة الإدارة...'
            : '2/2 تلوين $n صف في ورقة الوكيل...';
      case 'appendUserInfo':
        final n = (step['rows'] as List).length;
        return '2/2 إضافة $n رقم إلى جدول بيانات المستخدمين...';
      case 'colorTargetIds':
        return '2/2 تلوين الصفوف المنسوخة في ورقة «${step['sheet']}»...';
      case 'finish':
      case 'finishMerge':
        return '2/2 حفظ النتائج...';
    }
    return '2/2 تطبيق...';
  }

  /// Performs step [index] of [plan]. Safe to repeat after an interruption.
  Future<void> runStep(AuditPlan plan, int index, Progress progress) async {
    final step = plan.steps[index];
    progress(describeStep(step));
    final kind = step['k'];
    if (kind == 'finish') {
      await _finishPlan(plan);
      return;
    }
    if (kind == 'finishMerge') {
      await _finishMerge(plan);
      return;
    }
    if (kind == 'appendUserInfo') {
      await _appendUserInfoStep(step);
      return;
    }
    if (kind == 'colorTargetIds') {
      await _colorTargetIds(step, plan);
      return;
    }
    // Light record (links and sheet names); the data only where needed.
    final info = await db.getCycleInfo(plan.cycleId);
    if (info == null) throw Exception('الدورة المالية غير موجودة');
    var cycle = info;
    final sheets = sheetsProvider();
    switch (kind) {
      case 'createCycleSpreadsheet':
        if (cycle.linkedToGoogle) return; // already done before a restart
        cycle = (await db.getCycle(plan.cycleId))!;
        final cycleName =
            cycle.name.trim().isEmpty ? 'دورة' : cycle.name.trim();
        final dateStr = DateTime.now().toIso8601String().substring(0, 10);
        final newId = await withSheetsRetry(
          () => sheets.createSpreadsheet('دورة $cycleName - $dateStr', const [
            'الإدارة',
            'الوكيل',
          ]),
        );
        for (final (title, rows) in [
          ('الإدارة', cycle.managementRows),
          ('الوكيل', cycle.agentRows),
        ]) {
          for (var i = 0; i < rows.length; i += copyChunkRows) {
            final end =
                i + copyChunkRows > rows.length
                    ? rows.length
                    : i + copyChunkRows;
            await withSheetsRetry(
              () => sheets.valuesUpdate(
                newId,
                "'$title'!A${i + 1}",
                rows.sublist(i, end),
              ),
            );
          }
        }
        await db.updateCycle(cycle.id, {
          'management_spreadsheet_id': newId,
          'management_sheet_name': 'الإدارة',
          'agent_spreadsheet_id': newId,
          'agent_sheet_name': 'الوكيل',
        });
      case 'addSheets':
        final mgmtSsId = cycle.managementSpreadsheetId!;
        SpreadsheetMeta meta;
        try {
          meta = await withSheetsRetry(() => sheets.getSpreadsheet(mgmtSsId));
        } on SheetsApiException catch (e) {
          if (e.transient) rethrow;
          throw Exception(
            'لا يمكن الوصول إلى جدول الإدارة (الدورة). تأكد أن الدورة مرتبطة بجدول في حساب Google المرتبط بالتطبيق: $e',
          );
        }
        final existing = {for (final s in meta.sheets) s.title.toLowerCase()};
        final toCreate = [
          for (final n in (step['names'] as List).cast<String>())
            if (!existing.contains(n.toLowerCase())) n,
        ];
        if (toCreate.isEmpty) return;
        await withSheetsRetry(
          () => sheets.batchUpdate(mgmtSsId, [
            for (final st in toCreate)
              {
                'addSheet': {
                  'properties': {'title': st},
                },
              },
          ]),
        );
      case 'copy':
        await _copyStep(cycle, step, index, plan);
      case 'cells':
        // Separate ranges of an incremental audit; repeating overwrites
        // the same cells.
        final data = [
          for (final d in (step['data'] as List))
            (
              (d as List)[0] as String,
              [for (final r in (d[1] as List)) List<Object?>.from(r as List)],
            ),
        ];
        for (var i = 0; i < data.length; i += 1000) {
          final part = data.sublist(
            i,
            i + 1000 > data.length ? data.length : i + 1000,
          );
          await withSheetsRetry(
            () => sheets.valuesBatchUpdate(step['ss'] as String, part),
          );
        }
      case 'values':
        // One column, rows minRow..maxRow; very long columns are written in
        // parts (each part overwrites the same cells if repeated).
        final m =
            RegExp(
              r"^(.*)!([A-Z]+)(\d+):([A-Z]+)(\d+)$",
            ).firstMatch(step['range'] as String)!;
        final prefix = m.group(1)!;
        final col = m.group(2)!;
        final first = int.parse(m.group(3)!);
        final values = [
          for (final r in (step['values'] as List))
            List<Object?>.from(r as List),
        ];
        for (var i = 0; i < values.length; i += valuesChunkRows) {
          final end =
              i + valuesChunkRows > values.length
                  ? values.length
                  : i + valuesChunkRows;
          await withSheetsRetry(
            () => sheets.valuesUpdate(
              step['ss'] as String,
              '$prefix!$col${first + i}:$col${first + end - 1}',
              values.sublist(i, end),
            ),
          );
        }
      case 'color':
        final isMgmt = step['sheetOf'] == 'management';
        final ssId =
            isMgmt ? cycle.managementSpreadsheetId : cycle.agentSpreadsheetId;
        if (ssId == null) return;
        final meta = await withSheetsRetry(() => sheets.getSpreadsheet(ssId));
        final sheetId = getSheetIdByTitle(
          meta,
          isMgmt ? cycle.managementSheetName : cycle.agentSheetName,
        );
        if (sheetId == null) return;
        final byRow = {
          for (final e in (step['rows'] as Map).entries)
            int.parse(e.key.toString()): e.value.toString(),
        };
        // Owner's request: one request per sheet instead of ERP's batches
        // of 8 every 1.5 s; consecutive rows of one colour form one range.
        final requests = mergedColorRequests(
          sheetId,
          byRow,
          colorEndColumn(meta, sheetId),
        );
        for (var i = 0; i < requests.length; i += colorBatchSize) {
          final chunk = requests.sublist(
            i,
            i + colorBatchSize > requests.length
                ? requests.length
                : i + colorBatchSize,
          );
          await withSheetsRetry(() => sheets.batchUpdate(ssId, chunk));
        }
    }
  }

  static const colorBatchSize = 5000;
  static const valuesChunkRows = 20000;
  static const copyChunkRows = 5000;

  /// Copies rows to one target sheet. The target is read first, so an id
  /// already there (earlier run, manual paste, or a copy whose reply was
  /// lost) is never written twice.
  Future<void> _copyStep(
    Cycle cycle,
    Map<String, Object?> step,
    int index,
    AuditPlan plan,
  ) async {
    final sheets = sheetsProvider();
    final mgmtSsId = cycle.managementSpreadsheetId!;
    final sheetName = step['sheet'] as String;
    final idCol = (step['idCol'] as num).toInt();
    // ERP waits 1.2 s between target sheets to stay under Google quotas.
    if (index > 0 && plan.steps[index - 1]['k'] == 'copy') {
      await sleepMs(1200);
    }
    final sheetRows = await withSheetsRetry(
      () => sheets.valuesGet(mgmtSsId, rangeWholeSheet(sheetName)),
    );
    final existing = <String>{};
    for (var idx = 0; idx < sheetRows.length; idx++) {
      final row = sheetRows[idx];
      if (idx == 0 && isHeaderRowGeneric(row, idCol)) continue;
      final id = normalizeUserId(cellAt(row, idCol));
      if (id.isNotEmpty) existing.add(id);
    }
    final values = <List<Object?>>[
      for (final r in (step['rows'] as List))
        if (!existing.contains(normalizeUserId(cellAt(_strings(r), idCol))))
          List<Object?>.from(r as List),
    ];
    if (values.isEmpty) return;
    try {
      // Very large copies go in parts; a repeated step re-reads the sheet
      // above, so parts already written are skipped.
      var empty = sheetRows.isEmpty;
      for (var i = 0; i < values.length; i += copyChunkRows) {
        final part = values.sublist(
          i,
          i + copyChunkRows > values.length ? values.length : i + copyChunkRows,
        );
        if (!empty) {
          await withSheetsRetry(
            () =>
                sheets.valuesAppend(mgmtSsId, rangeWholeSheet(sheetName), part),
          );
        } else {
          await withSheetsRetry(
            () => sheets.valuesUpdate(
              mgmtSsId,
              "'${escapeSheetTitleForRange(sheetName)}'!A1",
              part,
            ),
          );
          empty = false;
        }
      }
    } on SheetsApiException catch (e) {
      if (e.transient) rethrow;
      throw Exception(
        'فشل نسخ الصفوف إلى ورقة «$sheetName» في جدول الإدارة: $e',
      );
    }
  }

  static List<String> _strings(Object? r) => [
    for (final c in (r as List)) c?.toString() ?? '',
  ];

  Future<void> _finishPlan(AuditPlan plan) async {
    final cycle = await db.getCycle(plan.cycleId);
    if (cycle == null) return;
    final f = plan.finish;
    final entries = [
      for (final e in (f['entries'] as List))
        AuditEntry(
          (e as Map)['id'].toString(),
          'مدقق',
          e['source'] as String?,
          Map<String, Object?>.from(e['details'] as Map),
        ),
    ];
    await db.saveUserAuditStatuses(cycle.id, entries);
    await db.saveCycleCache(
      cycle.id,
      CycleCache(
        managementData: cycle.managementRows,
        agentData: cycle.agentRows,
        managementSheetName: cycle.managementSheetName,
        agentSheetName: cycle.agentSheetName,
        auditedAgentIds: {for (final x in (f['agent'] as List)) x.toString()},
        auditedMgmtIds: {for (final x in (f['mgmt'] as List)) x.toString()},
        foundInTargetSheetIds: <String>{},
      ),
    );
    await db.updateCycle(cycle.id, {'payroll_audit_user_info_hash': f['hash']});
    await db.addAuditRun(cycle.id, 'google', plan.result.toLog());
  }

  // ======================================================================
  // Local mode: same audit, effects kept in a workbook on the phone
  // ======================================================================

  Future<PayrollResult> _executeLocal(
    PayrollRequest req,
    LocalUserInfo ui,
    Progress progress,
  ) async {
    final settings = await db.getPayrollSettings();
    final discountRatePct = resolveDiscount(req.discountRate, settings);
    final cycle = await db.getCycle(req.cycleId);
    if (cycle == null) return PayrollResult.fail('الدورة المالية غير موجودة');
    final managementRows = cycle.managementRows;
    final agentRows = cycle.agentRows;
    if (ui.rows.isEmpty) {
      return PayrollResult.fail('ملف بيانات المستخدمين فارغ.');
    }
    if (managementRows.isEmpty && agentRows.isEmpty) {
      return PayrollResult.fail(
        'بيانات الإدارة أو الوكيل فارغة. زامن الدورة أو أعد رفع الملفات.',
      );
    }
    final noMgmt = req.withoutManagement || cycle.withoutManagement;
    progress('تدقيق على الهاتف...');
    final allRows = ui.rows;
    final userInfoHash = hashUserInfoRows(allRows);
    if (cycle.userInfoHash != null &&
        cycle.userInfoHash == userInfoHash &&
        !req.forceReaudit) {
      return PayrollResult.fail(
        'لم يتغيّر جدول بيانات المستخدمين من آخر تدقيق ناجح. عدّل الملف ثم أعد المحاولة.',
        code: 'USER_INFO_UNCHANGED',
      );
    }
    final out = runPayrollAuditCore(
      managementRows: managementRows,
      agentRows: agentRows,
      userInfoRows: allRows,
      columns: req.columns,
      discountRatePct: discountRatePct,
      agentColor: req.agentColor,
      managementColor: req.managementColor,
      emptyTitle: req.emptyTitle,
      withoutManagement: noMgmt,
    );
    final duplicates = findDuplicateGroups(out);
    final skipped = {for (final d in duplicates) ...d.skippedRows};
    final grouped = groupByTitle(out, skipped);

    final book = LocalWorkbookState.fromJson(
      await db.getLocalWorkbook(cycle.id),
    );
    final cycleMgmtCol = out.cycleMgmtCol;

    // Same naming and de-duplication rules as the Google target sheets.
    final titleToSheetName = <String, String>{};
    final usedNames = <String>{};
    for (final title in grouped.order) {
      var st = safeSheetTitle(title);
      while (usedNames.contains(st)) {
        st = '${st}_${usedNames.length}';
      }
      usedNames.add(st);
      titleToSheetName[title] = st;
    }
    final existingLower = {
      for (final k in book.targets.keys) k.toLowerCase(): k,
    };
    final auditedMemberIds = await db.auditedMemberIds(cycle.id);
    for (final title in grouped.order) {
      var sheetName = titleToSheetName[title]!;
      final items = grouped.byTitle[title]!;
      sheetName = existingLower[sheetName.toLowerCase()] ?? sheetName;
      final target = book.targets.putIfAbsent(sheetName, () => <TargetRow>[]);
      existingLower[sheetName.toLowerCase()] = sheetName;
      final existingIds = <String>{};
      for (var idx = 0; idx < target.length; idx++) {
        if (idx == 0 && isHeaderRowGeneric(target[idx].values, cycleMgmtCol)) {
          continue;
        }
        final id = normalizeUserId(cellAt(target[idx].values, cycleMgmtCol));
        if (id.isNotEmpty) existingIds.add(id);
      }
      final seen = <String>{};
      for (final it in items) {
        final id = normalizeUserId(cellAt(it.managementRow, cycleMgmtCol));
        if (id.isEmpty ||
            existingIds.contains(id) ||
            auditedMemberIds.contains(id)) {
          continue;
        }
        if (!seen.add(id)) continue;
        target.add(TargetRow(List<String>.from(it.managementRow), null));
      }
    }

    final writes = salaryStatusColumns(req, out, duplicates);
    final userInfoOut = [
      for (final r in allRows) <Object?>[...r],
    ];
    final salaryIdx = columnLetterToIndex(writes.salaryColLetter);
    final statusIdx = columnLetterToIndex(writes.statusColLetter);
    if (salaryIdx != null && statusIdx != null) {
      for (var r = writes.minRow; r <= writes.maxRow; r++) {
        final i = r - writes.minRow;
        final row = userInfoOut[r - 1];
        _setCell(row, salaryIdx, writes.salaryValues[i].first);
        _setCell(row, statusIdx, writes.statusValues[i].first);
      }
    }
    book.userInfoFileName = ui.fileName;
    book.userInfoSheetName = ui.sheetName;
    book.userInfoRows = userInfoOut;

    final colors = sourceColors(out);
    book.mgmtColors.addAll(colors.mgmt);
    book.agentColors.addAll(colors.agent);
    await db.saveLocalWorkbook(cycle.id, book.toJson());

    final result = buildResult(
      out: out,
      spreadsheetUrl: null,
      cycleSynced: false,
      localOnly: true,
      duplicates: duplicates,
    );
    final plan = AuditPlan(
      cycleId: cycle.id,
      steps: const [],
      next: 0,
      result: result,
      finish: finishData(out, userInfoHash),
    );
    final f = plan.finish;
    await db.saveUserAuditStatuses(cycle.id, [
      for (final e in (f['entries'] as List))
        AuditEntry(
          (e as Map)['id'].toString(),
          'مدقق',
          e['source'] as String?,
          Map<String, Object?>.from(e['details'] as Map),
        ),
    ]);
    await db.saveCycleCache(
      cycle.id,
      CycleCache(
        managementData: managementRows,
        agentData: agentRows,
        managementSheetName: cycle.managementSheetName,
        agentSheetName: cycle.agentSheetName,
        auditedAgentIds: {for (final x in (f['agent'] as List)) x.toString()},
        auditedMgmtIds: {for (final x in (f['mgmt'] as List)) x.toString()},
        foundInTargetSheetIds: <String>{},
      ),
    );
    await db.updateCycle(cycle.id, {
      'payroll_audit_user_info_hash': userInfoHash,
    });
    await db.addAuditRun(cycle.id, 'local', result.toLog());
    return result;
  }

  // ======================================================================
  // «غير مذكور» tools (owner's request, 2026-11-17)
  // ======================================================================

  /// Step 1 of the owner's «غير مذكور» flow: user ids of the agent sheet
  /// that are not in the user-info sheet are added to it, one row per id
  /// (an id with several agent rows has several salaries but one user),
  /// right after its last row: the id in the audit's id column and in
  /// [UnmentionedOptions.idCols] (A), the label in the title column (D) and
  /// in [UnmentionedOptions.labelCols] (E). Those rows are then audited
  /// with the same logic as the bulk audit — the title column sends the
  /// copies to the sheet «غير مذكور» of the management spreadsheet — and
  /// only those rows are written (copies, salary and status, colours).
  Future<PreparedAudit> prepareUnmentionedUsers(
    PayrollRequest req,
    UnmentionedOptions opts,
    Progress progress,
  ) async {
    final ui = req.userInfo as GoogleUserInfo;
    final cycle = await db.getCycle(req.cycleId);
    if (cycle == null) {
      return PreparedAudit.fail(PayrollResult.fail('الدورة المالية غير موجودة'));
    }
    if (!cycle.linkedToGoogle) {
      return PreparedAudit.fail(
        PayrollResult.fail('هذه العملية متاحة لدورات Google فقط.'),
      );
    }
    final noMgmt = req.withoutManagement || cycle.withoutManagement;
    final colId = columnLetterToIndex(req.columns.userInfoUserIdCol) ?? 2;
    final colTitle = columnLetterToIndex(req.columns.userInfoTitleCol) ?? 3;
    if (colId == colTitle) {
      return PreparedAudit.fail(
        PayrollResult.fail(
          'عمود رقم المستخدم وعمود اسم الورقة يجب أن يكونا مختلفين.',
        ),
      );
    }
    final sheets = sheetsProvider();
    progress('1/2 قراءة جدول بيانات المستخدمين...');
    final meta = await withSheetsRetry(
      () => sheets.getSpreadsheet(ui.spreadsheetId),
    );
    final title = userInfoSheetTitle(meta, ui);
    requireSheet(meta, title, 'جدول بيانات المستخدمين');
    final allRows = await fetchSheetValuesBatched(
      sheets,
      ui.spreadsheetId,
      title,
      rowCount: sheetRowCount(meta, title),
    );
    final present = <String>{
      for (final r in allRows) normalizeUserId(cellAt(r, colId)),
    };

    final agentCol = columnLetterToIndex(req.columns.cycleAgentUserIdCol) ?? 0;
    final agentRows = cycle.agentRows;
    final start =
        agentRows.isNotEmpty && isHeaderRowCycle(agentRows[0], agentCol)
            ? 1
            : 0;
    final missing = <String>[];
    final seen = <String>{};
    for (var i = start; i < agentRows.length; i++) {
      final id = normalizeUserId(cellAt(agentRows[i], agentCol));
      if (id.isEmpty || present.contains(id) || !seen.add(id)) continue;
      missing.add(id);
    }
    if (missing.isEmpty) {
      return PreparedAudit.plan(
        AuditPlan(
          cycleId: cycle.id,
          steps: const [],
          next: 0,
          result: PayrollResult(
            success: true,
            message:
                'لا يوجد مستخدمون غير مذكورين: كل أرقام ورقة الوكيل موجودة في جدول بيانات المستخدمين.',
            spreadsheetUrl: meta.url,
          ),
          finish: const {},
        ),
      );
    }

    // The new rows: labels first, then the ids (the id and title columns
    // always hold the id and the label).
    Set<int> indices(int first, List<String> letters) => {
      first,
      for (final c in letters)
        if (columnLetterToIndex(c) != null) columnLetterToIndex(c)!,
    };
    final idCols = indices(colId, opts.idCols);
    final labelCols = indices(colTitle, opts.labelCols)..removeAll(idCols);
    final width = [...idCols, ...labelCols].reduce((a, b) => a > b ? a : b) + 1;
    final newRows = <List<String>>[
      for (final id in missing)
        [
          for (var c = 0; c < width; c++)
            idCols.contains(c) ? id : (labelCols.contains(c) ? opts.label : ''),
        ],
    ];
    final firstNew = allRows.length + 1;

    final settings = await db.getPayrollSettings();
    final out = runPayrollAuditCore(
      managementRows: cycle.managementRows,
      agentRows: agentRows,
      userInfoRows: [...allRows, ...newRows],
      columns: req.columns,
      discountRatePct: resolveDiscount(req.discountRate, settings),
      agentColor: req.agentColor,
      managementColor: req.managementColor,
      emptyTitle: req.emptyTitle,
      withoutManagement: noMgmt,
    );
    final grouped = groupByTitle(out, {
      for (final r in out.results)
        if (r.rowIndex < firstNew) r.rowIndex,
    });

    final steps = <Map<String, Object?>>[
      {
        'k': 'appendUserInfo',
        'ss': ui.spreadsheetId,
        'sheet': title,
        'startRow': firstNew,
        'idCol': colId,
        'rows': newRows,
      },
    ];
    final auditedMemberIds = await db.auditedMemberIds(cycle.id);
    final copies = <Map<String, Object?>>[];
    final usedNames = <String>{};
    for (final t in grouped.order) {
      var sheetName = safeSheetTitle(t);
      while (usedNames.contains(sheetName)) {
        sheetName = '${sheetName}_${usedNames.length}';
      }
      usedNames.add(sheetName);
      final seenInBatch = <String>{};
      final rows = <List<String>>[
        for (final it in grouped.byTitle[t]!)
          if (_copyable(it, out.cycleMgmtCol, auditedMemberIds, seenInBatch))
            it.managementRow,
      ];
      if (rows.isEmpty) continue;
      copies.add({
        'k': 'copy',
        'sheet': sheetName,
        'idCol': out.cycleMgmtCol,
        'rows': rows,
      });
    }
    if (copies.isNotEmpty) {
      steps.add({
        'k': 'addSheets',
        'names': [for (final c in copies) c['sheet']],
      });
      steps.addAll(copies);
    }
    final writes = salaryStatusColumns(req, out, const [], firstNew);
    if (writes.salaryValues.isNotEmpty) {
      final t = escapeSheetTitleForRange(title);
      for (final (what, col, values) in [
        ('الراتب', writes.salaryColLetter, writes.salaryValues),
        ('الحالة', writes.statusColLetter, writes.statusValues),
      ]) {
        steps.add({
          'k': 'values',
          'what': what,
          'ss': ui.spreadsheetId,
          'range': "'$t'!$col${writes.minRow}:$col${writes.maxRow}",
          'values': values,
        });
      }
    }
    final colors = sourceColors(out, fromRow: firstNew);
    for (final (of, rows) in [
      ('management', colors.mgmt),
      ('agent', colors.agent),
    ]) {
      if (rows.isEmpty) continue;
      steps.add({
        'k': 'color',
        'sheetOf': of,
        'rows': {for (final e in rows.entries) '${e.key}': e.value},
      });
    }
    steps.add({'k': 'finishMerge'});

    final added = [
      for (final r in out.results)
        if (r.rowIndex >= firstNew) r,
    ];
    final summary = AuditSummary(
      total: added.length,
      agent: added.where((r) => isAgentType(r.type)).length,
      management: added.where((r) => r.type == typeManagement).length,
      notFound: added.where((r) => r.type == typeNotFound).length,
      noSalary: added.where((r) => r.type == typeNoSalary).length,
    );
    final last = firstNew + missing.length - 1;
    return PreparedAudit.plan(
      AuditPlan(
        cycleId: cycle.id,
        steps: steps,
        next: 0,
        result: PayrollResult(
          success: true,
          message:
              'أُضيف ${missing.length} رقم من ورقة الوكيل إلى جدول بيانات المستخدمين (${firstNew == last ? 'الصف $firstNew' : 'الصفوف $firstNew–$last'}) بعنوان «${opts.label}» ودُققت',
          summary: summary,
          applied: true,
          spreadsheetUrl: meta.url,
          results: added,
        ),
        finish: {
          ...finishData(out, '', fromRow: firstNew),
          'mode': 'google-unmentioned-users',
        },
      ),
    );
  }

  static bool _copyable(
    TitleItem it,
    int idCol,
    Set<String> audited,
    Set<String> seenInBatch,
  ) {
    final id = normalizeUserId(cellAt(it.managementRow, idCol));
    if (id.isEmpty || audited.contains(id)) return false;
    return seenInBatch.add(id);
  }

  /// Step 2 of the owner's «غير مذكور» flow: management rows that are not
  /// coloured and not audited, whose user is not in the user-info sheet and
  /// whose sub-agent column (W) holds a non-zero amount, are copied to the
  /// sheet «غير مذكور» of the management spreadsheet (created if missing)
  /// and coloured with the management colour, so they are not pulled twice.
  Future<PreparedAudit> prepareUnmentionedMgmt(
    PayrollRequest req,
    UnmentionedOptions opts,
    Progress progress,
  ) async {
    final ui = req.userInfo as GoogleUserInfo;
    final cycle = await db.getCycle(req.cycleId);
    if (cycle == null) {
      return PreparedAudit.fail(PayrollResult.fail('الدورة المالية غير موجودة'));
    }
    final mgmtSsId = cycle.managementSpreadsheetId;
    if (!cycle.linkedToGoogle || mgmtSsId == null) {
      return PreparedAudit.fail(
        PayrollResult.fail('هذه العملية متاحة لدورات Google فقط.'),
      );
    }
    final sheets = sheetsProvider();
    final mgmtRows = cycle.managementRows;
    final idCol = columnLetterToIndex(req.columns.cycleMgmtUserIdCol) ?? 0;
    final shareCol = columnLetterToIndex(opts.shareCol) ?? 22;

    progress('1/2 قراءة ألوان ورقة الإدارة...');
    final mgmtMeta = await withSheetsRetry(
      () => sheets.getSpreadsheet(mgmtSsId),
    );
    final mgmtTitle =
        cycle.managementSheetName ??
        (mgmtMeta.sheets.isEmpty ? 'Sheet1' : mgmtMeta.sheets.first.title);
    final backgrounds = await withSheetsRetry(
      () => sheets.columnBackgrounds(
        mgmtSsId,
        mgmtTitle,
        columnIndexToLetter(idCol),
        mgmtRows.length,
      ),
    );

    progress('1/2 قراءة جدول بيانات المستخدمين...');
    final colId = columnLetterToIndex(req.columns.userInfoUserIdCol) ?? 2;
    final uiMeta = await withSheetsRetry(
      () => sheets.getSpreadsheet(ui.spreadsheetId),
    );
    final uiTitle = userInfoSheetTitle(uiMeta, ui);
    requireSheet(uiMeta, uiTitle, 'جدول بيانات المستخدمين');
    final uiRows = await fetchSheetValuesBatched(
      sheets,
      ui.spreadsheetId,
      uiTitle,
      rowCount: sheetRowCount(uiMeta, uiTitle),
    );
    final mentioned = <String>{
      for (final r in uiRows) normalizeUserId(cellAt(r, colId)),
    };
    final audited = {
      ...await db.auditedMemberIds(cycle.id),
      ...await db.cacheAuditedIds(cycle.id),
    };

    final start =
        mgmtRows.isNotEmpty && isHeaderRowCycle(mgmtRows[0], idCol) ? 1 : 0;
    final rows = <List<String>>[];
    final rowIndices = <int>[];
    final seen = <String>{};
    for (var i = start; i < mgmtRows.length; i++) {
      final row = mgmtRows[i];
      final id = normalizeUserId(cellAt(row, idCol));
      if (id.isEmpty) continue;
      if (i < backgrounds.length && isColoredBackground(backgrounds[i])) {
        continue;
      }
      if (mentioned.contains(id) || audited.contains(id)) continue;
      final share = parseAmount(cellAt(row, shareCol));
      if (share == null || share == 0) continue;
      if (!seen.add(id)) continue;
      rows.add(row);
      rowIndices.add(i);
    }
    final sheetName = safeSheetTitle(opts.label);
    if (rows.isEmpty) {
      return PreparedAudit.plan(
        AuditPlan(
          cycleId: cycle.id,
          steps: const [],
          next: 0,
          result: PayrollResult(
            success: true,
            message:
                'لا توجد صفوف غير ملوّنة في ورقة الإدارة فيها مبلغ في العمود ${opts.shareCol}.',
            spreadsheetUrl: mgmtMeta.url,
          ),
          finish: const {},
        ),
      );
    }
    final steps = <Map<String, Object?>>[
      {
        'k': 'addSheets',
        'names': [sheetName],
      },
      {'k': 'copy', 'sheet': sheetName, 'idCol': idCol, 'rows': rows},
      // Owner's request: their own colour (Settings), on the source rows
      // and on these copies only, to tell them apart.
      {
        'k': 'colorTargetIds',
        'sheet': sheetName,
        'idCol': idCol,
        'ids': [for (final r in rows) normalizeUserId(cellAt(r, idCol))],
        'color': opts.color,
      },
      {
        'k': 'color',
        'sheetOf': 'management',
        'rows': {for (final i in rowIndices) '$i': opts.color},
      },
      {'k': 'finishMerge'},
    ];
    final results = [
      for (var j = 0; j < rows.length; j++)
        AuditResultRow(
          userId: normalizeUserId(cellAt(rows[j], idCol)),
          title: opts.label,
          type: opts.label,
          managementRow: rows[j],
          mgmtSheetRowIndex: rowIndices[j],
          agentSheetRowIndices: const [],
          salaryValue: null,
          statusLabel: '',
          rowIndex: rowIndices[j] + 1,
        ),
    ];
    return PreparedAudit.plan(
      AuditPlan(
        cycleId: cycle.id,
        steps: steps,
        next: 0,
        result: PayrollResult(
          success: true,
          message:
              'نُقل ${rows.length} صف من ورقة الإدارة إلى ورقة «$sheetName» ولُوّنت بلون غير المذكورين',
          applied: true,
          spreadsheetUrl: mgmtMeta.url,
          results: results,
        ),
        finish: {
          'entries': [
            for (final r in results)
              {
                'id': r.userId,
                'source': 'نُقل إلى «$sheetName» من ورقة الإدارة',
                'details': {'type': opts.label, 'title': sheetName},
              },
          ],
          'agent': const <String>[],
          'mgmt': [for (final r in results) r.userId],
          'mode': 'google-unmentioned-mgmt',
        },
      ),
    );
  }

  /// A sheet amount as a number: Arabic or Persian digits, the Arabic
  /// decimal sign (٫) and thousands separators are accepted. Null when the
  /// cell is empty or not a number.
  static double? parseAmount(String? value) {
    final s = normalizeForNumber(value?.replaceAll('٫', '.'));
    if (s.isEmpty) return null;
    final n = jsParseFloat(s);
    return jsIsFiniteNumber(n) ? n : null;
  }

  /// Writes the rows added by «تدقيق غير المذكورين» right after the last
  /// row of the user-info sheet (positions fixed when the job was
  /// prepared). Repeating it rewrites the same cells; if somebody else
  /// wrote in those rows meanwhile, it stops instead of overwriting them.
  Future<void> _appendUserInfoStep(Map<String, Object?> step) async {
    final sheets = sheetsProvider();
    final ss = step['ss'] as String;
    final title = step['sheet'] as String;
    final startRow = (step['startRow'] as num).toInt();
    final idCol = (step['idCol'] as num).toInt();
    final rows = [for (final r in (step['rows'] as List)) _strings(r)];
    final endRow = startRow + rows.length - 1;
    final current = await withSheetsRetry(
      () => sheets.valuesGet(ss, rangeA1ZZ(title, startRow, endRow)),
    );
    for (var i = 0; i < current.length && i < rows.length; i++) {
      if (current[i].every((c) => c.trim().isEmpty)) continue;
      final id = normalizeUserId(cellAt(current[i], idCol));
      if (id != normalizeUserId(cellAt(rows[i], idCol))) {
        throw Exception(
          'تغيّر جدول بيانات المستخدمين بعد بدء العملية (توجد بيانات أخرى في الصف ${startRow + i}). لم يُكتب شيء فوقها؛ أعد تشغيل «تدقيق غير المذكورين».',
        );
      }
    }
    final meta = await withSheetsRetry(() => sheets.getSpreadsheet(ss));
    SheetProps? props;
    for (final s in meta.sheets) {
      if (s.title == title) props = s;
    }
    if (props == null) {
      throw Exception('الورقة «$title» غير موجودة في جدول بيانات المستخدمين.');
    }
    final gridRows = props.rowCount;
    if (gridRows != null && gridRows < endRow) {
      await withSheetsRetry(
        () => sheets.batchUpdate(ss, [
          {
            'appendDimension': {
              'sheetId': props!.sheetId,
              'dimension': 'ROWS',
              'length': endRow - gridRows,
            },
          },
        ]),
      );
    }
    for (var i = 0; i < rows.length; i += copyChunkRows) {
      final end =
          i + copyChunkRows > rows.length ? rows.length : i + copyChunkRows;
      await withSheetsRetry(
        () => sheets.valuesUpdate(
          ss,
          "'${escapeSheetTitleForRange(title)}'!A${startRow + i}",
          rows.sublist(i, end),
        ),
      );
    }
  }

  /// Colours, in a target sheet of the management spreadsheet, the rows of
  /// the given ids only (rows copied there by other steps keep theirs).
  /// Repeating it colours the same rows again.
  Future<void> _colorTargetIds(
    Map<String, Object?> step,
    AuditPlan plan,
  ) async {
    final info = await db.getCycleInfo(plan.cycleId);
    final ss = info?.managementSpreadsheetId;
    if (ss == null) return;
    final sheets = sheetsProvider();
    final name = step['sheet'] as String;
    final idCol = (step['idCol'] as num).toInt();
    final ids = {for (final x in (step['ids'] as List)) x.toString()};
    final color = step['color'] as String;
    final meta = await withSheetsRetry(() => sheets.getSpreadsheet(ss));
    final sheetId = getSheetIdByTitle(meta, name);
    if (sheetId == null) return;
    final rows = await withSheetsRetry(
      () => sheets.valuesGet(ss, rangeWholeSheet(name)),
    );
    final byRow = <int, String>{
      for (var i = 0; i < rows.length; i++)
        if (ids.contains(normalizeUserId(cellAt(rows[i], idCol)))) i: color,
    };
    if (byRow.isEmpty) return;
    final requests = mergedColorRequests(
      sheetId,
      byRow,
      colorEndColumn(meta, sheetId),
    );
    for (var i = 0; i < requests.length; i += colorBatchSize) {
      final chunk = requests.sublist(
        i,
        i + colorBatchSize > requests.length
            ? requests.length
            : i + colorBatchSize,
      );
      await withSheetsRetry(() => sheets.batchUpdate(ss, chunk));
    }
  }

  /// Saves the outcome of a «غير مذكور» job: statuses of its users and the
  /// search cache, added to what earlier audits saved (the bulk audit's
  /// `_finishPlan` replaces them). The bulk audit's hash is left alone.
  Future<void> _finishMerge(AuditPlan plan) async {
    final cycle = await db.getCycle(plan.cycleId);
    if (cycle == null) return;
    final f = plan.finish;
    await db.saveUserAuditStatuses(cycle.id, [
      for (final e in (f['entries'] as List? ?? const []))
        AuditEntry(
          (e as Map)['id'].toString(),
          'مدقق',
          e['source'] as String?,
          Map<String, Object?>.from(e['details'] as Map),
        ),
    ]);
    final cache = await db.getCycleCache(cycle.id);
    await db.saveCycleCache(
      cycle.id,
      CycleCache(
        managementData: cycle.managementRows,
        agentData: cycle.agentRows,
        managementSheetName: cycle.managementSheetName,
        agentSheetName: cycle.agentSheetName,
        auditedAgentIds: {
          ...?cache?.auditedAgentIds,
          for (final x in (f['agent'] as List? ?? const [])) x.toString(),
        },
        auditedMgmtIds: {
          ...?cache?.auditedMgmtIds,
          for (final x in (f['mgmt'] as List? ?? const [])) x.toString(),
        },
        foundInTargetSheetIds: cache?.foundInTargetSheetIds ?? <String>{},
      ),
    );
    final hash = f['hash'] as String?;
    if (hash != null && hash.isNotEmpty) {
      await db.updateCycle(cycle.id, {'payroll_audit_user_info_hash': hash});
    }
    await db.addAuditRun(
      cycle.id,
      (f['mode'] as String?) ?? 'google',
      plan.result.toLog(),
    );
  }

  // ======================================================================
  // Agent-sheet users not audited yet (owner's request, read only)
  // ======================================================================

  /// Agent name column requested by the owner (column C by default; a
  /// workspace setting).
  static const agentNameColumn = 2;

  /// Users of the cycle's agent sheet (as synced by the last audit) with no
  /// «مدقق» status in this cycle — from the bulk audit, earlier runs or the
  /// selective audit. Each id once, with its name from column C.
  Future<PendingAgentMembers> unauditedAgentMembers(int cycleId) async {
    final cycle = await db.getCycle(cycleId);
    if (cycle == null) return const PendingAgentMembers([], 0);
    final cols = await db.getCycleColumns(cycleId);
    final idIdx = columnLetterToIndex(cols.agentUserIdCol) ?? 0;
    final nameIdx =
        columnLetterToIndex((await db.getWorkspaceColumns()).agentNameCol) ??
        agentNameColumn;
    final rows = cycle.agentRows;
    final start = rows.isNotEmpty && isHeaderRowCycle(rows[0], idIdx) ? 1 : 0;
    final audited = {
      ...await db.auditedMemberIds(cycleId),
      ...await db.cacheAuditedIds(cycleId),
    };
    final seen = <String>{};
    final members = <PendingMember>[];
    for (var i = start; i < rows.length; i++) {
      final id = normalizeUserId(cellAt(rows[i], idIdx));
      if (id.isEmpty || !seen.add(id) || audited.contains(id)) continue;
      members.add(
        PendingMember(id, (cellAt(rows[i], nameIdx) ?? '').trim(), i + 1),
      );
    }
    return PendingAgentMembers(members, seen.length);
  }

  // ======================================================================
  // Shared
  // ======================================================================

  static void _setCell(List<Object?> row, int idx, Object? value) {
    while (row.length <= idx) {
      row.add('');
    }
    row[idx] = value;
  }

  /// Ids that appear on more than one data row of the user-info sheet.
  static List<DuplicateGroup> findDuplicateGroups(AuditCoreOutput out) {
    final rowsById = <String, List<int>>{};
    for (final r in out.results) {
      if (r.userId.isEmpty) continue;
      rowsById.putIfAbsent(r.userId, () => <int>[]).add(r.rowIndex);
    }
    return [
      for (final e in rowsById.entries)
        if (e.value.length > 1) DuplicateGroup(e.key, e.value),
    ];
  }

  /// ERP's `byTitle` grouping, leaving out the repeated rows of duplicated
  /// ids so each user is copied once. Without duplicates this is exactly
  /// `out.byTitle` / `out.titleOrder`.
  static ({Map<String, List<TitleItem>> byTitle, List<String> order})
  groupByTitle(AuditCoreOutput out, Set<int> skippedRows) {
    final byTitle = <String, List<TitleItem>>{};
    final insertion = <String>[];
    for (final r in out.results) {
      if (skippedRows.contains(r.rowIndex)) continue;
      final row = r.managementRow;
      if (row == null || !(isAgentType(r.type) || r.type == typeManagement)) {
        continue;
      }
      if (!byTitle.containsKey(r.title)) {
        byTitle[r.title] = <TitleItem>[];
        insertion.add(r.title);
      }
      byTitle[r.title]!.add(
        TitleItem(
          row,
          isAgentType(r.type) ? out.agentColorVal : out.mgmtColorVal,
          r.type,
        ),
      );
    }
    return (byTitle: byTitle, order: jsObjectKeyOrder(insertion));
  }

  /// [fromRow]: write only rows from this one on (the rows added by
  /// «تدقيق غير المذكورين»).
  ColumnWrites salaryStatusColumns(
    PayrollRequest req,
    AuditCoreOutput out, [
    List<DuplicateGroup> duplicates = const [],
    int? fromRow,
  ]) {
    final salaryText = req.columns.userInfoSalaryCol.trim();
    final salaryColLetter =
        salaryText.isNotEmpty ? salaryText.toUpperCase() : 'L';
    final salaryColIdx = columnLetterToIndex(salaryColLetter) ?? 11;
    final statusText = req.userInfoStatusCol?.trim() ?? '';
    final statusColLetter =
        statusText.isNotEmpty
            ? statusText.toUpperCase()
            : columnIndexToLetter(salaryColIdx + 1);
    final firstData = out.dataStart + 1;
    final minRow = fromRow != null && fromRow > firstData ? fromRow : firstData;
    final maxRow = out.dataStart + out.dataRows.length;
    final byRowSalary = <int, Object?>{};
    final byRowStatus = <int, String>{};
    for (final r in out.results) {
      if (isAgentType(r.type) || r.type == typeManagement) {
        byRowSalary[r.rowIndex] =
            r.salaryValue == null ? '' : _num(r.salaryValue!);
        byRowStatus[r.rowIndex] = r.statusLabel;
      } else if (r.type == typeNotFound) {
        byRowSalary[r.rowIndex] = 0;
        byRowStatus[r.rowIndex] = typeNotFound;
      } else if (r.type == typeNoSalary) {
        byRowSalary[r.rowIndex] = 0;
        byRowStatus[r.rowIndex] = statusNoSalary;
      }
    }
    // Repeated rows of a duplicated id: no salary (it belongs to the first
    // row) and a status that points at the audited row.
    for (final d in duplicates) {
      for (final row in d.skippedRows) {
        byRowSalary[row] = '';
        byRowStatus[row] = 'مكرر (الصف ${d.firstRow})';
      }
    }
    final salaryValues = <List<Object?>>[];
    final statusValues = <List<Object?>>[];
    for (var r = minRow; r <= maxRow; r++) {
      salaryValues.add([byRowSalary.containsKey(r) ? byRowSalary[r] : '']);
      statusValues.add([byRowStatus[r] ?? '']);
    }
    return ColumnWrites(
      salaryColLetter: salaryColLetter,
      statusColLetter: statusColLetter,
      minRow: minRow,
      maxRow: maxRow,
      salaryValues: salaryValues,
      statusValues: statusValues,
    );
  }

  static num _num(double v) =>
      v == v.truncateToDouble() && v.abs() < 1e15 ? v.toInt() : v;

  static ({Map<int, String> mgmt, Map<int, String> agent}) sourceColors(
    AuditCoreOutput out, {
    int? fromRow,
    Set<String>? onlyIds,
  }) {
    final mgmt = <int, String>{};
    final agent = <int, String>{};
    for (final r in out.results) {
      if (fromRow != null && r.rowIndex < fromRow) continue;
      if (onlyIds != null && !onlyIds.contains(r.userId)) continue;
      if (isAgentType(r.type) && r.mgmtSheetRowIndex != null) {
        mgmt[r.mgmtSheetRowIndex!] = out.agentColorVal;
      } else if (r.type == typeManagement && r.mgmtSheetRowIndex != null) {
        mgmt[r.mgmtSheetRowIndex!] = out.mgmtColorVal;
      }
      // «بدون راتب» (3.4.0) was found in the agent sheet: its rows are
      // audited and coloured like the agent's.
      if (isAgentType(r.type) || r.type == typeNoSalary) {
        for (final idx in r.agentSheetRowIndices) {
          agent[idx] = out.agentColorVal;
        }
      }
    }
    return (mgmt: mgmt, agent: agent);
  }

  /// Statuses, search cache and hash saved when every write is done
  /// (ERP saves them at the end of payroll-execute).
  static Map<String, Object?> finishData(
    AuditCoreOutput out,
    String userInfoHash, {
    int? fromRow,
    Set<String>? onlyIds,
  }) {
    final auditedAgent = <String>{};
    final auditedMgmt = <String>{};
    final entries = <Map<String, Object?>>[];
    for (final r in out.results) {
      if (fromRow != null && r.rowIndex < fromRow) continue;
      if (onlyIds != null && !onlyIds.contains(r.userId)) continue;
      // «بدون راتب» (3.4.0) was found in the agent sheet: audited there.
      final agentLike = isAgentType(r.type) || r.type == typeNoSalary;
      if (agentLike && r.userId.isNotEmpty) {
        auditedAgent.add(r.userId);
      }
      if (r.type == typeManagement && r.userId.isNotEmpty) {
        auditedMgmt.add(r.userId);
      }
      if (r.userId.isNotEmpty && (agentLike || r.type == typeManagement)) {
        entries.add({
          'id': r.userId,
          'source':
              agentLike ? 'تدقيق وكيل من النظام' : 'تدقيق ادارة من النظام',
          'details': {
            'type': r.type,
            'title': r.title,
            'salaryAfterDiscount':
                r.salaryValue == null ? '' : _num(r.salaryValue!),
          },
        });
      }
    }
    return {
      'entries': entries,
      'agent': auditedAgent.toList(),
      'mgmt': auditedMgmt.toList(),
      'hash': userInfoHash,
    };
  }

  PayrollResult buildResult({
    required AuditCoreOutput out,
    required String? spreadsheetUrl,
    required bool cycleSynced,
    required bool localOnly,
    required List<DuplicateGroup> duplicates,
  }) {
    final summary = out.summary;
    final appliedCount = summary.agent + summary.management + summary.noSalary;
    var message =
        localOnly ? 'تم تنفيذ التدقيق على الهاتف' : 'تم تنفيذ التدقيق';
    if (summary.total == 0) {
      message =
          'لم تُقرأ أي صفوف من جدول بيانات المستخدمين. تحقق من أن الورقة تحتوي بيانات وأن عمود رقم المستخدم وعمود اسم الورقة مملوءان.';
    } else if (appliedCount == 0) {
      message =
          out.mgmtDataRows.isEmpty
              // Audit without the management sheet (3.4.0).
              ? 'لم يُطابق أي صف (0 سحب وكالة، 0 بدون راتب). يُقارن رقم المستخدم من عمود بيانات المستخدمين مع عمود الوكيل. تحقق من تطابق الأرقام أو من اختيار الأعمدة الصحيحة (انظر العينة أدناه).'
              : 'لم يُطابق أي صف (0 سحب وكالة، 0 سحب إدارة). يُقارن رقم المستخدم من عمود بيانات المستخدمين مع عمودي الإدارة والوكيل. تحقق من تطابق الأرقام أو من اختيار الأعمدة الصحيحة (انظر العينة أدناه).';
    }

    final sampleUserIds = <String>[];
    final sampleMgmtIds = <String>[];
    final sampleAgentIds = <String>[];
    PayrollDiagnostic? diagnostic;
    if (appliedCount == 0 && summary.total > 0) {
      void sample(Rows rows, int col, List<String> into) {
        final seen = <String>{};
        for (final r in rows) {
          final id = normalizeUserId(cellAt(r, col));
          if (id.isNotEmpty && seen.add(id)) {
            into.add(id);
            if (into.length >= 12) break;
          }
        }
      }

      sample(out.dataRows, out.colC, sampleUserIds);
      sample(out.mgmtDataRows, out.cycleMgmtCol, sampleMgmtIds);
      sample(out.agentDataRows, out.cycleAgentCol, sampleAgentIds);
      diagnostic = PayrollDiagnostic(
        managementUniqueCount: out.mgmtByUserId.length,
        agentUniqueCount: out.agentByUserId.length,
        userInfoUniqueCount:
            {
              for (final r in out.results)
                if (r.userId.isNotEmpty) r.userId,
            }.length,
        sampleCheck: [
          for (final uid in sampleUserIds.take(5))
            SampleCheck(
              uid,
              out.mgmtByUserId.containsKey(uid),
              out.agentByUserId.containsKey(uid),
            ),
        ],
      );
    }
    return PayrollResult(
      success: true,
      message: message,
      summary: summary,
      applied: appliedCount > 0,
      cycleSynced: cycleSynced,
      localOnly: localOnly,
      spreadsheetUrl: spreadsheetUrl,
      results: out.results,
      sampleUserIds: sampleUserIds,
      sampleMgmtIds: sampleMgmtIds,
      sampleAgentIds: sampleAgentIds,
      diagnostic: diagnostic,
      duplicates: duplicates,
    );
  }
}

Map<String, dynamic> colorRowRequest(
  int sheetId,
  int rowIdx,
  String color, {
  int endColumn = 200,
}) => colorRangeRequest(sheetId, rowIdx, rowIdx + 1, color, endColumn);

Map<String, dynamic> colorRangeRequest(
  int sheetId,
  int startRow,
  int endRow,
  String color,
  int endColumn,
) => {
  'repeatCell': {
    'range': {
      'sheetId': sheetId,
      'startRowIndex': startRow,
      'endRowIndex': endRow,
      'startColumnIndex': 0,
      'endColumnIndex': endColumn,
    },
    'cell': {
      'userEnteredFormat': {'backgroundColor': hexToRgb(color)},
    },
    'fields': 'userEnteredFormat.backgroundColor',
  },
};

/// Same colours as ERP's one-request-per-row list, with consecutive rows
/// of the same colour merged into a single range.
List<Map<String, dynamic>> mergedColorRequests(
  int sheetId,
  Map<int, String> byRow,
  int endColumn,
) {
  final rows = byRow.keys.toList()..sort();
  final out = <Map<String, dynamic>>[];
  var i = 0;
  while (i < rows.length) {
    final start = rows[i];
    final color = byRow[start]!;
    var end = start + 1;
    var j = i + 1;
    while (j < rows.length && rows[j] == end && byRow[rows[j]] == color) {
      end++;
      j++;
    }
    out.add(colorRangeRequest(sheetId, start, end, color, endColumn));
    i = j;
  }
  return out;
}

class ColumnWrites {
  const ColumnWrites({
    required this.salaryColLetter,
    required this.statusColLetter,
    required this.minRow,
    required this.maxRow,
    required this.salaryValues,
    required this.statusValues,
  });
  final String salaryColLetter;
  final String statusColLetter;
  final int minRow;
  final int maxRow;
  final List<List<Object?>> salaryValues;
  final List<List<Object?>> statusValues;
}

class TargetRow {
  TargetRow(this.values, this.color);
  final List<String> values;
  final String? color;
}

/// The phone-side equivalent of the Google spreadsheets the ERP audit
/// writes to: target sheets, source row colors and the user-info table
/// with salary/status filled in. Exported as one Excel workbook.
class LocalWorkbookState {
  LocalWorkbookState({
    Map<String, List<TargetRow>>? targets,
    Map<int, String>? mgmtColors,
    Map<int, String>? agentColors,
    this.userInfoFileName,
    this.userInfoSheetName,
    this.userInfoRows,
  }) : targets = targets ?? <String, List<TargetRow>>{},
       mgmtColors = mgmtColors ?? <int, String>{},
       agentColors = agentColors ?? <int, String>{};

  final Map<String, List<TargetRow>> targets;
  final Map<int, String> mgmtColors;
  final Map<int, String> agentColors;
  String? userInfoFileName;
  String? userInfoSheetName;
  List<List<Object?>>? userInfoRows;

  bool get isEmpty =>
      targets.isEmpty &&
      mgmtColors.isEmpty &&
      agentColors.isEmpty &&
      userInfoRows == null;

  Map<String, Object?> toJson() => {
    'targets': [
      for (final e in targets.entries)
        {
          'name': e.key,
          'rows': [
            for (final r in e.value) {'v': r.values, 'c': r.color},
          ],
        },
    ],
    'mgmtColors': {for (final e in mgmtColors.entries) '${e.key}': e.value},
    'agentColors': {for (final e in agentColors.entries) '${e.key}': e.value},
    'userInfoFileName': userInfoFileName,
    'userInfoSheetName': userInfoSheetName,
    'userInfoRows': userInfoRows,
  };

  static LocalWorkbookState fromJson(Map<String, Object?>? j) {
    if (j == null) return LocalWorkbookState();
    final targets = <String, List<TargetRow>>{};
    for (final t in (j['targets'] as List? ?? const [])) {
      final m = t as Map;
      targets[m['name'].toString()] = [
        for (final r in (m['rows'] as List? ?? const []))
          TargetRow([
            for (final c in ((r as Map)['v'] as List? ?? const []))
              c?.toString() ?? '',
          ], r['c'] as String?),
      ];
    }
    Map<int, String> colors(Object? v) => {
      if (v is Map)
        for (final e in v.entries)
          int.parse(e.key.toString()): e.value.toString(),
    };
    final ui = j['userInfoRows'];
    return LocalWorkbookState(
      targets: targets,
      mgmtColors: colors(j['mgmtColors']),
      agentColors: colors(j['agentColors']),
      userInfoFileName: j['userInfoFileName'] as String?,
      userInfoSheetName: j['userInfoSheetName'] as String?,
      userInfoRows:
          ui is List
              ? [
                for (final r in ui)
                  if (r is List) List<Object?>.from(r) else <Object?>[],
              ]
              : null,
    );
  }
}

String formatNumber(num v) => jsNumberToString(v);
