/**
 * توليد PDF من HTML (RTL) عبر Puppeteer
 */

const puppeteer = require('puppeteer');
const {
  MODES,
  translatePhrase: trPhrase,
  labelNetProfitSourceMode,
  labelFundLedgerTypeMode,
  labelLedgerBucket,
  labelAccreditationEntryType,
  labelSubAgencyTxType,
} = require('../financialTerminology');

function tr(s, mode) {
  return trPhrase(s, mode);
}

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

function renderSummaryBlock(s, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  const rows = [
    [tr('إجمالي الإيرادات', m), fmtNum(s.totalRevenue)],
    [tr('الربح الصافي', m), fmtNum(s.netProfit)],
    [tr('المصاريف (مجمّع)', m), fmtNum(s.totalExpenses)],
    [tr('إجمالي الديون', m), fmtNum(s.totalDebts)],
    [tr('رصيد الصندوق (تقدير)', m), fmtNum(s.cashBalance)],
    [tr('رصيد المؤجل', m), fmtNum(s.deferredBalance)],
    [tr('رأس المال المسترد', m), fmtNum(s.capitalRecovered)],
    [tr('ربح الشحن', m), fmtNum(s.shippingProfit)],
    [tr('صافي الربح من الدفتر', m), fmtNum(s.ledgerNetProfit)],
    [tr('ديون الشحن', m), fmtNum(s.shippingDebt)],
    [tr('ديون الاعتمادات', m), fmtNum(s.accreditationDebtTotal)],
  ];
  return tableHtml([tr('البند', m), tr('القيمة', m)], rows);
}

function renderSubAgency(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  const a = data.agency;
  let inner = `<div class="meta">${escapeHtml(tr('تاريخ التقرير', m))}: ${escapeHtml(new Date().toLocaleString('ar-SY'))}</div>`;
  inner += `<div class="kv">
    <div><strong>${escapeHtml(tr('الاسم', m))}:</strong> ${escapeHtml(a.name)}</div>
    <div><strong>${escapeHtml(tr('حصة الشركة من الو', m))}:</strong> ${fmtNum(a.company_percent != null && !isNaN(a.company_percent) ? a.company_percent : (100 - (a.commission_percent || 0)))}% — ${escapeHtml(tr('حصة الوكالة', m))}: ${fmtNum(a.commission_percent != null && !isNaN(a.commission_percent) ? a.commission_percent : (100 - (a.company_percent || 0)))}%</div>
    <div><strong>${escapeHtml(tr('الرصيد', m))}:</strong> ${fmtNum(data.balance)}</div>
    ${data.cycleName ? `<div><strong>${escapeHtml(tr('الدورة', m))}:</strong> ${escapeHtml(data.cycleName)}</div>` : ''}
  </div>`;
  inner += `<h2>${tr('الحركات', m)}</h2>`;
  if (data.truncated) {
    inner +=
      '<p class="muted">' +
      escapeHtml(tr('تم اقتطاع القائمة — أحدث ' + data.transactions.length + ' حركة.', m)) +
      '</p>';
  }
  const headers = ['#', tr('النوع', m), tr('المبلغ', m), tr('الدورة', m), tr('ملاحظات', m), tr('التاريخ', m)];
  const rows = data.transactions.map((t) => [
    String(t.id),
    labelSubAgencyTxType(t.type, m),
    fmtNum(t.amount),
    t.cycle_id != null ? String(t.cycle_id) : '—',
    t.notes || '—',
    t.created_at ? new Date(t.created_at).toLocaleString('ar-SY') : '',
  ]);
  inner += tableHtml(headers, rows);
  return docShell(tr('تقرير وكالة فرعية:', m) + ' ' + a.name, inner);
}

function renderAccreditations(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  let inner = `<div class="meta">${data.cycleName ? escapeHtml(tr('الدورة', m)) + ': ' + escapeHtml(data.cycleName) : tr('كل الدورات (الحركات غير المفلترة بالدورة إن لم تُختر دورة)', m)}</div>`;
  inner += `<h2>${tr('الجهات', m)}</h2>`;
  const entRows = data.entities.map((e) => [
    String(e.id),
    e.name,
    e.code || '—',
    fmtNum(e.balance_receivable ?? 0),
    fmtNum(e.balance_payable ?? 0),
  ]);
  inner += tableHtml(
    [tr('المعرف', m), tr('الاسم', m), tr('الكود', m), tr('لنا', m), tr('علينا', m)],
    entRows
  );
  inner += `<p class="muted">${escapeHtml(tr('الصافي في شاشة المعتمد = عمود علينا (مبلغ التسليم).', m))}</p>`;
  inner += `<h2>${tr('دفتر الاعتمادات', m)}</h2>`;
  if (data.truncated) inner += '<p class="muted">' + escapeHtml(tr('تم اقتطاع الحركات.', m)) + '</p>';
  const lr = data.ledger.map((l) => [
    String(l.id),
    l.entity_name,
    labelAccreditationEntryType(l.entry_type, m),
    fmtNum(l.amount),
    l.currency || 'USD',
    l.cycle_id != null ? String(l.cycle_id) : '—',
    (l.notes || '').slice(0, 80),
    l.created_at ? new Date(l.created_at).toLocaleString('ar-SY') : '',
  ]);
  inner += tableHtml(
    ['#', tr('الجهة', m), tr('النوع', m), tr('المبلغ', m), tr('العملة', m), tr('الدورة', m), tr('ملاحظات', m), tr('التاريخ', m)],
    lr
  );
  return docShell(tr('تقرير الاعتمادات', m), inner);
}

