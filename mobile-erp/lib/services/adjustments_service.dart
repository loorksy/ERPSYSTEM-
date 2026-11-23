import '../data/app_database.dart';
import '../erp/js_compat.dart';
import '../erp/normalize.dart';
import '../erp/payroll_audit_engine.dart';
import '../google/sheets_client.dart';

/// «إضافات وخصومات» — port of ERP `services/memberAdjustmentSheetOps.js`
/// (bulk only, without the advanced accounting registration, owner's
/// decision 2026-11-17). Separate from the audit.
///
/// ERP reads the sheet, then for each pasted line (id, type, amount) finds
/// the user's first row and applies `computeSheetOp` to its salary, writing
/// the new salary and a status text in the chosen columns. Lines are applied
/// in order on the updated salary.
///
/// Owner's change: when one user has both additions and deductions in the
/// list, they are first netted (مقاصة) into one operation at the place of
/// the user's first line, and the status cell says what was done (تم خصم /
/// تم اضافة) followed by the settlement. Since 3.3.0 (owner, 2026-11-18)
/// repeated lines of one type are merged the same way (دمج: 12 + 12), so
/// every user has one result. «خصم كامل» lines are not netted.
///
/// Owner's second system (3.3.0, chosen in the settings): the salary column
/// is only read; the salary after the adjustments goes to a chosen column,
/// with «الحالة»، «حالة المستخدم» and «العملية الحسابية» in the three
/// columns after it (to its left in a right-to-left sheet).
///
/// The app computes everything first (same values as ERP's line-by-line
/// writes) and writes the final cells in batches, as a resumable job.
class AdjustmentsService {
  AdjustmentsService(this.db, this.sheetsProvider);

  final AppDatabase db;
  final SheetsApi Function() sheetsProvider;

  /// ERP defaults of the page (`DEFAULT_COLS`).
  static const defaultIdCol = 'C';
  static const defaultSalaryCol = 'L';
  static const defaultStatusCol = 'O';

  static const cellsPerRequest = 2000;

  /// Second system (3.3.0): headers of the three columns after the chosen
  /// column, and of the chosen column when its header is empty.
  static const outputHeader = 'الراتب بعد التسوية';
  static const stateHeader = 'الحالة';
  static const userStateHeader = 'حالة المستخدم';
  static const expressionHeader = 'العملية الحسابية';

  /// Which system the adjustments screen shows (owner, 3.3.0): the first
  /// (the salary column is updated) unless the second is chosen in the
  /// settings; only one is offered at a time. Per workspace.
  static const systemKey = 'adjustmentsSystemV1';

  Future<bool> columnSystem() async => await db.getValue(systemKey) == 'column';

  Future<void> setColumnSystem(bool on) =>
      db.setValue(systemKey, on ? 'column' : 'replace');

  /// Light green and light red of the Google Sheets palette.
  static const toneGreen = '#b6d7a8';
  static const toneRed = '#ea9999';

  Future<AdjustPlan> prepare(
    AdjustRequest req,
    void Function(String) progress,
  ) async {
    final ssId = req.spreadsheetId.trim();
    final title = req.sheetName.trim();
    if (ssId.isEmpty) return AdjustPlan.fail('اختر ملف جدول البيانات');
    if (title.isEmpty) return AdjustPlan.fail('اختر الورقة المطلوبة');
    final uidCol = columnLetterToIndex(req.idCol) ?? 2;
    final salCol = columnLetterToIndex(req.salaryCol) ?? 11;
    final stCol = columnLetterToIndex(req.statusCol) ?? 14;
    final outCol =
        req.outputCol.trim().isEmpty
            ? null
            : columnLetterToIndex(req.outputCol.trim());
    if (outCol != null) {
      final written = {outCol, outCol + 1, outCol + 2, outCol + 3};
      if (salCol == uidCol ||
          written.contains(uidCol) ||
          written.contains(salCol)) {
        return AdjustPlan.fail(
          'عمود الراتب بعد التسوية والأعمدة الثلاثة بعده يجب ألا تشمل عمود المعرّف أو عمود الراتب.',
        );
      }
    } else if (req.outputCol.trim().isNotEmpty) {
      return AdjustPlan.fail('اختر عمود الراتب بعد التسوية.');
    } else if (salCol == stCol || salCol == uidCol || stCol == uidCol) {
      return AdjustPlan.fail('أعمدة ID والراتب والحالة يجب أن تكون مختلفة.');
    }
    final sheets = sheetsProvider();
    progress('قراءة الورقة «$title»...');
    final meta = await withSheetsRetry(() => sheets.getSpreadsheet(ssId));
    requireSheet(meta, title, 'جدول الرواتب');
    // ERP reads from row 1 in batches; with the grid size no rows are lost
    // after a gap on a batch edge (same fix as the audit).
    final rows = await fetchSheetValuesBatched(
      sheets,
      ssId,
      title,
      rowCount: sheetRowCount(meta, title),
    );
    final computed = computeBulk(
      req.bulkData,
      rows,
      uidCol: uidCol,
      salCol: salCol,
      stCol: stCol,
    );
    final esc = escapeSheetTitleForRange(title);
    final salLetter = columnIndexToLetter(salCol);
    final stLetter = columnIndexToLetter(stCol);
    final rowsOut = [
      for (final w in computed.writes)
        [w.row, w.originalSalary, w.salary, w.status],
    ];
    final steps = <Map<String, Object?>>[];
    if (outCol != null) {
      steps.addAll(
        _columnSteps(
          ssId,
          title,
          rows,
          computed.writes,
          uidCol: uidCol,
          salCol: salCol,
          outCol: outCol,
        ),
      );
    } else if (rowsOut.isNotEmpty) {
      steps.add({
        'k': 'adjCheck',
        'ss': ssId,
        'range': "'$esc'!$salLetter",
        'rows': rowsOut,
      });
      final perStep = cellsPerRequest ~/ 2;
      for (var i = 0; i < rowsOut.length; i += perStep) {
        steps.add({
          'k': 'adjWrite',
          'ss': ssId,
          'sheet': esc,
          'sal': salLetter,
          'st': stLetter,
          'rows': rowsOut.sublist(
            i,
            i + perStep > rowsOut.length ? rowsOut.length : i + perStep,
          ),
        });
      }
    }
    return AdjustPlan(
      steps: steps,
      next: 0,
      result: AdjustOutcome(
        success: true,
        message:
            computed.results.isEmpty
                ? 'لم تُقرأ أي أسطر صالحة (رقم ← نوع ← مبلغ).'
                : 'طُبّقت ${computed.results.length} عملية',
        results: computed.results,
        summary: summarize(computed.results),
        spreadsheetUrl: meta.url,
        lines: sheetLines(req.bulkData, computed),
        settlements: computed.settlements,
      ),
    );
  }

