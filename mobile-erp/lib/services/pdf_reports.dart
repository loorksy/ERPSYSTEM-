import 'dart:typed_data';

import 'package:flutter/services.dart' show rootBundle;
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../accounting/chart.dart';
import '../accounting/ledger.dart';
import '../accounting/money.dart';
import '../accounting/reports.dart';

/// One table of a PDF report.
class PdfTable {
  const PdfTable({
    this.title,
    required this.headers,
    required this.rows,
    this.total,
    this.widths,
  });
  final String? title;
  final List<String> headers;
  final List<List<String>> rows;
  final List<String>? total;

  /// Relative column widths (the first column, the name, is usually wider).
  final List<double>? widths;
}

/// A4 Arabic reports (right to left, Tajawal): statements and the
/// financial statements, for sharing or printing (the web ERP's PDF suite).
class PdfReports {
  PdfReports(this.regular, this.bold);
  final pw.Font regular;
  final pw.Font bold;

  static PdfReports? _cached;

  /// The app's own font from the assets.
  static Future<PdfReports> load() async {
    if (_cached != null) return _cached!;
    final r = await rootBundle.load('assets/fonts/Tajawal-Regular.ttf');
    final b = await rootBundle.load('assets/fonts/Tajawal-Bold.ttf');
    return _cached = PdfReports(pw.Font.ttf(r), pw.Font.ttf(b));
  }

  static const _ink = PdfColor.fromInt(0xff18212b);
  static const _ink2 = PdfColor.fromInt(0xff5b6573);
  static const _rule = PdfColor.fromInt(0xffdde2e8);
  static const _soft = PdfColor.fromInt(0xfff1f4f2);
  static const _accent = PdfColor.fromInt(0xff1f6b55);