function renderTransferCompanyLedger(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  if (!data || !data.company) return docShell(tr('حركات شركة تحويل', m), '<p class="muted">' + escapeHtml(tr('لا توجد بيانات.', m)) + '</p>');
  const c = data.company;
  let inner = `<h2>${escapeHtml(c.name)} — ${escapeHtml(tr('رصيد', m))}: ${fmtNum(c.balance_amount)} ${escapeHtml(c.balance_currency || 'USD')}</h2>`;
  const rows = (data.rows || []).map((r) => [
    String(r.id),
    fmtNum(r.amount),
    r.currency || 'USD',
    (r.notes || '').slice(0, 120),
    r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
  ]);
  inner += tableHtml(['#', tr('المبلغ', m), tr('العملة', m), tr('ملاحظات', m), tr('التاريخ', m)], rows);
  return docShell(tr('تقرير حركات شركة تحويل', m), inner);
}

function renderFundLedger(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  if (!data || !data.fund) return docShell(tr('حركات صندوق', m), '<p class="muted">' + escapeHtml(tr('لا توجد بيانات.', m)) + '</p>');
  const f = data.fund;
  const title = [f.name, f.fund_number].filter(Boolean).join(' — ');
  let inner = `<h2>${escapeHtml(title || tr('صندوق', m))}</h2>`;
  const rows = (data.rows || []).map((r) => [
    String(r.id),
    labelFundLedgerTypeMode(r.type, m),
    fmtNum(r.amount),
    r.currency || 'USD',
    (r.displayNotes || r.notes || '').slice(0, 100),
    r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
  ]);
  inner += tableHtml(['#', tr('النوع', m), tr('المبلغ', m), tr('العملة', m), tr('ملاحظات', m), tr('التاريخ', m)], rows);
  return docShell(tr('تقرير حركات صندوق', m), inner);
}

function renderTransferCompanies(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  let inner = `<p class="muted">${escapeHtml(tr(data.noteNoCycle || '', m))}</p>`;
  for (const block of data.ledgersByCompany) {
    const c = block.company;
    inner += `<h2>${escapeHtml(c.name)} — ${escapeHtml(tr('رصيد', m))}: ${fmtNum(c.balance_amount)} ${escapeHtml(c.balance_currency || 'USD')}</h2>`;
    if (block.truncated) inner += '<p class="muted">' + escapeHtml(tr('تم اقتطاع حركات هذه الشركة.', m)) + '</p>';
    const rows = block.rows.map((r) => [
      String(r.id),
      fmtNum(r.amount),
      r.currency || 'USD',
      (r.notes || '').slice(0, 100),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ]);
    inner += tableHtml(['#', tr('المبلغ', m), tr('العملة', m), tr('ملاحظات', m), tr('التاريخ', m)], rows);
  }
  if (!data.ledgersByCompany.length) inner += '<p class="muted">' + escapeHtml(tr('لا توجد شركات أو حركات.', m)) + '</p>';
  return docShell(tr('تقرير شركات التحويل', m), inner);
}