  /// The pasted lines as ERP splits them, each with its result; trailing
  /// blank lines are dropped.
  static List<AdjustSheetLine> sheetLines(String bulkData, BulkComputation c) {
    final all = bulkData.split('\n');
    var last = all.length - 1;
    while (last >= 0 && all[last].trim().isEmpty) {
      last--;
    }
    return [
      for (var n = 0; n <= last; n++)
        AdjustSheetLine(
          _cellsOf(all[n]),
          c.lineResult[n] ?? -1,
          c.mergedInto[n] ?? -1,
        ),
    ];
  }

  static List<String> _cellsOf(String line) {
    if (line.trim().isEmpty) return const [];
    var parts = line.split('\t');
    if (parts.length < 2) parts = line.trim().split(RegExp(r'\s{2,}|\s+'));
    return [for (final p in parts.take(3)) p.trim()];
  }

  /// The steps of the second system: the same check that the salaries did
  /// not change, the headers (and enough columns), the four cells of each
  /// user's row, then the colours. The salary column is never written, so
  /// running the same list again gives the same cells.
  static List<Map<String, Object?>> _columnSteps(
    String ssId,
    String title,
    List<List<String>> rows,
    List<AdjustWrite> writes, {
    required int uidCol,
    required int salCol,
    required int outCol,
  }) {
    if (writes.isEmpty) return const [];
    final esc = escapeSheetTitleForRange(title);
    final hasHeader = rows.isNotEmpty && isHeaderRowUserInfo(rows[0], uidCol);
    final current = hasHeader ? (cellAt(rows[0], outCol) ?? '').trim() : '';
    final steps = <Map<String, Object?>>[
      {
        'k': 'adjCheck',
        'ss': ssId,
        'range': "'$esc'!${columnIndexToLetter(salCol)}",
        'rows': [
          for (final w in writes) [w.row, w.originalSalary, w.originalSalary],
        ],
      },
      {
        'k': 'adjHead',
        'ss': ssId,
        'sheet': title,
        'out': outCol,
        'head':
            hasHeader
                ? [
                  current.isEmpty ? outputHeader : current,
                  stateHeader,
                  userStateHeader,
                  expressionHeader,
                ]
                : null,
      },
    ];
    final cells = [
      for (final w in writes)
        [
          w.row,
          _num(round2(w.salary)),
          w.state,
          w.userState,
          w.expression,
          w.tone,
        ],
    ];
    const perStep = cellsPerRequest ~/ 4;
    for (var i = 0; i < cells.length; i += perStep) {
      steps.add({
        'k': 'adjOut',
        'ss': ssId,
        'sheet': esc,
        'out': outCol,
        'rows': cells.sublist(
          i,
          i + perStep > cells.length ? cells.length : i + perStep,
        ),
      });
    }
    steps.add({
      'k': 'adjTone',
      'ss': ssId,
      'sheet': title,
      'out': outCol,
      'rows': [
        for (final w in writes) [w.row, w.tone, w.owes ? 'r' : 'g'],
      ],
    });
    return steps;
  }

  static num _num(double v) =>
      v == v.truncateToDouble() && v.abs() < 1e15 ? v.toInt() : v;

  /// Runs step [index]; repeating a step writes the same cells again.
  Future<void> runStep(
    AdjustPlan plan,
    int index,
    void Function(String) progress,
  ) async {
    final step = plan.steps[index];
    final sheets = sheetsProvider();
    switch (step['k']) {
      case 'adjHead':
        progress('تجهيز أعمدة الراتب بعد التسوية...');
        await _headStep(sheets, step);
        return;
      case 'adjOut':
        final rows = step['rows'] as List;
        progress('كتابة ${rows.length} صف...');
        final sheet = step['sheet'] as String;
        final out = (step['out'] as num).toInt();
        final a = columnIndexToLetter(out), d = columnIndexToLetter(out + 3);
        await withSheetsRetry(
          () => sheets.valuesBatchUpdate(step['ss'] as String, [
            for (final r in rows.cast<List>())
              (
                "'$sheet'!$a${r[0]}:$d${r[0]}",
                [
                  [
                    r[1],
                    r[2],
                    r[3],
                    // Kept as text: Google would read «12 - 12» as a date.
                    '${r[4]}'.isEmpty ? '' : "'${r[4]}",
                  ],
                ],
              ),
          ]),
        );
        return;
      case 'adjTone':
        progress('تلوين الراتب بعد التسوية وحالة المستخدم...');
        await _toneStep(sheets, step);
        return;
    }
    final rows = [
      for (final r in (step['rows'] as List))
        (r as List).map((e) => e?.toString() ?? '').toList(),
    ];
    if (step['k'] == 'adjCheck') {
      progress('التحقق من أن الرواتب لم تتغير...');
      await _check(sheets, step['ss'] as String, step['range'] as String, rows);
      return;
    }
    progress('كتابة ${rows.length} صف...');
    final sheet = step['sheet'] as String;
    await withSheetsRetry(
      () => sheets.valuesBatchUpdate(step['ss'] as String, [
        for (final r in rows) ...[
          (
            "'$sheet'!${step['sal']}${r[0]}",
            [
              [r[2]],
            ],
          ),
          (
            "'$sheet'!${step['st']}${r[0]}",
            [
              [r[3]],
            ],
          ),
        ],
      ]),
    );
  }

