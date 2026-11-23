import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/erp/js_compat.dart';
import 'package:lork_erp/erp/normalize.dart';
import 'package:lork_erp/erp/payroll_audit_engine.dart';

// Expected values below were produced by ERP's JavaScript
// (services/payrollAuditEngine.js and payrollSearchService.js).
void main() {
  group('normalizeUserId (ERP)', () {
    test('matches the server', () {
      const cases = {
        '1001': '1001',
        '٠٠١٠٠٣': '1003',
        '۱۰۰۴': '1004',
        '1005.7': '1005',
        '01006': '1006',
        ' 1007 ': '1007',
        '10,08': '1008',
        'abc': 'abc',
        '': '',
        '1e3': '1000',
        '12345678901234567890': '12345678901234567000',
        '-5.5': '-6',
        '.5': '0',
        '1009x': '1009',
        '‏1010': '1010',
        'Infinity': 'Infinity',
        '9999999999999999999999': '1e+22',
        '-0': '0',
        '1.': '1',
        '+7': '7',
        '1e+': '1',
      };
      cases.forEach((input, expected) {
        expect(normalizeUserId(input), expected, reason: 'input "$input"');
      });
    });

    test('column letters', () {
      expect(columnLetterToIndex('A'), 0);
      expect(columnLetterToIndex('AA'), 26);
      expect(columnLetterToIndex('1'), isNull);
      expect(columnIndexToLetter(27), 'AB');
    });
  });

  group('runPayrollAuditCore (ERP)', () {
    final mgmt = [
      ['رقم المستخدم', 'الاسم'],
      ['1001', 'أحمد'],
      ['1002', 'سارة'],
      ['1003', 'علي'],
    ];
    final agent = [
      ['رقم المستخدم', 'الاسم', 'x', 'الراتب'],
      ['1001', 'أحمد', '', '100'],
      ['1002', 'سارة', '', '60'],
      ['1002', 'سارة', '', '40'],
      ['1007', 'باسم', '', '30'],
    ];
    final info = [
      ['n', 'p', 'id', 'title'],
      ['a', '', '1001', 'وكيل 1'],
      ['b', '', '1002', 'وكيل 1'],
      ['c', '', '1003', ''],
      ['d', '', '1007', 'وكيل 2'],
      ['e', '', '1009', 'وكيل 2'],
    ];

    test('classification, salary and grouping', () {
      final out = runPayrollAuditCore(
        managementRows: mgmt,
        agentRows: agent,
        userInfoRows: info,
        discountRatePct: 10,
        agentColor: '#8b5cf6',
        managementColor: '#facc15',
      );
      expect(out.dataStart, 1);
      expect(
        [for (final r in out.results) r.type],
        [typeAgent, typeAgentTwo, typeManagement, typeNotFound, typeNotFound],
      );
      expect(
        [for (final r in out.results) r.statusLabel],
        [statusAgent, statusAgentTwo, statusManagement, '', ''],
      );
      expect(out.results[0].salaryValue, 90);
      expect(out.results[1].salaryValue, 90);
      expect(out.results[2].salaryValue, 0);
      expect(out.results[3].salaryValue, isNull);
      expect(out.results[2].title, 'صف_3');
      expect(out.results[1].agentSheetRowIndices, [2, 3]);
      expect(out.results[0].mgmtSheetRowIndex, 1);
      expect(out.titleOrder, ['وكيل 1', 'صف_3']);
      expect(out.byTitle['وكيل 1']!.map((t) => t.color), [
        '#8b5cf6',
        '#8b5cf6',
      ]);
      expect(out.summary.total, 5);
      expect(out.summary.agent, 2);
      expect(out.summary.management, 1);
      expect(out.summary.notFound, 2);
    });

    test('duplicate user-info ids are reported like ERP', () {
      final d = findDuplicateUserInfoMemberIds([
        ['h', 'h', 'id'],
        ['', '', '5'],
        ['', '', '٥'],
        ['', '', '5.9'],
      ], 'C');
      expect(d.duplicateIds, ['5']);
      expect(d.duplicateRowNumbers, [3, 4]);
    });

    test('integer-like titles come first, as Object.keys orders them', () {
      expect(jsObjectKeyOrder(['b', '10', 'a', '5', '05']), [
        '5',
        '10',
        'b',
        'a',
        '05',
      ]);
    });

    test('salary helper rounds like Math.round', () {
      final s = computeSalaryWithDiscount(['33.335'], 0);
      expect(s.before, 33.335);
      expect(s.after, 33.34);
      expect(jsRound(2.5), 3);
      expect(jsRound(-2.5), -2);
      expect(computeSalaryWithDiscount(['100', '50.5'], 10).after, 135.45);
    });
  });

  group('withoutManagement (3.4.0)', () {
    final mgmtRows = [
      ['id'],
      ['1'],
      ['2'],
      ['3'],
    ];
    final agentRows = [
      ['id', '', '', 'salary'],
      ['1', '', '', '100'],
      ['2', '', '', '0'],
      ['2', '', '', ''],
      ['5', '', '', '40'],
    ];
    final userInfo = [
      ['', '', 'id', 'title'],
      ['', '', '1', 'A'],
      ['', '', '2', 'A'],
      ['', '', '3', 'B'],
      ['', '', '', 'B'],
      ['', '', '5', ''],
    ];

    test('salary in the agent sheet, 0 there, or not there', () {
      final out = runPayrollAuditCore(
        managementRows: mgmtRows,
        agentRows: agentRows,
        userInfoRows: userInfo,
        discountRatePct: 10,
        withoutManagement: true,
      );
      expect(
        [for (final r in out.results) r.type],
        [typeAgent, typeNoSalary, typeNotFound, typeNotFound, typeAgent],
      );
      expect(
        [for (final r in out.results) r.salaryValue],
        [90, 0, null, null, 36],
      );
      expect(out.results[1].statusLabel, 'بدون راتب');
      expect(out.byTitle, isEmpty);
      expect(out.mgmtByUserId, isEmpty);
      expect(out.summary.noSalary, 1);
      expect(out.summary.management, 0);
    });

    test('off, the same sheets give the ERP result', () {
      final out = runPayrollAuditCore(
        managementRows: mgmtRows,
        agentRows: agentRows,
        userInfoRows: userInfo,
        discountRatePct: 10,
      );
      expect(
        [for (final r in out.results) r.type],
        [typeAgent, typeAgentTwo, typeManagement, typeNotFound, typeNotFound],
      );
      expect(out.summary.noSalary, 0);
      expect(out.summary.toJson().keys.take(4), [
        'total',
        'agent',
        'management',
        'notFound',
      ]);
    });
  });
}