function renderMovements(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  let inner = `<div class="meta">${data.cycleName ? escapeHtml(tr('الدورة', m)) + ': ' + escapeHtml(data.cycleName) : '—'} — ${escapeHtml(tr(data.noteTransferAndFundNoCycle || '', m))}</div>`;

  inner += `<h2>${tr('دفتر ledger_entries', m)}</h2>`;
  if (data.ledgerEntriesTruncated) inner += '<p class="muted">' + escapeHtml(tr('مقتطع.', m)) + '</p>';
  inner += tableHtml(
    ['#', tr('الدلو', m), tr('المصدر', m), tr('المبلغ', m), tr('عملة', m), tr('اتجاه', m), tr('دورة', m), tr('ملاحظات', m), tr('تاريخ', m)],
    data.ledgerEntries.map((r) => [
      String(r.id),
      labelLedgerBucket(r.bucket, m),
      labelNetProfitSourceMode(r.source_type, m),
      fmtNum(r.amount),
      r.currency,
      String(r.direction),
      r.cycle_id != null ? String(r.cycle_id) : '—',
      (r.notes || '').slice(0, 60),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ])
  );

  inner += `<h2>${tr('دفتر الاعتمادات', m)}</h2>`;
  if (data.accreditationLedgerTruncated) inner += '<p class="muted">' + escapeHtml(tr('مقتطع.', m)) + '</p>';
  inner += tableHtml(
    ['#', tr('الجهة', m), tr('النوع', m), tr('المبلغ', m), tr('دورة', m), tr('ملاحظات', m), tr('تاريخ', m)],
    data.accreditationLedger.map((r) => [
      String(r.id),
      r.entity_name,
      labelAccreditationEntryType(r.entry_type, m),
      fmtNum(r.amount),
      r.cycle_id != null ? String(r.cycle_id) : '—',
      (r.notes || '').slice(0, 60),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ])
  );

  inner += `<h2>${tr('دفتر شركات التحويل', m)}</h2>`;
  if (data.transferCompanyLedgerTruncated) inner += '<p class="muted">' + escapeHtml(tr('مقتطع.', m)) + '</p>';
  inner += tableHtml(
    ['#', tr('الشركة', m), tr('المبلغ', m), tr('ملاحظات', m), tr('تاريخ', m)],
    data.transferCompanyLedger.map((r) => [
      String(r.id),
      r.company_name,
      fmtNum(r.amount),
      (r.notes || '').slice(0, 80),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ])
  );

  inner += `<h2>${tr('حركات الوكالات الفرعية', m)}</h2>`;
  if (data.subAgencyTransactionsTruncated) inner += '<p class="muted">' + escapeHtml(tr('مقتطع.', m)) + '</p>';
  inner += tableHtml(
    ['#', tr('الوكالة', m), tr('النوع', m), tr('المبلغ', m), tr('دورة', m), tr('ملاحظات', m), tr('تاريخ', m)],
    data.subAgencyTransactions.map((r) => [
      String(r.id),
      r.agency_name,
      labelSubAgencyTxType(r.type, m),
      fmtNum(r.amount),
      r.cycle_id != null ? String(r.cycle_id) : '—',
      (r.notes || '').slice(0, 60),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ])
  );

  inner += `<h2>${tr('دفتر الصناديق', m)}</h2>`;
  if (data.fundLedgerTruncated) inner += '<p class="muted">' + escapeHtml(tr('مقتطع.', m)) + '</p>';
  inner += tableHtml(
    ['#', tr('الصندوق', m), tr('النوع', m), tr('المبلغ', m), tr('عملة', m), tr('ملاحظات', m), tr('تاريخ', m)],
    data.fundLedger.map((r) => [
      String(r.id),
      r.fund_name,
      labelFundLedgerTypeMode(r.type, m),
      fmtNum(r.amount),
      r.currency || 'USD',
      (r.notes || '').slice(0, 60),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ])
  );

  return docShell(tr('تقرير الحركات — جميع الدفاتر', m), inner);
}

function renderComprehensive(d, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  const s = d.summary;
  let inner = `<div class="meta">${escapeHtml(tr('تاريخ', m))}: ${escapeHtml(new Date().toLocaleString('ar-SY'))} — ${escapeHtml(tr('الدورة في الملخص', m))}: ${escapeHtml(s.cycleName || tr('الافتراضي', m))}</div>`;
  inner += `<h2>${tr('ملخص مالي', m)}</h2>`;
  inner += renderSummaryBlock(s, m);

  inner += `<h2>${tr('نظرة على الوكالات الفرعية', m)}</h2>`;
  inner += tableHtml(
    [tr('المعرف', m), tr('الاسم', m), tr('شركة/وكالة %', m), tr('الرصيد', m)],
    d.subAgenciesOverview.map((a) => {
      const co = a.company_percent != null && !isNaN(a.company_percent) ? a.company_percent : (100 - (a.commission_percent || 0));
      const ag = a.commission_percent != null && !isNaN(a.commission_percent) ? a.commission_percent : (100 - (a.company_percent || 0));
      return [String(a.id), a.name, fmtNum(co) + ' / ' + fmtNum(ag), fmtNum(a.balance)];
    })
  );

  inner += `<h2>${tr('الاعتمادات — الجهات', m)}</h2>`;
  inner += tableHtml(
    [tr('المعرف', m), tr('الاسم', m), tr('لنا', m), tr('علينا', m)],
    d.accreditations.entities.map((e) => [
      String(e.id),
      e.name,
      fmtNum(e.balance_receivable ?? 0),
      fmtNum(e.balance_payable ?? 0),
    ])
  );
  inner += `<p class="muted">${escapeHtml(tr('علينا = الصافي في شاشة المعتمد ومبلغ التسليم.', m))}</p>`;

  inner += `<h2>${tr('شركات التحويل', m)}</h2>`;
  inner += '<p class="muted">' + escapeHtml(tr(d.transferCompanies.noteNoCycle || '', m)) + '</p>';
  inner += tableHtml(
    [tr('المعرف', m), tr('الاسم', m), tr('الرصيد', m), tr('العملة', m)],
    d.transferCompanies.companies.map((c) => [String(c.id), c.name, fmtNum(c.balance_amount), c.balance_currency || 'USD'])
  );

  inner += `<h2>${tr('ملخص الحركات (أحدث سجلات مختارة)', m)}</h2>`;
  inner += '<p class="muted">' + escapeHtml(tr(d.movements.noteTransferAndFundNoCycle || '', m)) + '</p>';
  inner += `<h3>${tr('ledger_entries', m)}</h3>`;
  inner += tableHtml(
    ['#', tr('دلو', m), tr('مصدر', m), tr('مبلغ', m)],
    d.movements.ledgerEntries
      .slice(0, 80)
      .map((r) => [String(r.id), labelLedgerBucket(r.bucket, m), labelNetProfitSourceMode(r.source_type, m), fmtNum(r.amount)])
  );
  inner += `<h3>${tr('الاعتمادات', m)}</h3>`;
  inner += tableHtml(
    ['#', tr('جهة', m), tr('مبلغ', m)],
    d.movements.accreditationLedger.slice(0, 80).map((r) => [String(r.id), r.entity_name, fmtNum(r.amount)])
  );

  return docShell(tr('تقرير محاسبي شامل — LorkERP', m), inner);
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

/**
 * نسخة إضافية مع تذييل أرقام صفحات (لا تعدّل htmlToPdfBuffer الأصلية).
 */
async function htmlToPdfBufferWithFooter(html) {
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
      margin: { top: '12mm', bottom: '18mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: true,
      footerTemplate:
        '<div style="width:100%;font-size:9px;text-align:center;color:#64748b;font-family:Tajawal,sans-serif;padding:0 12mm;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      headerTemplate: '<span></span>',
    });
    return Buffer.from(pdf);
  } catch (e) {
    throw new Error('فشل توليد PDF: ' + (e.message || ''));
  } finally {
    await page.close().catch(() => {});
  }
}