  /// The four columns exist in the grid, and their headers are written in
  /// the header row (when the sheet has one).
  Future<void> _headStep(SheetsApi sheets, Map<String, Object?> step) async {
    final ss = step['ss'] as String;
    final title = step['sheet'] as String;
    final out = (step['out'] as num).toInt();
    final meta = await withSheetsRetry(() => sheets.getSpreadsheet(ss));
    final props = meta.sheets.where((p) => p.title == title).firstOrNull;
    if (props == null) {
      throw AdjustmentConflict('الورقة «$title» غير موجودة في الجدول.');
    }
    final need = out + 4;
    final have = props.columnCount;
    if (have != null && have < need) {
      await withSheetsRetry(
        () => sheets.batchUpdate(ss, [
          {
            'appendDimension': {
              'sheetId': props.sheetId,
              'dimension': 'COLUMNS',
              'length': need - have,
            },
          },
        ]),
      );
    }
    final head = step['head'];
    if (head is List) {
      final esc = escapeSheetTitleForRange(title);
      await withSheetsRetry(
        () => sheets.valuesUpdate(
          ss,
          "'$esc'!${columnIndexToLetter(out)}1:${columnIndexToLetter(out + 3)}1",
          [List<Object?>.from(head)],
        ),
      );
    }
  }

  /// Green or red background on the salary after the adjustments and on
  /// «حالة المستخدم»; consecutive rows of one colour are one request.
  Future<void> _toneStep(SheetsApi sheets, Map<String, Object?> step) async {
    final ss = step['ss'] as String;
    final title = step['sheet'] as String;
    final out = (step['out'] as num).toInt();
    final meta = await withSheetsRetry(() => sheets.getSpreadsheet(ss));
    final sheetId = getSheetIdByTitle(meta, title);
    if (sheetId == null) return;
    final rows = [for (final r in (step['rows'] as List)) r as List];
    final requests = <Map<String, dynamic>>[];
    void column(int col, int field) {
      final byRow = <int, String>{
        for (final r in rows) (r[0] as num).toInt(): '${r[field]}',
      };
      final keys = byRow.keys.toList()..sort();
      var i = 0;
      while (i < keys.length) {
        final first = keys[i];
        final tone = byRow[first]!;
        var j = i + 1;
        while (j < keys.length &&
            keys[j] == keys[j - 1] + 1 &&
            byRow[keys[j]] == tone) {
          j++;
        }
        requests.add({
          'repeatCell': {
            'range': {
              'sheetId': sheetId,
              'startRowIndex': first - 1,
              'endRowIndex': keys[j - 1],
              'startColumnIndex': col,
              'endColumnIndex': col + 1,
            },
            'cell': {
              'userEnteredFormat':
                  tone.isEmpty
                      ? <String, Object?>{}
                      : {
                        'backgroundColor': hexToRgb(
                          tone == 'g' ? toneGreen : toneRed,
                        ),
                      },
            },
            'fields': 'userEnteredFormat.backgroundColor',
          },
        });
        i = j;
      }
    }

    column(out, 1);
    column(out + 2, 2);
    for (var i = 0; i < requests.length; i += 5000) {
      final part = requests.sublist(
        i,
        i + 5000 > requests.length ? requests.length : i + 5000,
      );
      await withSheetsRetry(() => sheets.batchUpdate(ss, part));
    }
  }

  /// Stops before writing if someone changed a salary since the sheet was
  /// read (a job may wait hours for the internet): the computed values would
  /// be applied twice otherwise. Cells already written by this job pass.
  Future<void> _check(
    SheetsApi sheets,
    String ss,
    String range,
    List<List<String>> rows,
  ) async {
    var first = rows.first[0], last = rows.first[0];
    for (final r in rows) {
      if (int.parse(r[0]) < int.parse(first)) first = r[0];
      if (int.parse(r[0]) > int.parse(last)) last = r[0];
    }
    final m = RegExp(r"^(.*)!([A-Z]+)$").firstMatch(range)!;
    final values = await withSheetsRetry(
      () => sheets.valuesGet(
        ss,
        '${m.group(1)}!${m.group(2)}$first:${m.group(2)}$last',
      ),
    );
    final start = int.parse(first);
    for (final r in rows) {
      final i = int.parse(r[0]) - start;
      final now = i < values.length && values[i].isNotEmpty ? values[i][0] : '';
      final cur = round2(parseSalaryCellNumber(now));
      if (cur != round2(parseSalaryCellNumber(r[1])) &&
          cur != round2(parseSalaryCellNumber(r[2]))) {
        throw AdjustmentConflict(
          'تغيّر الراتب في الصف ${r[0]} بعد قراءة الورقة. لم يُكتب شيء؛ أعد معالجة القائمة.',
        );
      }
    }
  }

  // ======================================================================
  // ERP logic (memberAdjustmentSheetOps.js)
  // ======================================================================

  /// ERP `round2`: `Math.round((parseFloat(num) || 0) * 100) / 100`.
  static double round2(Object? value) {
    final double n;
    if (value is num) {
      n = value.toDouble();
    } else {
      n = jsParseFloat(value?.toString() ?? '');
    }
    final v = n.isNaN || n == 0 ? 0.0 : n;
    return jsRound(v * 100) / 100;
  }

  /// ERP `parseLocaleDecimal` (payrollSearchService.js).
  static double parseLocaleDecimal(Object? val) {
    if (val == null || val == '') return double.nan;
    if (val is num) return val.isFinite ? val.toDouble() : double.nan;
    var s =
        val
            .toString()
            .replaceAll(
              RegExp('[\u200B-\u200D\u2060\uFEFF\u200E\u200F\u202A-\u202E]'),
              '',
            )
            .trim();
    const arabic = '٠١٢٣٤٥٦٧٨٩';
    const persian = '۰۱۲۳۴۵۶۷۸۹';
    for (var i = 0; i < 10; i++) {
      s = s.replaceAll(arabic[i], '$i').replaceAll(persian[i], '$i');
    }
    s = s
        .replaceAll(RegExp(r'\s'), '')
        .replaceAll(r'$', '')
        .replaceAll(RegExp('USD', caseSensitive: false), '');
    final lastComma = s.lastIndexOf(',');
    final lastDot = s.lastIndexOf('.');
    if (lastComma >= 0 && lastDot < 0) {
      final parts = s.split(',');
      // ERP's regex /^\d*$\.?\d*$/ only matches digits.
      if (parts.length == 2 &&
          parts[1].length <= 2 &&
          RegExp(r'^\d*$').hasMatch(parts[0])) {
        s = '${parts[0]}.${parts[1]}';
      } else {
        s = s.replaceAll(',', '');
      }
    } else if (lastDot >= 0 && lastComma >= 0) {
      if (lastDot > lastComma) {
        s = s.replaceAll(',', '');
      } else {
        s = s.replaceAll('.', '').replaceFirst(',', '.');
      }
    } else {
      s = s.replaceAll(',', '');
    }
    final n = jsParseFloat(s);
    return n.isNaN || !n.isFinite ? double.nan : n;
  }

