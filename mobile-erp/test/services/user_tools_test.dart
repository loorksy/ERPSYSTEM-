import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/data/app_database.dart';
import 'package:lork_erp/services/user_sheet_tools.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/fake_sheets.dart';

/// A user-info row: id in C, city in E, salary in L.
List<String> row(String id, String city, String salary) => [
  'n$id',
  '',
  id,
  'وكالة',
  city,
  for (var i = 5; i < 11; i++) '',
  salary,
];

final header = [
  'A',
  'B',
  'ID',
  'D',
  'City',
  for (var i = 5; i < 11; i++) 'c$i',
  'Salary',
];

void main() {
  sqfliteFfiInit();

  test('rounding rules (owner\'s example: floor, the difference is 4.41)', () {
    final values = [
      12.09,
      19.53,
      12.09,
      95.79,
      84.63,
      312.48,
      541.26,
      45.57,
      26.97,
    ];
    final floor = [for (final v in values) RoundingMode.floor.apply(v)];
    expect(floor, [12, 19, 12, 95, 84, 312, 541, 45, 26]);
    final diff =
        values.fold<double>(0, (a, v) => a + v) -
        floor.fold<double>(0, (a, v) => a + v);
    expect((diff * 100).round() / 100, 4.41);

    expect(RoundingMode.ceil.apply(12.09), 13);
    expect(RoundingMode.ceil.apply(12), 12);
    expect(RoundingMode.halfUp.apply(12.49), 12);
    expect(RoundingMode.halfUp.apply(12.5), 13);
    expect(RoundingMode.halfEven.apply(12.5), 12);
    expect(RoundingMode.halfEven.apply(13.5), 14);
    expect(RoundingMode.halfEven.apply(19.53), 20);
    // Binary fractions do not move the result.
    expect(RoundingMode.floor.apply(0.1 + 0.2 + 12.7), 13);
    expect(RoundingMode.floor.apply(12.995), 12);
    // Negative amounts follow the same rules.
    expect(RoundingMode.floor.apply(-12.09), -13);
    expect(RoundingMode.ceil.apply(-12.09), -12);
  });

  test('the rounding plan skips empty and text cells, reads Arabic digits', () {
    final rows = [
      header,
      row('1001', 'دمشق', '12٫09'),
      row('1002', 'حلب', '١٩٫٥٣'),
      row('1003', 'دمشق', ''),
      row('1004', 'دمشق', 'لا يوجد'),
      row('1005', 'حلب', '40'),
    ];
    final plan = UserSheetTools.planRounding(
      rows,
      sheetTitle: 'Data',
      column: 'L',
      idColumn: 'C',
      mode: RoundingMode.floor,
    );
    expect(plan.salaries, 3);
    expect([for (final c in plan.changes) c.row], [2, 3]);
    expect([for (final c in plan.changes) c.after], [12, 19]);
    expect(plan.difference, 0.62);
    expect(plan.totalBefore, 71.62);
    expect(plan.totalAfter, 71);
  });

  test('merge follows the owner\'s Apps Script (mergeSalaries)', () {
    final rows = [
      ['الاسم', 'المدينة', 'ملاحظة', 'الراتب'],
      ['أحمد', 'دمشق', '', '10'],
      ['سارة', 'حلب', 'جديدة', '20.5'],
      ['  أحمد ', 'حلب', 'تحويل', '5.5'],
      ['أحمد', 'دمشق', 'تحويل', '4'],
      ['', 'دمشق', '', '100'],
      ['خالد', 'حمص', '', 'لا يوجد'],
      ['ليلى', 'دمشق', '', ''],
    ];
    final plan = UserSheetTools.planMerge(
      rows,
      sheetTitle: 'Data',
      headerRow: 1,
      nameColumn: 'A',
      salaryColumn: 'D',
      existingTitles: const ['Data'],
    );
    expect(plan.resultTitle, 'Data_دمج');
    expect(plan.resultExists, isFalse);
    expect(plan.sourceRows, 7);
    expect(plan.header, ['الاسم', 'المدينة', 'ملاحظة', 'الراتب']);
    // Sorted names; no name or a text salary → left out; empty salary → 0.
    expect([for (final r in plan.rows) r[0]], ['أحمد', 'سارة', 'ليلى']);
    expect(plan.rows[0], ['أحمد', 'دمشق / حلب', 'تحويل', 19.5]);
    expect(plan.rows[1], ['سارة', 'حلب', 'جديدة', 20.5]);
    expect(plan.rows[2], ['ليلى', 'دمشق', '', 0]);
    expect(plan.duplicates, {'أحمد': 3});
  });

  test('merge with a later header row and nothing under it', () {
    final plan = UserSheetTools.planMerge(
      [
        ['تقرير'],
        ['الاسم', 'الراتب'],
      ],
      sheetTitle: 'S',
      headerRow: 2,
      nameColumn: 'A',
      salaryColumn: 'B',
      existingTitles: const ['S'],
    );
    expect(plan.message, 'لا توجد بيانات بعد صف العناوين.');
  });

  group('on Google', () {
    late AppDatabase db;
    late FakeSheets fake;
    late UserSheetTools tools;

    setUp(() async {
      db = await AppDatabase.open(
        path: inMemoryDatabasePath,
        factory: databaseFactoryFfiNoIsolate,
      );
      fake =
          FakeSheets()..add('ui', 'Data', [
            header,
            row('1001', 'دمشق', '12.09'),
            row('1002', 'حلب', '19.53'),
            row('1003', '', '40'),
            row('1004', 'دمشق', '95.79'),
            row('1005', '  حلب ', '84.63'),
          ]);
      tools = UserSheetTools(db, () => fake);
    });

    tearDown(() => db.close());

    test(
      'rounding writes only the changed salaries, as numbers, and logs',
      () async {
        final plan = await tools.previewRounding(
          spreadsheetId: 'ui',
          sheetName: 'Data',
          column: 'L',
          idColumn: 'C',
          mode: RoundingMode.floor,
        );
        expect(plan.changes.length, 4);
        final entry = await tools.applyRounding(
          spreadsheetId: 'ui',
          spreadsheetName: 'ملف ui',
          plan: plan,
        );
        final data = fake.books['ui']!['Data']!;
        expect(
          [for (final r in data.skip(1)) r[11]],
          ['12', '19', '40', '95', '84'],
        );
        // Nothing else in the sheet changed.
        expect(data[1][4], 'دمشق');
        expect(data[3][2], '1003');
        expect(entry.difference, 2.04);
        expect(entry.count, 4);

        final log = await tools.log();
        expect(log.single.difference, 2.04);
        expect(log.single.mode, RoundingMode.floor);
        final details = await tools.logDetails(log.single.id);
        expect(
          [for (final c in details) c.id],
          ['1001', '1002', '1004', '1005'],
        );
        expect(details.first.before, 12.09);
        expect(details.first.after, 12);

        // A second run has nothing left to round.
        final again = await tools.previewRounding(
          spreadsheetId: 'ui',
          sheetName: 'Data',
          column: 'L',
          idColumn: 'C',
          mode: RoundingMode.floor,
        );
        expect(again.changes, isEmpty);
      },
    );

    test('rounding stops if a salary changed after the preview', () async {
      final plan = await tools.previewRounding(
        spreadsheetId: 'ui',
        sheetName: 'Data',
        column: 'L',
        idColumn: 'C',
        mode: RoundingMode.halfUp,
      );
      fake.books['ui']!['Data']![2][11] = '25.5';
      Object? error;
      try {
        await tools.applyRounding(
          spreadsheetId: 'ui',
          spreadsheetName: 'ملف ui',
          plan: plan,
        );
      } catch (e) {
        error = e;
      }
      expect(error is StateError, isTrue);
      expect(fake.books['ui']!['Data']![1][11], '12.09');
      expect(await tools.log(), isEmpty);
    });

    test('the default rounding is floor and can be changed', () async {
      expect(await tools.defaultMode(), RoundingMode.floor);
      await tools.setDefaultMode(RoundingMode.halfEven);
      expect(await tools.defaultMode(), RoundingMode.halfEven);
    });

    test('sorting copies each row to the sheet of its value, once', () async {
      // «حلب» already exists with one of its users.
      fake.add('ui', 'حلب', [header, row('1002', 'حلب', '19.53')]);
      final plan = await tools.previewSort(
        spreadsheetId: 'ui',
        sheetName: 'Data',
        column: 'E',
        emptyLabel: 'غير مذكور',
      );
      expect(
        {for (final g in plan.groups) g.sheetName: g.rows.length},
        {'دمشق': 2, 'حلب': 2, 'غير مذكور': 1},
      );
      expect(
        {for (final g in plan.groups) g.sheetName: g.exists},
        {'دمشق': false, 'حلب': true, 'غير مذكور': false},
      );
      final out = await tools.runSort(
        spreadsheetId: 'ui',
        plan: plan,
        idColumn: 'C',
        color: '#a7f3d0',
      );
      expect(out.created.toSet(), {'دمشق', 'غير مذكور'});
      // The sorted rows are coloured in the sorted sheet (rows 2–6).
      expect(out.colored, 5);
      final dataId = fake.ids['ui']!['Data'];
      expect(fake.colors['ui|$dataId'], {
        1: '#a7f3d0',
        2: '#a7f3d0',
        3: '#a7f3d0',
        4: '#a7f3d0',
        5: '#a7f3d0',
      });
      expect(out.skipped, 1);
      final book = fake.books['ui']!;
      expect(book['دمشق']!.first, header);
      expect([for (final r in book['دمشق']!.skip(1)) r[2]], ['1001', '1004']);
      expect([for (final r in book['حلب']!.skip(1)) r[2]], ['1002', '1005']);
      expect([for (final r in book['غير مذكور']!.skip(1)) r[2]], ['1003']);
      // The source sheet is not touched.
      expect(book['Data']!.length, 6);

      // Running it again copies nothing.
      final plan2 = await tools.previewSort(
        spreadsheetId: 'ui',
        sheetName: 'Data',
        column: 'E',
        emptyLabel: 'غير مذكور',
      );
      final out2 = await tools.runSort(
        spreadsheetId: 'ui',
        plan: plan2,
        idColumn: 'C',
      );
      expect(out2.created, isEmpty);
      expect(out2.total, 0);
      expect(out2.skipped, 5);
      expect(book['دمشق']!.length, 3);
    });

    test(
      'merge writes «<sheet>_دمج» and rewrites it on the next run',
      () async {
        fake.add('ui', 'Merge', [
          ['الاسم', 'المدينة', 'الراتب'],
          ['أحمد', 'دمشق', '10'],
          ['سارة', 'حلب', '20'],
          ['أحمد', 'حلب', '5.5'],
        ]);
        Future<String> run() async {
          final plan = await tools.previewMerge(
            spreadsheetId: 'ui',
            sheetName: 'Merge',
            headerRow: 1,
            nameColumn: 'A',
            salaryColumn: 'C',
          );
          return tools.runMerge(spreadsheetId: 'ui', plan: plan);
        }

        expect(
          await run(),
          'تم الدمج بنجاح. تم إنشاء ورقة: Merge_دمج بعدد أسماء: 2',
        );
        final out = fake.books['ui']!['Merge_دمج']!;
        expect(out, [
          ['الاسم', 'المدينة', 'الراتب'],
          ['أحمد', 'دمشق / حلب', '15.5'],
          ['سارة', 'حلب', '20'],
        ]);
        // The source sheet is not touched; a second run replaces the result.
        expect(fake.books['ui']!['Merge']!.length, 4);
        await run();
        expect(fake.books['ui']!['Merge_دمج']!.length, 3);
      },
    );

    test('a value named like the sorted sheet never writes into it', () {
      final plan = UserSheetTools.planSort(
        [header, row('1', 'Data', '1')],
        sheetTitle: 'Data',
        column: 'E',
        emptyLabel: 'غير مذكور',
        existingTitles: const ['Data'],
      );
      expect(plan.groups.single.sheetName, 'Data (فرز)');
      expect(plan.groups.single.exists, isFalse);
    });
  });
}