const FUND_TYPE_LABELS = {
  opening_reference: 'رصيد افتتاحي',
  shipping_sale_cash: 'بيع شحن نقدي',
  shipping_buy_cash: 'شراء شحن نقدي',
  company_payout: 'صرف لشركة تحويل',
  fund_allocation: 'صرف لصندوق فرعي',
  fund_receive_from_main: 'وارد من الرئيسي',
  transfer_out: 'ترحيل بين صناديق (خروج)',
  transfer_in: 'ترحيل بين صناديق (دخل)',
  profit_transfer: 'ترحيل أرباح',
  net_profit_mirror: 'مرآة ربح صافي',
  audit_profit_credit: 'أرباح تدقيق W+Y+Z',
  manual_expense: 'مصروف يدوي',
  loan_cash_in: 'سلفة كاش',
  salary_swap_cash: 'تبديل راتب كاش',
  salary_swap_installment: 'تبديل راتب تقسيط',
  sub_agency_reward: 'مكافأة وكالة فرعية',
  sub_agency_salary_deduct: 'خصم راتب وكالة',
  accreditation_debt_payable: 'دين علينا - معتمد',
  accreditation_remainder: 'باقي بعد الوساطة',
  accreditation_bulk: 'استيراد جماعي',
  accreditation_transfer_in: 'تحويل من معتمد',
  accreditation_transfer_payable: 'تحويل معتمد (دين)',
  accreditation_transfer_from_main: 'تحويل لمعتمد من رئيسي',
  primary_agent_seed: 'بذرة وكيل رئيسي',
  admin_brokerage: 'وساطة إدارية',
  fx_spread_disbursement: 'صرف فرق تصريف',
  fx_spread_receive: 'وارد فرق تصريف',
  agency_company_from_main: 'حصة شركة من الرئيسي',
  agency_company_to_profit_pool: 'حصة شركة لصندوق الربح',
  return_in: 'مرتجع وارد',
  return_out: 'مرتجع صادر',
  return_recorded: 'مرتجع مسجل',
  movement_cancel: 'إلغاء حركة (عكسي)',
};

const LEDGER_SOURCE_LABELS = {
  accreditation_debt_payable: 'دين علينا - معتمد',
  accreditation_payable_discount: 'خصم دين معتمد',
  accreditation_brokerage: 'وساطة اعتماد',
  accreditation_remainder: 'باقي اعتماد',
  agent_table_primary_seed: 'بذرة جدول وكيل',
  accreditation_bulk_import: 'استيراد اعتماد جماعي',
  audit_management_yz: 'أرباح تدقيق Y+Z',
  transfer_discount_profit: 'ربح خصم تحويل',
  sub_agency_company_profit: 'ربح حصة شركة من وكالة',
  salary_swap: 'تبديل راتب',
  salary_swap_discount: 'ربح خصم تبديل راتب',
  sub_agency_reward: 'مكافأة وكالة فرعية',
  sub_agency_salary_deduct: 'خصم راتب وكالة',
  manual_expense: 'مصروف يدوي',
  admin_brokerage: 'وساطة إدارية',
  fx_spread_profit: 'ربح فرق التصريف',
};

