import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/accounting/books.dart';
import 'package:lork_erp/accounting/chart.dart';
import 'package:lork_erp/accounting/ledger.dart';
import 'package:lork_erp/accounting/reports.dart';
import 'package:lork_erp/data/app_database.dart';
import 'package:lork_erp/services/pdf_reports.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();

  test('the Arabic reports build valid PDF files', () async {
    final dir = await Directory.systemTemp.createTemp('pdf_test');
    final db = await AppDatabase.open(
      path: '${dir.path}/b.db',
      factory: databaseFactoryFfiNoIsolate,
    );
    final ledger = Ledger(db.raw);
    await ledger.ensureSeeded();
    final books = Books(ledger);
    final reports = Reports(ledger);
    final main = (await ledger.byRole(Roles.mainFund)).id;
    await books.receipt(
      fundId: main,
      fromAccountId: (await ledger.byRole(Roles.capital)).id,
      amount: 500000,
      memo: 'رأس المال',
    );
    await books.receipt(
      fundId: main,
      fromAccountId: (await ledger.byRole(Roles.revAudit)).id,
      amount: 25050,
      memo: 'أرباح تدقيق الدورة',
    );
    final pdf = PdfReports(
      pw.Font.ttf(
        File(
          'assets/fonts/Tajawal-Regular.ttf',
        ).readAsBytesSync().buffer.asByteData(),
      ),
      pw.Font.ttf(
        File(
          'assets/fonts/Tajawal-Bold.ttf',
        ).readAsBytesSync().buffer.asByteData(),
      ),
    );
    final st = await ledger.statement(main);
    final files = {
      'statement': await pdf.statement(
        workspace: 'الشركة',
        account: (await ledger.account(main))!,
        from: null,
        to: Ledger.today(),
        opening: st.opening,
        lines: st.lines,
      ),
      'trial': await pdf.trialBalance(
        'الشركة',
        await reports.trialBalance(),
        Ledger.today(),
      ),
      'income': await pdf.incomeStatement(
        'الشركة',
        await reports.incomeStatement(),
      ),
      'balance': await pdf.balanceSheet('الشركة', await reports.balanceSheet()),
      'parties': await pdf.parties(
        'الشركة',
        'الديون',
        await reports.partyBalances(),
      ),
    };
    for (final e in files.entries) {
      expect(String.fromCharCodes(e.value.take(5)), '%PDF-', reason: e.key);
      final out = Platform.environment['PDF_OUT'];
      if (out != null) File('$out/${e.key}.pdf').writeAsBytesSync(e.value);
    }
    await db.close();
    await dir.delete(recursive: true);
  });
}
