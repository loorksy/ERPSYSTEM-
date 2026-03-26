/**
 * توليد PDF من HTML (RTL) عبر Puppeteer
 */

const puppeteer = require('puppeteer');

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n) {
  const x = typeof n === 'number' ? n : parseFloat(n);
  if (Number.isNaN(x)) return '0.00';
  return x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function docShell(title, innerHtml) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Tajawal', sans-serif; font-size: 11px; color: #1e293b; padding: 16px 20px; line-height: 1.45; }
    h1 { font-size: 18px; margin: 0 0 8px; color: #0f172a; }
    h2 { font-size: 14px; margin: 18px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; color: #334155; }
    .meta { color: #64748b; font-size: 10px; margin-bottom: 14px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; }
    th, td { border: 1px solid #cbd5e1; padding: 5px 6px; text-align: right; vertical-align: top; }
    th { background: #f1f5f9; font-weight: 600; }
    .muted { color: #94a3b8; font-size: 10px; }
    .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; margin: 10px 0; }
    .kv div { padding: 4px 0; border-bottom: 1px dashed #e2e8f0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${innerHtml}
</body>
</html>`;
}

function tableHtml(headers, rows) {
  if (!rows || !rows.length) {
    return '<p class="muted">لا توجد بيانات.</p>';
  }
  let h = '<table><thead><tr>';
  headers.forEach((x) => {
    h += `<th>${escapeHtml(x)}</th>`;
  });
  h += '</tr></thead><tbody>';
  rows.forEach((row) => {
    h += '<tr>';
    row.forEach((cell) => {
      h += `<td>${cell == null ? '' : escapeHtml(String(cell))}</td>`;
    });
    h += '</tr>';
  });
  h += '</tbody></table>';
  return h;
}

function renderSummaryBlock(s) {
  const rows = [
    ['إجمالي الإيرادات', fmtNum(s.totalRevenue)],
    ['الربح الصافي', fmtNum(s.netProfit)],
    ['المصاريف (مجمّع)', fmtNum(s.totalExpenses)],
    ['إجمالي الديون', fmtNum(s.totalDebts)],
    ['رصيد الصندوق (تقدير)', fmtNum(s.cashBalance)],
    ['رصيد المؤجل', fmtNum(s.deferredBalance)],
    ['رأس المال المسترد', fmtNum(s.capitalRecovered)],
    ['ربح الشحن', fmtNum(s.shippingProfit)],
    ['صافي الربح من الدفتر', fmtNum(s.ledgerNetProfit)],
    ['ديون الشحن', fmtNum(s.shippingDebt)],
    ['ديون الاعتمادات', fmtNum(s.accreditationDebtTotal)],
  ];
  return tableHtml(['البند', 'القيمة'], rows);
}

function renderSubAgency(data) {
  const a = data.agency;
  let inner = `<div class="meta">تاريخ التقرير: ${escapeHtml(new Date().toLocaleString('ar-SY'))}</div>`;
  inner += `<div class="kv">
    <div><strong>الاسم:</strong> ${escapeHtml(a.name)}</div>
    <div><strong>نسبة الوكالة:</strong> ${fmtNum(a.commission_percent)}%</div>
    <div><strong>الرصيد:</strong> ${fmtNum(data.balance)}</div>
    ${data.cycleName ? `<div><strong>الدورة:</strong> ${escapeHtml(data.cycleName)}</div>` : ''}
  </div>`;
  inner += '<h2>الحركات</h2>';
  if (data.truncated) inner += '<p class="muted">تم اقتطاع القائمة — أحدث ' + data.transactions.length + ' حركة.</p>';
  const headers = ['#', 'النوع', 'المبلغ', 'الدورة', 'ملاحظات', 'التاريخ'];
  const rows = data.transactions.map((t) => [
    String(t.id),
    t.type,
    fmtNum(t.amount),
    t.cycle_id != null ? String(t.cycle_id) : '—',
    t.notes || '—',
    t.created_at ? new Date(t.created_at).toLocaleString('ar-SY') : '',
  ]);
  inner += tableHtml(headers, rows);
  return docShell('تقرير وكالة فرعية: ' + a.name, inner);
}

function renderAccreditations(data) {
  let inner = `<div class="meta">${data.cycleName ? 'الدورة: ' + escapeHtml(data.cycleName) : 'كل الدورات (الحركات غير المفلترة بالدورة إن لم تُختر دورة)'}</div>`;
  inner += '<h2>الجهات</h2>';
  const entRows = data.entities.map((e) => [
    String(e.id),
    e.name,
    e.code || '—',
    fmtNum(e.balance_amount),
  ]);
  inner += tableHtml(['المعرف', 'الاسم', 'الكود', 'الرصيد'], entRows);
  inner += '<h2>دفتر الاعتمادات</h2>';
  if (data.truncated) inner += '<p class="muted">تم اقتطاع الحركات.</p>';
  const lr = data.ledger.map((l) => [
    String(l.id),
    l.entity_name,
    l.entry_type,
    fmtNum(l.amount),
    l.currency || 'USD',
    l.cycle_id != null ? String(l.cycle_id) : '—',
    (l.notes || '').slice(0, 80),
    l.created_at ? new Date(l.created_at).toLocaleString('ar-SY') : '',
  ]);
  inner += tableHtml(['#', 'الجهة', 'النوع', 'المبلغ', 'العملة', 'الدورة', 'ملاحظات', 'التاريخ'], lr);
  return docShell('تقرير الاعتمادات', inner);
}

function renderTransferCompanies(data) {
  let inner = `<p class="muted">${escapeHtml(data.noteNoCycle)}</p>`;
  for (const block of data.ledgersByCompany) {
    const c = block.company;
    inner += `<h2>${escapeHtml(c.name)} — رصيد: ${fmtNum(c.balance_amount)} ${escapeHtml(c.balance_currency || 'USD')}</h2>`;
    if (block.truncated) inner += '<p class="muted">تم اقتطاع حركات هذه الشركة.</p>';
    const rows = block.rows.map((r) => [
      String(r.id),
      fmtNum(r.amount),
      r.currency || 'USD',
      (r.notes || '').slice(0, 100),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ]);
    inner += tableHtml(['#', 'المبلغ', 'العملة', 'ملاحظات', 'التاريخ'], rows);
  }
  if (!data.ledgersByCompany.length) inner += '<p class="muted">لا توجد شركات أو حركات.</p>';
  return docShell('تقرير شركات التحويل', inner);
}

function renderMovements(data) {
  let inner = `<div class="meta">${data.cycleName ? 'الدورة: ' + escapeHtml(data.cycleName) : '—'} — ${escapeHtml(data.noteTransferAndFundNoCycle)}</div>`;

  inner += '<h2>دفتر ledger_entries</h2>';
  if (data.ledgerEntriesTruncated) inner += '<p class="muted">مقتطع.</p>';
  inner += tableHtml(
    ['#', 'الدلو', 'المصدر', 'المبلغ', 'عملة', 'اتجاه', 'دورة', 'ملاحظات', 'تاريخ'],
    data.ledgerEntries.map((r) => [
      String(r.id),
      r.bucket,
      r.source_type,
      fmtNum(r.amount),
      r.currency,
      String(r.direction),
      r.cycle_id != null ? String(r.cycle_id) : '—',
      (r.notes || '').slice(0, 60),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ])
  );

  inner += '<h2>دفتر الاعتمادات</h2>';
  if (data.accreditationLedgerTruncated) inner += '<p class="muted">مقتطع.</p>';
  inner += tableHtml(
    ['#', 'الجهة', 'النوع', 'المبلغ', 'دورة', 'ملاحظات', 'تاريخ'],
    data.accreditationLedger.map((r) => [
      String(r.id),
      r.entity_name,
      r.entry_type,
      fmtNum(r.amount),
      r.cycle_id != null ? String(r.cycle_id) : '—',
      (r.notes || '').slice(0, 60),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ])
  );

  inner += '<h2>دفتر شركات التحويل</h2>';
  if (data.transferCompanyLedgerTruncated) inner += '<p class="muted">مقتطع.</p>';
  inner += tableHtml(
    ['#', 'الشركة', 'المبلغ', 'ملاحظات', 'تاريخ'],
    data.transferCompanyLedger.map((r) => [
      String(r.id),
      r.company_name,
      fmtNum(r.amount),
      (r.notes || '').slice(0, 80),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ])
  );

  inner += '<h2>حركات الوكالات الفرعية</h2>';
  if (data.subAgencyTransactionsTruncated) inner += '<p class="muted">مقتطع.</p>';
  inner += tableHtml(
    ['#', 'الوكالة', 'النوع', 'المبلغ', 'دورة', 'ملاحظات', 'تاريخ'],
    data.subAgencyTransactions.map((r) => [
      String(r.id),
      r.agency_name,
      r.type,
      fmtNum(r.amount),
      r.cycle_id != null ? String(r.cycle_id) : '—',
      (r.notes || '').slice(0, 60),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ])
  );

  inner += '<h2>دفتر الصناديع</h2>';
  if (data.fundLedgerTruncated) inner += '<p class="muted">مقتطع.</p>';
  inner += tableHtml(
    ['#', 'الصندوق', 'النوع', 'المبلغ', 'عملة', 'ملاحظات', 'تاريخ'],
    data.fundLedger.map((r) => [
      String(r.id),
      r.fund_name,
      r.type,
      fmtNum(r.amount),
      r.currency || 'USD',
      (r.notes || '').slice(0, 60),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ])
  );

  return docShell('تقرير الحركات — جميع الدفاتر', inner);
}

function renderComprehensive(d) {
  const s = d.summary;
  let inner = `<div class="meta">تاريخ: ${escapeHtml(new Date().toLocaleString('ar-SY'))} — الدورة في الملخص: ${escapeHtml(s.cycleName || 'الافتراضي')}</div>`;
  inner += '<h2>ملخص مالي</h2>';
  inner += renderSummaryBlock(s);

  inner += '<h2>نظرة على الوكالات الفرعية</h2>';
  inner += tableHtml(
    ['المعرف', 'الاسم', 'النسبة %', 'الرصيد'],
    d.subAgenciesOverview.map((a) => [String(a.id), a.name, fmtNum(a.commission_percent), fmtNum(a.balance)])
  );

  inner += '<h2>الاعتمادات — الجهات</h2>';
  inner += tableHtml(
    ['المعرف', 'الاسم', 'الرصيد'],
    d.accreditations.entities.map((e) => [String(e.id), e.name, fmtNum(e.balance_amount)])
  );

  inner += '<h2>شركات التحويل</h2>';
  inner += '<p class="muted">' + escapeHtml(d.transferCompanies.noteNoCycle) + '</p>';
  inner += tableHtml(
    ['المعرف', 'الاسم', 'الرصيد', 'العملة'],
    d.transferCompanies.companies.map((c) => [String(c.id), c.name, fmtNum(c.balance_amount), c.balance_currency || 'USD'])
  );

  inner += '<h2>ملخص الحركات (أحدث سجلات مختارة)</h2>';
  inner += '<p class="muted">' + escapeHtml(d.movements.noteTransferAndFundNoCycle) + '</p>';
  inner += '<h3>ledger_entries</h3>';
  inner += tableHtml(
    ['#', 'دلو', 'مصدر', 'مبلغ'],
    d.movements.ledgerEntries.slice(0, 80).map((r) => [String(r.id), r.bucket, r.source_type, fmtNum(r.amount)])
  );
  inner += '<h3>الاعتمادات</h3>';
  inner += tableHtml(
    ['#', 'جهة', 'مبلغ'],
    d.movements.accreditationLedger.slice(0, 80).map((r) => [String(r.id), r.entity_name, fmtNum(r.amount)])
  );

  return docShell('تقرير محاسبي شامل — LorkERP', inner);
}

let browserSingleton = null;

async function getBrowser() {
  if (!browserSingleton) {
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    browserSingleton = await puppeteer.launch({
      headless: 'new',
      executablePath: execPath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none',
      ],
      timeout: 60000,
    });
  }
  return browserSingleton;
}

/**
 * @param {string} html
 * @returns {Promise<Buffer>}
 */
async function htmlToPdfBuffer(html) {
  let browser;
  try {
    browser = await getBrowser();
  } catch (e) {
    browserSingleton = null;
    throw new Error('فشل تشغيل المتصفح لتوليد PDF: ' + (e.message || ''));
  }
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.emulateMediaType('screen');
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });
    return Buffer.from(pdf);
  } catch (e) {
    throw new Error('فشل توليد PDF: ' + (e.message || ''));
  } finally {
    await page.close().catch(() => {});
  }
}

function encodeFilenameRfc5987(name) {
  return encodeURIComponent(name).replace(/'/g, '%27');
}

module.exports = {
  escapeHtml,
  fmtNum,
  docShell,
  tableHtml,
  renderSummaryBlock,
  renderSubAgency,
  renderAccreditations,
  renderTransferCompanies,
  renderMovements,
  renderComprehensive,
  htmlToPdfBuffer,
  encodeFilenameRfc5987,
};