const ACC_ENTRY_LABELS = {
  debt_to_us: 'دين لنا - معتمد',
  debt_to_them: 'دين علينا - معتمد',
  debt_to_them_no_fund: 'دين علينا (بدون صندوق)',
  payable_discount_profit: 'ربح خصم دين',
  salary: 'راتب معتمد',
  delivery: 'تسليم معتمد',
  transfer: 'تحويل معتمد',
  deferred_reserve_sync: 'مزامنة رصيد مؤجل',
};

const SUB_AGENCY_TYPE_LABELS = {
  profit: 'ربح وكالة فرعية',
  reward: 'مكافأة وكالة فرعية',
  deduction: 'خصم وكالة فرعية',
  due: 'مستحق وكالة فرعية',
};

function labelFundUnifiedType(t) {
  const k = t == null ? '' : String(t).trim();
  return FUND_TYPE_LABELS[k] || labelFundLedgerTypeMode(k, MODES.ACCOUNTANT);
}

function shippingComboLabel(type, pm) {
  const t = type === 'sell' ? 'sell' : 'buy';
  const p = pm || '';
  const key = `${t}_${p}`;
  const map = {
    sell_cash: 'بيع شحن نقدي',
    sell_debt: 'بيع شحن آجل',
    sell_salary_deduction: 'بيع شحن خصم راتب',
    sell_agency_deduction: 'بيع شحن خصم وكالة',
    buy_cash: 'شراء شحن نقدي',
    buy_debt: 'شراء شحن آجل',
  };
  return map[key] || `${type} / ${p}`;
}

function pillHtml(bg, color, text) {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:${color};font-size:10px;font-weight:600;">${escapeHtml(text)}</span>`;
}