  /// ERP `parseSalaryCellNumber`.
  static double parseSalaryCellNumber(Object? v) {
    final n = parseLocaleDecimal(v);
    return n.isFinite ? n : 0;
  }

  /// ERP `computeSheetOp`.
  static SheetOp computeSheetOp({
    required double currentSalary,
    required String type,
    required String? amountRaw,
  }) {
    final typeStr = type.trim();
    final amountStr = amountRaw == null ? '' : amountRaw.trim();
    final isFullDeduction =
        typeStr.contains('خصم كامل') || amountStr.contains('خصم كامل');
    var amountNum = 0.0;
    if (!isFullDeduction) amountNum = round2(amountStr.replaceFirst(',', '.'));

    final cur = round2(currentSalary);
    var status = 'تم التحديث';
    var displayed = amountNum;
    var added = 0.0, deducted = 0.0, debt = 0.0, zeroSalAmt = 0.0;
    var newSalary = cur;
    var statusText = '';
    final amt = jsNumberToString(amountNum);

    if (isFullDeduction || typeStr == 'خصم') {
      if (isFullDeduction) {
        deducted = cur > 0 ? cur : 0;
        status = 'تم خصم الدين';
        displayed = deducted;
        newSalary = 0;
        statusText = 'تم خصم الدين';
      } else {
        if (cur <= 0) {
          debt = 0;
          zeroSalAmt = amountNum;
          status = 'سحب ادارة';
          displayed = amountNum;
          newSalary = 0;
        } else if (cur < amountNum) {
          debt = round2(amountNum - cur);
          if (debt < 1) {
            debt = 0;
            deducted = cur;
            status = 'تم الخصم بالكامل';
            displayed = amountNum;
          } else {
            deducted = cur;
            status = 'باقي عليه';
            displayed = debt;
          }
          newSalary = 0;
        } else {
          deducted = amountNum;
          newSalary = round2(cur - amountNum);
          status = 'تم الخصم بالكامل';
        }
        statusText = 'تم خصم $amt';
      }
    } else {
      // إضافة (أو أي نوع غير الخصم)
      added = amountNum;
      newSalary = round2(cur + amountNum);
      status = 'تمت الإضافة';
      statusText = 'تم اضافة $amt';
    }
    return SheetOp(
      AdjustResult(
        id: '',
        status: status,
        amount: displayed,
        added: added,
        deducted: deducted,
        debt: debt,
        zeroSalAmt: zeroSalAmt,
      ),
      newSalary,
      statusText,
      amountNum,
      isFullDeduction,
    );
  }

  /// ERP's line parsing in `processSheetBulk`: Tab-separated (or spaces)
  /// id, type, amount; «خصم كامل» needs no amount.
  static List<AdjustLine> parseLines(String bulkData) {
    final out = <AdjustLine>[];
    final all = bulkData.split('\n');
    for (var n = 0; n < all.length; n++) {
      final line = all[n];
      if (line.trim().isEmpty) continue;
      var parts = line.split('\t');
      if (parts.length < 2) parts = line.trim().split(RegExp(r'\s{2,}|\s+'));
      if (parts.length < 2) continue;
      final userId = parts[0].trim();
      final type = parts[1].trim();
      var full = type.contains('خصم كامل');
      var amountNum = 0.0;
      var amountRaw = '';
      if (parts.length >= 3) {
        amountRaw = parts[2].trim();
        if (amountRaw.contains('خصم كامل')) {
          full = true;
        } else if (!full) {
          amountNum = round2(amountRaw.replaceFirst(',', '.'));
        }
      }
      if (!full && parts.length < 3) continue;
      out.add(AdjustLine(userId, type, amountRaw, full, amountNum, n));
    }
    return out;
  }