  Future<Uint8List> build({
    required String title,
    required String subtitle,
    required List<PdfTable> tables,
    List<(String, String)> summary = const [],
    String? note,
  }) async {
    final doc = pw.Document(title: title, creator: 'LorkERP');
    final now = DateTime.now();
    final stamp =
        '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')} '
        '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}';
    pw.TextStyle st(double size, {bool b = false, PdfColor color = _ink}) =>
        pw.TextStyle(font: b ? bold : regular, fontSize: size, color: color);
    doc.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        margin: const pw.EdgeInsets.fromLTRB(32, 32, 32, 36),
        textDirection: pw.TextDirection.rtl,
        theme: pw.ThemeData.withFont(base: regular, bold: bold),
        header:
            (ctx) =>
                ctx.pageNumber == 1
                    ? pw.SizedBox()
                    : pw.Padding(
                      padding: const pw.EdgeInsets.only(bottom: 8),
                      child: pw.Text(title, style: st(9, color: _ink2)),
                    ),
        footer:
            (ctx) => pw.Row(
              mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
              children: [
                pw.Text('LorkERP · $stamp', style: st(8, color: _ink2)),
                pw.Text(
                  '${ctx.pageNumber} / ${ctx.pagesCount}',
                  style: st(8, color: _ink2),
                ),
              ],
            ),
        build:
            (ctx) => [
              pw.Text(title, style: st(20, b: true)),
              pw.SizedBox(height: 4),
              pw.Text(subtitle, style: st(11, color: _ink2)),
              pw.SizedBox(height: 14),
              if (summary.isNotEmpty) ...[
                pw.Container(
                  padding: const pw.EdgeInsets.all(10),
                  decoration: const pw.BoxDecoration(
                    color: _soft,
                    borderRadius: pw.BorderRadius.all(pw.Radius.circular(8)),
                  ),
                  child: pw.Row(
                    children: [
                      for (final (label, value) in summary)
                        pw.Expanded(
                          child: pw.Column(
                            children: [
                              pw.Text(
                                value,
                                style: st(13, b: true),
                                textDirection: pw.TextDirection.ltr,
                              ),
                              pw.SizedBox(height: 2),
                              pw.Text(label, style: st(9, color: _ink2)),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
                pw.SizedBox(height: 14),
              ],
              for (final t in tables) ...[
                if (t.title != null) ...[
                  pw.Text(t.title!, style: st(12.5, b: true, color: _accent)),
                  pw.SizedBox(height: 6),
                ],
                _table(t, st),
                pw.SizedBox(height: 14),
              ],
              if (note != null) pw.Text(note, style: st(9, color: _ink2)),
            ],
      ),
    );
    return doc.save();
  }

  pw.Widget _table(
    PdfTable t,
    pw.TextStyle Function(double, {bool b, PdfColor color}) st,
  ) {
    final n = t.headers.length;
    final widths = t.widths ?? [3, for (var i = 1; i < n; i++) 1.4];
    bool numeric(int i) => i > 0;
    pw.Widget cell(String s, int i, {bool head = false, bool b = false}) =>
        pw.Padding(
          padding: const pw.EdgeInsets.symmetric(horizontal: 6, vertical: 4.5),
          child: pw.Text(
            s,
            style: st(head ? 9 : 9.5, b: head || b, color: head ? _ink2 : _ink),
            textAlign: numeric(i) ? pw.TextAlign.left : pw.TextAlign.right,
            textDirection:
                numeric(i) && !head
                    ? pw.TextDirection.ltr
                    : pw.TextDirection.rtl,
          ),
        );
    return pw.Table(
      columnWidths: {
        for (var i = 0; i < n; i++) i: pw.FlexColumnWidth(widths[i]),
      },
      border: const pw.TableBorder(
        horizontalInside: pw.BorderSide(color: _rule, width: 0.5),
      ),
      children: [
        pw.TableRow(
          decoration: const pw.BoxDecoration(color: _soft),
          children: [
            for (var i = 0; i < n; i++) cell(t.headers[i], i, head: true),
          ],
        ),
        for (final r in t.rows)
          pw.TableRow(
            children: [
              for (var i = 0; i < n; i++) cell(i < r.length ? r[i] : '', i),
            ],
          ),
        if (t.total != null)
          pw.TableRow(
            decoration: const pw.BoxDecoration(
              border: pw.Border(top: pw.BorderSide(color: _ink, width: 0.8)),
            ),
            children: [
              for (var i = 0; i < n; i++)
                cell(i < t.total!.length ? t.total![i] : '', i, b: true),
            ],
          ),
      ],
    );
  }

  static String _m(int c) => c == 0 ? '—' : formatCents(c);

  static const _months = [
    'كانون الثاني',
    'شباط',
    'آذار',
    'نيسان',
    'أيار',
    'حزيران',
    'تموز',
    'آب',
    'أيلول',
    'تشرين الأول',
    'تشرين الثاني',
    'كانون الأول',
  ];

  /// «2026-11-23» → «23 تشرين الثاني 2026» (an ISO date inside Arabic text
  /// is shown reversed).
  static String d(String? iso) {
    final x = iso == null ? null : DateTime.tryParse(iso);
    if (x == null) return iso ?? '';
    return '${x.day} ${_months[x.month - 1]} ${x.year}';
  }

  // ------------------------------------------------------------ builders

  Future<Uint8List> statement({
    required String workspace,
    required Account account,
    required String? from,
    required String to,
    required int opening,
    required List<StatementLine> lines,
  }) {
    final nat = account.type.debitNormal ? 1 : -1;
    final debit = lines.fold(0, (n, l) => n + l.debit);
    final credit = lines.fold(0, (n, l) => n + l.credit);
    final closing = lines.isEmpty ? opening : lines.last.balance;
    return build(
      title: 'كشف حساب: ${account.name}',
      subtitle:
          '$workspace · ${account.code} · ${from == null ? 'حتى $to' : 'من $from إلى $to'}',
      summary: [
        ('رصيد مدوّر', formatCents(nat * opening)),
        ('مدين', formatCents(debit)),
        ('دائن', formatCents(credit)),
        ('الرصيد', formatCents(nat * closing)),
      ],
      tables: [
        PdfTable(
          headers: const [
            'البيان',
            'التاريخ',
            'رقم القيد',
            'مدين',
            'دائن',
            'الرصيد',
          ],
          widths: const [3.2, 1.3, 0.9, 1.3, 1.3, 1.4],
          rows: [
            for (final l in lines)
              [
                '${l.memo}${l.reversed ? ' (مُلغى)' : ''}',
                l.date,
                '${l.number}',
                _m(l.debit),
                _m(l.credit),
                formatCents(nat * l.balance),
              ],
          ],
          total: [
            'المجموع',
            '',
            '',
            formatCents(debit),
            formatCents(credit),
            formatCents(nat * closing),
          ],
        ),
      ],
      note: 'الرصيد بطبيعة الحساب (${account.type.label}).',
    );
  }

  Future<Uint8List> trialBalance(
    String workspace,
    TrialBalance tb,
    String date,
  ) => build(
    title: 'ميزان المراجعة',
    subtitle: '$workspace · حتى ${d(date)}',
    summary: [
      ('مجموع المدين', formatCents(tb.debit)),
      ('مجموع الدائن', formatCents(tb.credit)),
      ('الحالة', tb.balanced ? 'متوازن' : 'غير متوازن'),
    ],
    tables: [
      PdfTable(
        headers: const ['الحساب', 'الرمز', 'مدين', 'دائن'],
        widths: const [3.4, 1, 1.5, 1.5],
        rows: [
          for (final r in tb.rows)
            [r.account.name, r.account.code, _m(r.debit), _m(r.credit)],
        ],
        total: ['المجموع', '', formatCents(tb.debit), formatCents(tb.credit)],
      ),
    ],
  );

  List<List<String>> _nodeRows(AccountNode n, {int depth = 0}) => [
    if (depth > 0 && !n.isEmpty)
      ['${'   ' * (depth - 1)}${n.account.name}', formatCents(n.balance)],
    if (!n.isEmpty)
      for (final c in n.children) ..._nodeRows(c, depth: depth + 1),
  ];

  Future<Uint8List> incomeStatement(
    String workspace,
    IncomeStatement r,
  ) => build(
    title: 'قائمة الدخل',
    subtitle:
        '$workspace · ${r.from == null ? 'حتى ${r.to}' : 'من ${r.from} إلى ${r.to}'}',
    summary: [
      ('الإيرادات', formatCents(r.revenue.balance)),
      ('المصاريف', formatCents(r.expenses.balance)),
      (r.net >= 0 ? 'صافي الربح' : 'صافي الخسارة', formatCents(r.net.abs())),
    ],
    tables: [
      PdfTable(
        title: 'الإيرادات',
        headers: const ['الحساب', 'المبلغ'],
        rows: _nodeRows(r.revenue),
        total: ['إجمالي الإيرادات', formatCents(r.revenue.balance)],
      ),
      PdfTable(
        title: 'المصاريف',
        headers: const ['الحساب', 'المبلغ'],
        rows: _nodeRows(r.expenses),
        total: ['إجمالي المصاريف', formatCents(r.expenses.balance)],
      ),
    ],
  );

  Future<Uint8List> balanceSheet(String workspace, BalanceSheet r) => build(
    title: 'الميزانية العمومية',
    subtitle: '$workspace · في ${d(r.date)}',
    summary: [
      ('الأصول', formatCents(r.assets.balance)),
      ('الخصوم', formatCents(r.liabilities.balance)),
      ('حقوق الملكية', formatCents(r.equityTotal)),
    ],
    tables: [
      PdfTable(
        title: 'الأصول',
        headers: const ['الحساب', 'المبلغ'],
        rows: _nodeRows(r.assets),
        total: ['إجمالي الأصول', formatCents(r.assets.balance)],
      ),
      PdfTable(
        title: 'الخصوم',
        headers: const ['الحساب', 'المبلغ'],
        rows: _nodeRows(r.liabilities),
        total: ['إجمالي الخصوم', formatCents(r.liabilities.balance)],
      ),
      PdfTable(
        title: 'حقوق الملكية',
        headers: const ['الحساب', 'المبلغ'],
        rows: [
          ..._nodeRows(r.equity),
          ['صافي الربح غير المرحّل', formatCents(r.earnings)],
        ],
        total: ['إجمالي حقوق الملكية', formatCents(r.equityTotal)],
      ),
    ],
    note:
        r.balanced
            ? 'الأصول = الخصوم + حقوق الملكية.'
            : 'تنبيه: الميزانية غير متوازنة.',
  );

  Future<Uint8List> parties(
    String workspace,
    String title,
    List<({Account account, String groupRole, int balance})> list,
  ) {
    final toUs = list.fold(0, (n, p) => n + (p.balance > 0 ? p.balance : 0));
    final toThem = list.fold(0, (n, p) => n + (p.balance < 0 ? -p.balance : 0));
    return build(
      title: title,
      subtitle: '$workspace · ${d(Ledger.today())}',
      summary: [
        ('لنا', formatCents(toUs)),
        ('علينا', formatCents(toThem)),
        ('الصافي', formatCents(toUs - toThem)),
      ],
      tables: [
        PdfTable(
          headers: const ['الطرف', 'الرمز', 'لنا', 'علينا'],
          widths: const [3.2, 1, 1.5, 1.5],
          rows: [
            for (final p in list)
              if (p.balance != 0)
                [
                  p.account.name,
                  p.account.code,
                  p.balance > 0 ? formatCents(p.balance) : '—',
                  p.balance < 0 ? formatCents(-p.balance) : '—',
                ],
          ],
          total: ['المجموع', '', formatCents(toUs), formatCents(toThem)],
        ),
      ],
    );
  }
}