function renderReconciliationInner(rec, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  const L = rec.lines;
  const S = rec.settlement;
  const rowsBalances = [
    ['1', tr('رصيد الصندوق الرئيسي', m), fmtNum(L.mainFundUsd)],
    ['2', tr('مجموع دين علينا', m), fmtNum(L.debtOnUs)],
    ['3', tr('مجموع دين لنا', m), fmtNum(L.debtToUs)],
    ['4', tr('مجموع المصاريف', m), fmtNum(L.totalExpenses)],
    ['5', tr('مجموع مطلوب دفع', m), fmtNum(L.paymentDueTotal)],
    ['6', tr('مجموع رصيد المؤجل', m), fmtNum(L.deferredBalance)],
  ];
  const rowsProfits = [
    ['7', tr('ربح نسبة خصم التحويل', m), fmtNum(L.profitTransferDiscount)],
    ['8', tr('ربح نسبة الشركة من الاعتمادات', m), fmtNum(L.profitAccreditationBrokerage)],
    ['9', tr('ربح المكافآت (Y+Z)', m), fmtNum(L.profitAuditYz)],
    ['10', tr('ربح نسبة الوكالة الفرعية', m), fmtNum(L.profitSubAgencyTransactionsProfit)],
    ['11', tr('ربح فرق التصريف', m), fmtNum(L.profitFxSpread)],
    ['12', tr('ربح الشحن', m), fmtNum(L.shippingProfit)],
    ['13', tr('ربح وساطة إدارية', m), fmtNum(L.adminBrokerageSum)],
    ['Σ', tr('إجمالي الأرباح (البنود 7–13)', m), fmtNum(L.totalProfitsSection)],
  ];

  let h = `<div class="meta">${escapeHtml(tr('تاريخ التقرير', m))}: ${escapeHtml(new Date().toLocaleString('ar-SY'))}</div>`;
  h += `<h2>${escapeHtml(tr('قسم 1 — الأرصدة والالتزامات', m))}</h2>`;
  h += '<table style="width:100%;border-collapse:collapse;"><thead><tr><th>#</th><th>' + escapeHtml(tr('البند', m)) + '</th><th>' + escapeHtml(tr('المبلغ', m)) + '</th></tr></thead><tbody>';
  rowsBalances.forEach((r) => {
    h += `<tr><td>${escapeHtml(r[0])}</td><td>${escapeHtml(r[1])}</td><td style="font-weight:600;">${escapeHtml(r[2])}</td></tr>`;
  });
  h += '</tbody></table>';

  h += `<h2>${escapeHtml(tr('قسم 2 — مصادر الأرباح', m))}</h2>`;
  h += `<p class="muted">${escapeHtml(tr('يستند إلى دفتر صافي الربح والشحن والوساطة كما في لوحة التحكم.', m))}</p>`;
  h += '<table style="width:100%;border-collapse:collapse;"><thead><tr><th>#</th><th>' + escapeHtml(tr('البند', m)) + '</th><th>' + escapeHtml(tr('المبلغ', m)) + '</th></tr></thead><tbody>';
  rowsProfits.forEach((r) => {
    h += `<tr><td>${escapeHtml(r[0])}</td><td>${escapeHtml(r[1])}</td><td style="font-weight:600;">${escapeHtml(r[2])}</td></tr>`;
  });
  h += '</tbody></table>';

  /** netResult = أرباح (7–13) − مصاريف − دين علينا — لا يساوي نقد الصندوق الرئيسي بالضرورة */
  const netLine = S.showDeficit
    ? `<p style="color:#b91c1c;font-weight:700;">${escapeHtml(tr('عجز محاسبي (تقدير)', m))}: ${fmtNum(S.deficitOrSurplusAmount)} USD — ${escapeHtml(tr('(أرباح − مصاريف − دين علينا)', m))}</p>`
    : `<p style="color:#15803d;font-weight:700;">${escapeHtml(tr('فائض محاسبي (تقدير)', m))}: ${fmtNum(S.deficitOrSurplusAmount)} USD — ${escapeHtml(tr('(أرباح − مصاريف − دين علينا)', m))}</p>`;

  h += `<h2>${escapeHtml(tr('قسم 3 — التسوية النهائية', m))}</h2>`;
  h += `<p class="muted" style="margin-bottom:6px;">${escapeHtml(tr('رصيد الصندوق الرئيسي في القسم 1 يعكس النقد الفعلي؛ يُعرض هنا أيضاً للمقارنة مع صافي التقدير المحاسبي.', m))}</p>`;
  h += `<p style="margin-bottom:8px;"><strong>${escapeHtml(tr('رصيد الصندوق الرئيسي (نقد)', m))}:</strong> <span style="font-weight:700;color:#1d4ed8;">${fmtNum(L.mainFundUsd)} USD</span></p>`;
  h += netLine;
  h += `<table style="width:100%;margin-top:8px;border-collapse:collapse;"><tbody>`;
  h += `<tr><td>${escapeHtml(tr('مجموع الغير مقبوض', m))}</td><td style="font-weight:600;color:#c2410c;">${fmtNum(S.uncollectedTotal)}</td></tr>`;
  h += `<tr><td>${escapeHtml(tr('مجموع يجب علينا دفعه', m))}</td><td style="font-weight:600;color:#b91c1c;">${fmtNum(S.weMustPayTotal)}</td></tr>`;
  h += `<tr><td>${escapeHtml(tr('مطلوب دفع', m))}</td><td style="font-weight:600;color:#b91c1c;">${fmtNum(S.paymentDueOnly)}</td></tr>`;
  h += `<tr><td>${escapeHtml(tr('رصيد مؤجل', m))} (${escapeHtml(String(S.deferredPersonCount))} ${escapeHtml(tr('شخص', m))}) — ${escapeHtml(S.deferredNote)}</td><td style="font-weight:600;color:#c2410c;">${fmtNum(S.deferredBalance)}</td></tr>`;
  h += `<tr><td><strong>${escapeHtml(tr('الصافي (تقدير)', m))}</strong></td><td><strong>${fmtNum(rec.settlement.netResult)}</strong></td></tr>`;
  h += '</tbody></table>';

  return h;
}

function renderReconciliationReport(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  const title = tr('تقرير المطابقة المالية', m) + (data.cycleName ? ' — ' + data.cycleName : '');
  return docShell(title, renderReconciliationInner(data, m));
}

function resolveUnifiedRowLabel(row, mode) {
  const mo = mode || MODES.ACCOUNTANT;
  if (row.source === 'fund') {
    const t = row.raw?.type;
    return labelFundUnifiedType(t);
  }
  if (row.source === 'ledger_entries') {
    const st = row.raw?.source_type || '';
    return LEDGER_SOURCE_LABELS[st] || labelNetProfitSourceMode(st, mo);
  }
  if (row.source === 'accreditation') {
    const et = row.raw?.entry_type || '';
    return ACC_ENTRY_LABELS[et] || labelAccreditationEntryType(et, mo);
  }
  if (row.source === 'shipping') {
    return shippingComboLabel(row.raw?.type, row.raw?.payment_method);
  }
  if (row.source === 'sub_agency') {
    const tt = row.raw?.type || '';
    return SUB_AGENCY_TYPE_LABELS[tt] || labelSubAgencyTxType(tt, mo);
  }
  if (row.source === 'expense') {
    return `${tr('مصروف', mo)} (${row.raw?.category || 'manual'})`;
  }
  return row.movementLabelAr || '—';
}

function resolvePartyLabel(row, mode) {
  const mo = mode || MODES.ACCOUNTANT;
  if (row.fundName) return row.fundName;
  if (row.companyName) return row.companyName;
  if (row.entityName) return row.entityName;
  if (row.agencyName) return row.agencyName;
  if (row.source === 'ledger_entries') {
    return labelLedgerBucket(row.bucket || row.raw?.bucket || '', mo);
  }
  return '—';
}