  /// ERP `processSheetBulk` on rows already read, with the owner's
  /// settlement. Returns the results (ERP order) and the final cells.
  /// [settle] false gives ERP's exact line-by-line result (used to check
  /// the port against ERP's JavaScript).
  static BulkComputation computeBulk(
    String bulkData,
    List<List<String>> rows, {
    int uidCol = 2,
    int salCol = 11,
    int stCol = 14,
    bool settle = true,
  }) {
    final dataStart =
        rows.isNotEmpty && isHeaderRowUserInfo(rows[0], uidCol) ? 1 : 0;
    final index = <String, int>{};
    for (var i = dataStart; i < rows.length; i++) {
      final raw = cellAt(rows[i], uidCol);
      final n = normalizeUserId(raw);
      final key = n.isNotEmpty ? n : (raw ?? '').trim();
      if (key.isNotEmpty && !index.containsKey(key)) index[key] = i;
    }
    int? rowOf(String userId) {
      final n = normalizeUserId(userId);
      return index[n.isNotEmpty ? n : userId];
    }

    // Owner's settlement: the lines of one user (additions and deductions,
    // or repeated lines of one type) become one operation at the place of
    // the user's first line.
    final lines = parseLines(bulkData);
    final ops = <_Op>[];
    final settled = <int, _Op>{};
    final mergedInto = <int, int>{};
    final byRow = <int, List<AdjustLine>>{};
    for (final l in lines) {
      final r = rowOf(l.userId);
      if (r != null && !l.full) byRow.putIfAbsent(r, () => []).add(l);
    }
    for (final l in lines) {
      final r = rowOf(l.userId);
      final mine = r == null ? null : byRow[r];
      final grouped = settle && mine != null && mine.length > 1;
      if (!l.full && grouped) {
        if (settled.containsKey(r)) {
          // Merged into the settlement on the user's first line.
          mergedInto[l.lineNo] = settled[r]!.line.lineNo;
          continue;
        }
        var add = 0.0, ded = 0.0;
        for (final x in mine) {
          if (x.isDeduction) {
            ded += x.amountNum;
          } else {
            add += x.amountNum;
          }
        }
        final op = _Op(
          l,
          r,
          round2(add),
          round2(ded),
          mixed:
              mine.any((x) => x.isDeduction) && mine.any((x) => !x.isDeduction),
          parts: mine,
        );
        settled[r!] = op;
        ops.add(op);
      } else {
        ops.add(_Op(l, r, null, null));
      }
    }

    final results = <AdjustResult>[];
    final lineResult = <int, int>{};
    final settlements = <AdjustSettlement>[];
    final salaryNow = <int, double>{};
    final finalCells = <int, AdjustWrite>{};
    for (final op in ops) {
      final l = op.line;
      final found = op.row;
      lineResult[l.lineNo] = results.length;
      if (op.isSettlement && op.mixed) {
        settlements.add(
          AdjustSettlement(
            l.userId,
            op.add!,
            op.ded!,
            round2(op.add! - op.ded!),
          ),
        );
      }
      if (found == null) {
        final amt = l.full ? 0.0 : l.amountNum;
        results.add(
          AdjustResult(
            id: l.userId,
            status: 'غير موجود',
            amount: amt,
            notFoundAmt: amt,
          ),
        );
        continue;
      }
      final current =
          salaryNow[found] ??
          parseSalaryCellNumber(cellAt(rows[found], salCol));
      SheetOp computed;
      String? settlement;
      String? merged;
      if (op.isSettlement && !op.mixed) {
        // Repeated lines of one type: their total, applied once.
        final ded = op.parts.first.isDeduction;
        merged = op.parts.map((x) => jsNumberToString(x.amountNum)).join(' + ');
        computed = computeSheetOp(
          currentSalary: current,
          type: ded ? 'خصم' : 'اضافة',
          amountRaw: jsNumberToString(ded ? op.ded! : op.add!),
        );
      } else if (op.isSettlement) {
        final net = round2(op.add! - op.ded!);
        settlement =
            'إضافة ${jsNumberToString(op.add!)}، خصم ${jsNumberToString(op.ded!)}';
        if (net == 0) {
          computed = SheetOp(
            AdjustResult(id: '', status: 'تمت المقاصة', amount: 0),
            round2(current),
            'تمت المقاصة',
            0,
            false,
          );
        } else {
          computed = computeSheetOp(
            currentSalary: current,
            type: net < 0 ? 'خصم' : 'اضافة',
            amountRaw: jsNumberToString(net.abs()),
          );
        }
      } else {
        computed = computeSheetOp(
          currentSalary: current,
          type: l.full ? 'خصم كامل' : l.type,
          amountRaw: l.full ? 'خصم كامل' : l.amountRaw,
        );
      }
      final statusText =
          merged != null
              ? '${computed.statusText} (دمج: $merged)'
              : settlement == null
              ? computed.statusText
              : computed.statusText == 'تمت المقاصة'
              ? 'تمت المقاصة ($settlement)'
              : '${computed.statusText} (مقاصة: $settlement)';
      salaryNow[found] = computed.newSalary;
      final prev = finalCells[found];
      final res = computed.result;
      finalCells[found] = AdjustWrite(
        row: found + 1,
        originalSalary:
            prev?.originalSalary ?? (cellAt(rows[found], salCol) ?? ''),
        salary: round2(computed.newSalary).toStringAsFixed(2),
        status: statusText,
        state: stateOf(res.status),
        owes: res.debt > 0 || res.zeroSalAmt > 0,
        expression:
            op.isSettlement ? expressionOf(op.parts) : (prev?.expression ?? ''),
      );
      results.add(
        res.copyWith(id: l.userId, settlement: settlement, merged: merged),
      );
    }
    final writes = finalCells.values.toList()..sort((a, b) => a.row - b.row);
    return BulkComputation(
      results,
      writes,
      lineResult: lineResult,
      mergedInto: mergedInto,
      settlements: settlements,
    );
  }

  /// «الحالة» of the second system: what happened to the user's salary.
  static String stateOf(String status) => switch (status) {
    'تمت الإضافة' => 'اضافة',
    'تم الخصم بالكامل' || 'تم خصم الدين' => 'خصم',
    'باقي عليه' => 'متبقي عليه',
    _ => status,
  };

  /// «العملية الحسابية» of a user with several lines: repeated amounts of
  /// one type summed (14 + 15), additions minus deductions otherwise
  /// (15 - 14), additions first.
  static String expressionOf(List<AdjustLine> parts) {
    if (parts.length < 2) return '';
    final adds = [
      for (final x in parts)
        if (!x.isDeduction) jsNumberToString(x.amountNum),
    ];
    final deds = [
      for (final x in parts)
        if (x.isDeduction) jsNumberToString(x.amountNum),
    ];
    if (adds.isEmpty) return deds.join(' + ');
    if (deds.isEmpty) return adds.join(' + ');
    return [adds.join(' + '), ...deds].join(' - ');
  }

  /// ERP `summarizeResults`.
  static AdjustSummary summarize(List<AdjustResult> results) {
    var added = 0.0, deducted = 0.0, debt = 0.0, notFound = 0.0;
    final debtUsers = <String>[];
    for (final r in results) {
      added += r.added;
      deducted += r.deducted;
      debt += r.debt;
      notFound += r.notFoundAmt + r.zeroSalAmt;
      if (r.debt > 0) debtUsers.add(r.id);
    }
    return AdjustSummary(
      totalAdded: round2(added),
      totalDeducted: round2(deducted),
      totalDebt: round2(debt),
      totalNotFound: round2(notFound),
      debtUsers: debtUsers,
    );
  }

  // ======================================================================
  // Results sheet (owner's request, 2026-11-17)
  // ======================================================================

  static const resultsSheetName = 'إضافات وخصومات';

  /// The results laid out as the owner pastes them by hand (owner's
  /// layout, 3.3.0): A–C the list exactly as it was pasted (every line,
  /// blank lines kept), column D empty, and E–G the results with one row
  /// per user — a user's lines are already one result after the settlement
  /// (مقاصة / دمج); unknown ids repeated in the list are summed. Then the
  /// totals under the longer of the two, and the settled users in a table
  /// further down.
  static ResultsSheet sheetLayout(AdjustOutcome out) {
    String m(double v) => money(v).replaceFirst('.', ',');
    final rows = <List<Object?>>[
      [
        'رقم المستخدم',
        'الحالة',
        'المبلغ',
        '',
        'رقم المستخدم',
        'الحالة',
        'المبلغ',
      ],
    ];
    // E–G: one row per user and status, in the order of the results.
    final merged = <(String, String, double)>[];
    final at = <String, int>{};
    for (final r in out.results) {
      final n = normalizeUserId(r.id);
      final key = '${n.isEmpty ? r.id.trim() : n}\u0000${r.status}';
      final i = at[key];
      if (i != null) {
        final (id, st, amount) = merged[i];
        merged[i] = (id, st, round2(amount + r.amount));
        continue;
      }
      at[key] = merged.length;
      merged.add((r.id, r.status, r.amount));
    }
    final n =
        out.lines.length > merged.length ? out.lines.length : merged.length;
    for (var i = 0; i < n; i++) {
      final cells = i < out.lines.length ? out.lines[i].cells : const [];
      final a = [for (var c = 0; c < 3; c++) c < cells.length ? cells[c] : ''];
      final e =
          i < merged.length
              ? <Object?>[merged[i].$1, merged[i].$2, m(merged[i].$3)]
              : <Object?>['', '', ''];
      rows.add([...a, '', ...e]);
    }
    final s = out.summary ?? summarize(out.results);
    rows.add(const []);
    rows.add(['', '', '', '', 'مجموع المتبقي (لنا عليهم)', '', m(s.totalDebt)]);
    rows.add(['', '', '', '', 'مجموع تم خصم', '', m(s.totalDeducted)]);
    rows.add(['', '', '', '', 'مجموع غير موجود', '', m(s.totalNotFound)]);
    int? settleHeader;
    if (out.settlements.isNotEmpty) {
      for (var i = 0; i < 5; i++) {
        rows.add(const []);
      }
      settleHeader = rows.length + 1;
      rows.add(['رقم المستخدم', 'الإضافة', 'الخصم', 'الصافي']);
      for (final x in out.settlements) {
        rows.add([x.id, x.added, x.deducted, x.net]);
      }
    }
    return ResultsSheet(rows, settleHeader, out.settlements.length);
  }

  /// Writes the results to a new sheet «إضافات وخصومات» of the same
  /// spreadsheet ([resultsSheetName] 2, 3… if the name is taken). [save]
  /// keeps the sheet name as soon as it exists, so a retry after a lost
  /// connection writes into the same sheet instead of a second one.
  Future<AdjustOutcome> pushResults(
    String spreadsheetId,
    AdjustOutcome out,
    Future<void> Function(AdjustOutcome) save,
  ) async {
    final sheets = sheetsProvider();
    final meta = await withSheetsRetry(
      () => sheets.getSpreadsheet(spreadsheetId),
    );
    final layout = sheetLayout(out);
    SheetProps? existing;
    for (final sp in meta.sheets) {
      if (out.pushedSheet != null && sp.title == out.pushedSheet) existing = sp;
    }
    String name;
    int sheetId;
    if (existing != null) {
      name = existing.title;
      sheetId = existing.sheetId;
    } else {
      final taken = {for (final sp in meta.sheets) sp.title.toLowerCase()};
      name = resultsSheetName;
      for (var k = 2; taken.contains(name.toLowerCase()); k++) {
        name = '$resultsSheetName $k';
      }
      final replies = await withSheetsRetry(
        () => sheets.batchUpdate(spreadsheetId, [
          {
            'addSheet': {
              'properties': {
                'title': name,
                'gridProperties': {
                  'rowCount':
                      layout.rows.length + 20 > 1000
                          ? layout.rows.length + 20
                          : 1000,
                  'columnCount': 26,
                },
              },
            },
          },
        ]),
      );
      final props =
          (replies.isEmpty ? null : replies.first['addSheet'])?['properties'];
      sheetId = (props?['sheetId'] as num?)?.toInt() ?? 0;
      out = out.withPush(name, sheetId, done: false);
      await save(out);
    }
    final esc = escapeSheetTitleForRange(name);
    const chunk = 5000;
    for (var i = 0; i < layout.rows.length; i += chunk) {
      final end =
          i + chunk > layout.rows.length ? layout.rows.length : i + chunk;
      await withSheetsRetry(
        () => sheets.valuesUpdate(
          spreadsheetId,
          "'$esc'!A${i + 1}",
          layout.rows.sublist(i, end),
        ),
      );
    }
    Map<String, dynamic> range(int r0, int r1, int c0, int c1) => {
      'sheetId': sheetId,
      'startRowIndex': r0,
      'endRowIndex': r1,
      'startColumnIndex': c0,
      'endColumnIndex': c1,
    };
    Map<String, dynamic> bold(Map<String, dynamic> r) => {
      'repeatCell': {
        'range': r,
        'cell': {
          'userEnteredFormat': {
            'textFormat': {'bold': true},
          },
        },
        'fields': 'userEnteredFormat.textFormat.bold',
      },
    };
    const line = {
      'style': 'SOLID',
      'width': 1,
      'color': {'red': 0.6, 'green': 0.6, 'blue': 0.6},
    };
    final h = layout.settleHeader;
    await withSheetsRetry(
      () => sheets.batchUpdate(spreadsheetId, [
        bold(range(0, 1, 0, 7)),
        if (h != null) ...[
          bold(range(h - 1, h, 0, 4)),
          {
            'updateBorders': {
              'range': range(h - 1, h + layout.settleRows, 0, 4),
              'top': line,
              'bottom': line,
              'left': line,
              'right': line,
              'innerHorizontal': line,
              'innerVertical': line,
            },
          },
        ],
      ]),
    );
    out = out.withPush(name, sheetId, done: true);
    await save(out);
    return out;
  }

  /// ERP `formatMoneyUI`.
  static String money(double v) => '\$${jsNumberToString(round2(v))}';

  /// ERP `copyTableToSheet`: the table and the totals as Tab-separated text.
  static String copyText(List<AdjustResult> results, AdjustSummary s) {
    String m(double v) => money(v).replaceFirst('.', ',');
    final b = StringBuffer('رقم المستخدم\tالحالة\tالمبلغ\n');
    for (final r in results) {
      b.write('${r.id}\t${r.displayStatus}\t${m(r.amount)}\n');
    }
    b.write('\n');
    b.write('مجموع المتبقي (لنا عليهم)\t\t${m(s.totalDebt)}\n');
    b.write('مجموع تم خصم\t\t${m(s.totalDeducted)}\n');
    b.write('مجموع غير موجود\t\t${m(s.totalNotFound)}\n');
    return b.toString();
  }
}

class ResultsSheet {
  const ResultsSheet(this.rows, this.settleHeader, this.settleRows);
  final List<List<Object?>> rows;