function badgeForSource(source) {
  const map = {
    fund: ['#dcfce7', '#15803d', 'صندوق'],
    tc_ledger: ['#fef3c7', '#b45309', 'شركة تحويل'],
    ledger_entries: ['#f3e8ff', '#7e22ce', 'دفتر محاسبي'],
    accreditation: ['#dbeafe', '#1d4ed8', 'اعتماد'],
    shipping: ['#fce7f3', '#be185d', 'شحن'],
    sub_agency: ['#e0f2fe', '#0369a1', 'وكالة فرعية'],
    expense: ['#fee2e2', '#b91c1c', 'مصاريف'],
  };
  const x = map[source] || ['#f1f5f9', '#334155', source];
  return pillHtml(x[0], x[1], x[2]);
}

function renderCycleUnifiedLedger(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  const rec = data.reconciliation;
  const title = tr('تقرير موحّد — حركات الدورة', m) + (data.cycleName ? ' — ' + data.cycleName : '');

  let inner = renderReconciliationInner(rec, m);
  inner += `<div style="page-break-before:always;"></div>`;
  inner += `<h2>${escapeHtml(tr('جدول الحركات الموحّد', m))}</h2>`;
  inner += `<p class="muted">${escapeHtml(data.noteScope || '')}</p>`;
  if (data.truncated) {
    inner += `<p class="muted">${escapeHtml(tr('تم اقتطاع القائمة لحد أقصى للصفوف.', m))}</p>`;
  }

  inner +=
    '<table style="width:100%;border-collapse:collapse;font-size:10px;"><thead><tr>' +
    '<th>#</th><th>' +
    escapeHtml(tr('التاريخ', m)) +
    '</th><th>' +
    escapeHtml(tr('المصدر', m)) +
    '</th><th>' +
    escapeHtml(tr('الجهة', m)) +
    '</th><th>' +
    escapeHtml(tr('نوع الحركة', m)) +
    '</th><th>' +
    escapeHtml(tr('الاتجاه', m)) +
    '</th><th>' +
    escapeHtml(tr('المبلغ', m)) +
    '</th><th>' +
    escapeHtml(tr('الرصيد التراكمي', m)) +
    '</th></tr></thead><tbody>';

  (data.rows || []).forEach((row, i) => {
    const dt = row.created_at ? new Date(row.created_at).toLocaleString('ar-SY', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const isIn = row.flowIn;
    const dirStr = isIn ? '▲ دخل' : '▼ خروج';
    const dirColor = isIn ? '#15803d' : '#b91c1c';
    const amt = row.amountSigned;
    const amtStr = (isIn ? '+' : '-') + fmtNum(amt);
    const lbl = resolveUnifiedRowLabel(row, m);
    const party = resolvePartyLabel(row, m);
    inner += '<tr>';
    inner += `<td>${i + 1}</td>`;
    inner += `<td>${escapeHtml(dt)}</td>`;
    inner += `<td>${badgeForSource(row.source)}</td>`;
    inner += `<td>${escapeHtml(party)}</td>`;
    inner += `<td>${escapeHtml(lbl)}</td>`;
    inner += `<td style="color:${dirColor};font-weight:600;">${escapeHtml(dirStr)}</td>`;
    inner += `<td style="color:${isIn ? '#15803d' : '#b91c1c'};font-weight:700;">${escapeHtml(amtStr)}</td>`;
    inner += `<td style="color:#1d4ed8;font-weight:700;">${fmtNum(row.runningBalance)}</td>`;
    inner += '</tr>';
  });

  inner += '</tbody></table>';
  if (!(data.rows || []).length) {
    inner += `<p class="muted">${escapeHtml(tr('لا توجد حركات في نطاق هذه الدورة.', m))}</p>`;
  }

  return docShell(title, inner);
}

function renderBulkSubAgencies(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  let inner = `<div class="meta">${escapeHtml(tr('تاريخ التقرير', m))}: ${escapeHtml(new Date().toLocaleString('ar-SY'))}</div>`;
  inner += `<p class="muted">${escapeHtml(tr('لا يُعرض رقم المستخدم في سجل الحركات.', m))}</p>`;
  for (const block of data.agencies || []) {
    const a = block.agency;
    inner += `<h2>${escapeHtml(a.name)} — ${escapeHtml(tr('الرصيد', m))}: ${fmtNum(block.balance)} — ${escapeHtml(tr('أرباح profit', m))}: ${fmtNum(block.profitSum)} — ${escapeHtml(tr('الصافي', m))}: ${fmtNum(block.net)}</h2>`;
    if (block.truncated) inner += '<p class="muted">' + escapeHtml(tr('مقتطع.', m)) + '</p>';
    const rows = (block.transactions || []).map((t) => [
      String(t.id),
      labelSubAgencyTxType(t.type, m),
      fmtNum(t.amount),
      t.notes || '—',
      t.created_at ? new Date(t.created_at).toLocaleString('ar-SY') : '',
    ]);
    inner += tableHtml(['#', tr('النوع', m), tr('المبلغ', m), tr('ملاحظات', m), tr('التاريخ', m)], rows);
  }
  if (!(data.agencies || []).length) inner += '<p class="muted">' + escapeHtml(tr('لا توجد وكالات.', m)) + '</p>';
  return docShell(tr('تقرير جميع الوكالات الفرعية', m), inner);
}

function renderBulkFunds(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  let inner = `<div class="meta">${escapeHtml(tr('تاريخ التقرير', m))}: ${escapeHtml(new Date().toLocaleString('ar-SY'))}</div>`;
  for (const block of data.funds || []) {
    const f = block.fund;
    inner += `<h2>${escapeHtml(f.name)} — ${escapeHtml(tr('رصيد USD', m))}: ${fmtNum(block.usdBalance)}</h2>`;
    if (block.truncated) inner += '<p class="muted">' + escapeHtml(tr('مقتطع.', m)) + '</p>';
    const rows = (block.rows || []).map((r) => [
      String(r.id),
      labelFundLedgerTypeMode(r.type, m),
      fmtNum(r.amount),
      r.currency || 'USD',
      (r.notes || '').slice(0, 80),
      r.created_at ? new Date(r.created_at).toLocaleString('ar-SY') : '',
    ]);
    inner += tableHtml(['#', tr('النوع', m), tr('المبلغ', m), tr('العملة', m), tr('ملاحظات', m), tr('التاريخ', m)], rows);
  }
  if (!(data.funds || []).length) inner += '<p class="muted">' + escapeHtml(tr('لا توجد صناديق.', m)) + '</p>';
  return docShell(tr('تقرير جميع الصناديق', m), inner);
}

function renderAccreditationsWithNet(data, terminologyMode = MODES.ACCOUNTANT) {
  const m = terminologyMode;
  let inner = `<div class="meta">${data.cycleName ? escapeHtml(tr('الدورة', m)) + ': ' + escapeHtml(data.cycleName) : tr('كل الدورات (الحركات غير المفلترة بالدورة إن لم تُختر دورة)', m)}</div>`;
  inner += `<h2>${tr('الجهات', m)}</h2>`;
  const entRows = data.entities.map((e) => [
    String(e.id),
    e.name,
    e.code || '—',
    fmtNum(e.balance_receivable ?? 0),
    fmtNum(e.balance_payable ?? 0),
  ]);
  inner += tableHtml(
    [tr('المعرف', m), tr('الاسم', m), tr('الكود', m), tr('لنا', m), tr('علينا', m)],
    entRows
  );
  inner += `<p class="muted">${escapeHtml(tr('عمود علينا = الصافي المعروض في الواجهة ومبلغ التسليم.', m))}</p>`;
  inner += `<h2>${tr('دفتر الاعتمادات', m)}</h2>`;
  if (data.truncated) inner += '<p class="muted">' + escapeHtml(tr('تم اقتطاع الحركات.', m)) + '</p>';
  const lr = data.ledger.map((l) => [
    String(l.id),
    l.entity_name,
    labelAccreditationEntryType(l.entry_type, m),
    fmtNum(l.amount),
    l.currency || 'USD',
    l.cycle_id != null ? String(l.cycle_id) : '—',
    (l.notes || '').slice(0, 80),
    l.created_at ? new Date(l.created_at).toLocaleString('ar-SY') : '',
  ]);
  inner += tableHtml(
    ['#', tr('الجهة', m), tr('النوع', m), tr('المبلغ', m), tr('العملة', m), tr('الدورة', m), tr('ملاحظات', m), tr('التاريخ', m)],
    lr
  );
  const sumRec = (data.entities || []).reduce((s, e) => s + (Number(e.balance_receivable) || 0), 0);
  const sumPay = (data.entities || []).reduce((s, e) => s + (Number(e.balance_payable) || 0), 0);
  inner +=
    `<h2>${escapeHtml(tr('مجموع لنا', m))}: ${fmtNum(sumRec)} — ${escapeHtml(tr('مجموع علينا (صافي التسليم)', m))}: ${fmtNum(sumPay)}</h2>`;
  return docShell(tr('تقرير الاعتمادات', m), inner);
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
  renderTransferCompanyLedger,
  renderFundLedger,
  renderMovements,
  renderComprehensive,
  htmlToPdfBuffer,
  htmlToPdfBufferWithFooter,
  renderReconciliationReport,
  renderCycleUnifiedLedger,
  renderBulkSubAgencies,
  renderBulkFunds,
  renderAccreditationsWithNet,
  encodeFilenameRfc5987,
};