  /// 1-based row of the settlement table header, or null.
  final int? settleHeader;
  final int settleRows;
}

class AdjustmentConflict implements Exception {
  const AdjustmentConflict(this.message);
  final String message;
  @override
  String toString() => message;
}

class AdjustRequest {
  const AdjustRequest({
    required this.spreadsheetId,
    required this.sheetName,
    required this.bulkData,
    this.idCol = AdjustmentsService.defaultIdCol,
    this.salaryCol = AdjustmentsService.defaultSalaryCol,
    this.statusCol = AdjustmentsService.defaultStatusCol,
    this.outputCol = '',
  });
  final String spreadsheetId;
  final String sheetName;
  final String idCol;
  final String salaryCol;
  final String statusCol;
  final String bulkData;

  /// Second system (3.3.0): the column that receives the salary after the
  /// adjustments; empty for the first system (the salary column itself).
  final String outputCol;

  Map<String, Object?> toJson() => {
    'kind': 'adjustments',
    'spreadsheetId': spreadsheetId,
    'sheetName': sheetName,
    'idCol': idCol,
    'salaryCol': salaryCol,
    'statusCol': statusCol,
    'bulkData': bulkData,
    if (outputCol.isNotEmpty) 'outputCol': outputCol,
  };

  static AdjustRequest fromJson(Map<String, Object?> j) => AdjustRequest(
    spreadsheetId: (j['spreadsheetId'] ?? '').toString(),
    sheetName: (j['sheetName'] ?? '').toString(),
    bulkData: (j['bulkData'] ?? '').toString(),
    idCol: (j['idCol'] as String?) ?? AdjustmentsService.defaultIdCol,
    salaryCol:
        (j['salaryCol'] as String?) ?? AdjustmentsService.defaultSalaryCol,
    statusCol:
        (j['statusCol'] as String?) ?? AdjustmentsService.defaultStatusCol,
    outputCol: (j['outputCol'] as String?) ?? '',
  );
}

class AdjustLine {
  const AdjustLine(
    this.userId,
    this.type,
    this.amountRaw,
    this.full,
    this.amountNum, [
    this.lineNo = 0,
  ]);

  /// 0-based line in the pasted text.
  final int lineNo;
  final String userId;
  final String type;
  final String amountRaw;
  final bool full;
  final double amountNum;

  /// ERP: only the exact type «خصم» deducts; any other type adds.
  bool get isDeduction => !full && type == 'خصم';
}

class _Op {
  _Op(
    this.line,
    this.row,
    this.add,
    this.ded, {
    this.mixed = false,
    this.parts = const [],
  });
  final AdjustLine line;
  final int? row;
  final double? add;
  final double? ded;

  /// Additions and deductions (مقاصة); false for repeated lines of one
  /// type (دمج).
  final bool mixed;

  /// Every line of the user, in the pasted order.
  final List<AdjustLine> parts;
  bool get isSettlement => add != null;
}

class SheetOp {
  const SheetOp(
    this.result,
    this.newSalary,
    this.statusText,
    this.amountNum,
    this.isFullDeduction,
  );
  final AdjustResult result;
  final double newSalary;
  final String statusText;
  final double amountNum;
  final bool isFullDeduction;
}

class AdjustWrite {
  const AdjustWrite({
    required this.row,
    required this.originalSalary,
    required this.salary,
    required this.status,
    this.state = '',
    this.owes = false,
    this.expression = '',
  });

  /// 1-based sheet row.
  final int row;
  final String originalSalary;
  final String salary;
  final String status;

  /// Second system: «الحالة» (خصم، اضافة، متبقي عليه…).
  final String state;

  /// Second system: «حالة المستخدم» is «مديون» (else «له»).
  final bool owes;

  /// Second system: «العملية الحسابية» (only for a user with several lines).
  final String expression;

  String get userState => owes ? 'مديون' : 'له';

  /// The colour of the salary after the adjustments: green for an
  /// addition, red when something was deducted or is still owed.
  String get tone => switch (state) {
    'اضافة' => 'g',
    'خصم' || 'متبقي عليه' || 'سحب ادارة' => 'r',
    _ => '',
  };
}

class BulkComputation {
  const BulkComputation(
    this.results,
    this.writes, {
    this.lineResult = const {},
    this.mergedInto = const {},
    this.settlements = const [],
  });
  final List<AdjustResult> results;
  final List<AdjustWrite> writes;

  /// Pasted line (0-based) → its entry in [results].
  final Map<int, int> lineResult;

  /// Pasted line merged into a settlement → the line that holds it.
  final Map<int, int> mergedInto;

  /// Users whose additions and deductions were netted (owner's change).
  final List<AdjustSettlement> settlements;
}

/// One settled user: total additions, total deductions and the net.
class AdjustSettlement {
  const AdjustSettlement(this.id, this.added, this.deducted, this.net);
  final String id;
  final double added;
  final double deducted;
  final double net;

  List<Object?> toJson() => [id, added, deducted, net];
  static AdjustSettlement fromJson(Object? j) {
    final l = j as List;
    return AdjustSettlement(
      l[0].toString(),
      (l[1] as num).toDouble(),
      (l[2] as num).toDouble(),
      (l[3] as num).toDouble(),
    );
  }
}

/// One pasted line as the results sheet shows it: the original cells
/// (A–C) and the line's result, if any.
class AdjustSheetLine {
  const AdjustSheetLine(this.cells, this.result, this.mergedInto);

  /// The line split like ERP (Tab, else spaces), at most three cells.
  final List<String> cells;

  /// Index in the results, or -1 (blank or ignored line).
  final int result;

  /// For a line merged into a settlement: the line that holds it, else -1.
  final int mergedInto;

  List<Object?> toJson() => [cells, result, mergedInto];
  static AdjustSheetLine fromJson(Object? j) {
    final l = j as List;
    return AdjustSheetLine(
      [for (final c in (l[0] as List)) c.toString()],
      (l[1] as num).toInt(),
      (l[2] as num).toInt(),
    );
  }
}

/// One line of ERP's results table.
class AdjustResult {
  const AdjustResult({
    required this.id,
    required this.status,
    required this.amount,
    this.added = 0,
    this.deducted = 0,
    this.debt = 0,
    this.notFoundAmt = 0,
    this.zeroSalAmt = 0,
    this.settlement,
    this.merged,
  });
  final String id;
  final String status;
  final double amount;
  final double added;
  final double deducted;
  final double debt;
  final double notFoundAmt;
  final double zeroSalAmt;

  /// «إضافة X، خصم Y» when the line is the owner's settlement.
  final String? settlement;

  /// «12 + 12» when repeated lines of one type were merged (3.3.0).
  final String? merged;

  String get displayStatus =>
      merged != null
          ? '$status (دمج)'
          : settlement == null || status == 'تمت المقاصة'
          ? status
          : '$status (مقاصة)';

  AdjustResult copyWith({
    required String id,
    String? settlement,
    String? merged,
  }) => AdjustResult(
    id: id,
    status: status,
    amount: amount,
    added: added,
    deducted: deducted,
    debt: debt,
    notFoundAmt: notFoundAmt,
    zeroSalAmt: zeroSalAmt,
    settlement: settlement,
    merged: merged,
  );

  List<Object?> toJson() => [
    id,
    status,
    amount,
    added,
    deducted,
    debt,
    notFoundAmt,
    zeroSalAmt,
    settlement,
    merged,
  ];

  static AdjustResult fromJson(Object? j) {
    final l = j as List;
    double d(int i) => (l[i] as num).toDouble();
    return AdjustResult(
      id: l[0].toString(),
      status: l[1].toString(),
      amount: d(2),
      added: d(3),
      deducted: d(4),
      debt: d(5),
      notFoundAmt: d(6),
      zeroSalAmt: d(7),
      settlement: l.length > 8 ? l[8] as String? : null,
      merged: l.length > 9 ? l[9] as String? : null,
    );
  }
}

class AdjustSummary {
  const AdjustSummary({
    required this.totalAdded,
    required this.totalDeducted,
    required this.totalDebt,
    required this.totalNotFound,
    required this.debtUsers,
  });
  final double totalAdded;
  final double totalDeducted;
  final double totalDebt;
  final double totalNotFound;
  final List<String> debtUsers;

  Map<String, Object?> toJson() => {
    'totalAdded': totalAdded,
    'totalDeducted': totalDeducted,
    'totalDebt': totalDebt,
    'totalNotFound': totalNotFound,
    'debtUsers': debtUsers,
  };

  static AdjustSummary fromJson(Map<String, Object?> j) => AdjustSummary(
    totalAdded: (j['totalAdded'] as num?)?.toDouble() ?? 0,
    totalDeducted: (j['totalDeducted'] as num?)?.toDouble() ?? 0,
    totalDebt: (j['totalDebt'] as num?)?.toDouble() ?? 0,
    totalNotFound: (j['totalNotFound'] as num?)?.toDouble() ?? 0,
    debtUsers: [
      for (final x in (j['debtUsers'] as List? ?? const [])) x.toString(),
    ],
  );
}

class AdjustOutcome {
  const AdjustOutcome({
    required this.success,
    required this.message,
    this.results = const [],
    this.summary,
    this.spreadsheetUrl,
    this.lines = const [],
    this.settlements = const [],
    this.pushedSheet,
    this.pushedSheetId,
    this.pushed = false,
  });
  final bool success;
  final String message;
  final List<AdjustResult> results;
  final AdjustSummary? summary;
  final String? spreadsheetUrl;

  /// Every pasted line with its result, for the results sheet.
  final List<AdjustSheetLine> lines;
  final List<AdjustSettlement> settlements;

  /// The «إضافات وخصومات» sheet created for these results, once
  /// [pushed] is true everything is written in it.
  final String? pushedSheet;
  final int? pushedSheetId;
  final bool pushed;

  AdjustOutcome withPush(String sheet, int sheetId, {required bool done}) =>
      AdjustOutcome(
        success: success,
        message: message,
        results: results,
        summary: summary,
        spreadsheetUrl: spreadsheetUrl,
        lines: lines,
        settlements: settlements,
        pushedSheet: sheet,
        pushedSheetId: sheetId,
        pushed: done,
      );

  Map<String, Object?> toJson() => {
    'kind': 'adjustments',
    'success': success,
    'message': message,
    'results': [for (final r in results) r.toJson()],
    'summary': summary?.toJson(),
    'spreadsheetUrl': spreadsheetUrl,
    'lines': [for (final l in lines) l.toJson()],
    'settlements': [for (final x in settlements) x.toJson()],
    'pushedSheet': pushedSheet,
    'pushedSheetId': pushedSheetId,
    'pushed': pushed,
  };

  static AdjustOutcome fromJson(Map<String, Object?> j) => AdjustOutcome(
    success: j['success'] == true,
    message: (j['message'] ?? '').toString(),
    results: [
      for (final r in (j['results'] as List? ?? const []))
        AdjustResult.fromJson(r),
    ],
    summary:
        j['summary'] is Map
            ? AdjustSummary.fromJson(
              Map<String, Object?>.from(j['summary'] as Map),
            )
            : null,
    spreadsheetUrl: j['spreadsheetUrl'] as String?,
    lines: [
      for (final l in (j['lines'] as List? ?? const []))
        AdjustSheetLine.fromJson(l),
    ],
    settlements: [
      for (final x in (j['settlements'] as List? ?? const []))
        AdjustSettlement.fromJson(x),
    ],
    pushedSheet: j['pushedSheet'] as String?,
    pushedSheetId: (j['pushedSheetId'] as num?)?.toInt(),
    pushed: j['pushed'] == true,
  );
}

class AdjustPlan {
  AdjustPlan({required this.steps, required this.next, required this.result})
    : failure = null;
  AdjustPlan.fail(String message)
    : steps = const [],
      next = 0,
      result = AdjustOutcome(success: false, message: message),
      failure = message;

  final List<Map<String, Object?>> steps;
  int next;
  final AdjustOutcome result;

  /// Set when the list cannot be processed (nothing is written).
  final String? failure;

  bool get complete => next >= steps.length;

  Map<String, Object?> toJson() => {
    'steps': steps,
    'next': next,
    'result': result.toJson(),
  };

  static AdjustPlan fromJson(Map<String, Object?> j) => AdjustPlan(
    steps: [
      for (final s in (j['steps'] as List)) Map<String, Object?>.from(s as Map),
    ],
    next: (j['next'] as num).toInt(),
    result: AdjustOutcome.fromJson(
      Map<String, Object?>.from(j['result'] as Map),
    ),
  );
}
