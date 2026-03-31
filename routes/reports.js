const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const {
  ensureCycleOwnership,
  getSummarySnapshot,
  getSubAgencyReportData,
  getAccreditationsReportData,
  getTransferCompaniesReportData,
  getTransferCompanyLedgerReportData,
  getFundLedgerReportData,
  getMovementsReportData,
  getComprehensiveReportData,
  getReconciliationReportData,
  getCycleUnifiedLedgerReportData,
  getAllSubAgenciesBulkReportData,
  getAllFundsBulkReportData,
} = require('../services/accountingReportData');
const { enrichFundLedgerDisplayNotes } = require('../services/fundLedgerNotes');
const { resolveReportTerminologyMode } = require('../services/financialTerminology');
const {
  renderSubAgency,
  renderAccreditations,
  renderTransferCompanies,
  renderTransferCompanyLedger,
  renderFundLedger,
  renderMovements,
  renderComprehensive,
  renderReconciliationReport,
  renderCycleUnifiedLedger,
  renderBulkSubAgencies,
  renderBulkFunds,
  renderAccreditationsWithNet,
  htmlToPdfBuffer,
  htmlToPdfBufferWithFooter,
  encodeFilenameRfc5987,
} = require('../services/pdf/htmlAccountingPdf');

function sendPdf(res, filename, buffer) {
  const displayName = (filename && String(filename).trim()) || 'report.pdf';
  /** الاسم العربي فقط في filename* (RFC 5987) — ترميز UTF-8 كنسب مئوية ASCII؛ لا نضع أحرف غير ASCII في filename= */
  const star = encodeFilenameRfc5987(displayName);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="report.pdf"; filename*=UTF-8''${star}`
  );
  res.send(buffer);
}

function parseCycleId(q) {
  if (!q || q === '') return null;
  const n = parseInt(q, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function filenameDateYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${mo}${day}`;
}

function safeFilenamePart(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .trim() || 'report';
}

/** GET /api/reports/pdf/sub-agency?subAgencyId=&cycleId= */
router.get('/pdf/sub-agency', requireAuth, async (req, res) => {
  try {
    const subAgencyId = parseInt(req.query.subAgencyId, 10);
    if (!subAgencyId) {
      return res.status(400).json({ success: false, message: 'subAgencyId مطلوب' });
    }
    const cycleId = parseCycleId(req.query.cycleId);
    const db = getDb();
    const userId = req.session.userId;
    if (cycleId) {
      const c = await ensureCycleOwnership(db, userId, cycleId);
      if (!c) return res.status(404).json({ success: false, message: 'الدورة غير موجودة' });
    }
    const data = await getSubAgencyReportData(db, userId, subAgencyId, cycleId);
    if (!data) return res.status(404).json({ success: false, message: 'الوكالة غير موجودة' });
    const html = renderSubAgency(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    const name = `وكالة-${data.agency.name || subAgencyId}.pdf`;
    sendPdf(res, name, buf);
  } catch (e) {
    console.error('[reports] sub-agency PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

router.get('/pdf/accreditations', requireAuth, async (req, res) => {
  try {
    const cycleId = parseCycleId(req.query.cycleId);
    const db = getDb();
    const userId = req.session.userId;
    if (cycleId) {
      const c = await ensureCycleOwnership(db, userId, cycleId);
      if (!c) return res.status(404).json({ success: false, message: 'الدورة غير موجودة' });
    }
    const data = await getAccreditationsReportData(db, userId, cycleId);
    const html = renderAccreditations(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    sendPdf(res, 'اعتمادات.pdf', buf);
  } catch (e) {
    console.error('[reports] accreditations PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

router.get('/pdf/transfer-companies', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const data = await getTransferCompaniesReportData(db, req.session.userId);
    const html = renderTransferCompanies(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    sendPdf(res, 'شركات-التحويل.pdf', buf);
  } catch (e) {
    console.error('[reports] transfer-companies PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

router.get('/pdf/transfer-company-ledger', requireAuth, async (req, res) => {
  try {
    const companyId = parseInt(req.query.companyId, 10);
    if (!companyId) {
      return res.status(400).json({ success: false, message: 'companyId مطلوب' });
    }
    const db = getDb();
    const userId = req.session.userId;
    const data = await getTransferCompanyLedgerReportData(db, userId, companyId);
    if (!data) return res.status(404).json({ success: false, message: 'الشركة غير موجودة' });
    const html = renderTransferCompanyLedger(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    const name = `حركات-${data.company.name || companyId}.pdf`;
    sendPdf(res, name, buf);
  } catch (e) {
    console.error('[reports] transfer-company-ledger PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

router.get('/pdf/fund-ledger', requireAuth, async (req, res) => {
  try {
    const fundId = parseInt(req.query.fundId, 10);
    if (!fundId) {
      return res.status(400).json({ success: false, message: 'fundId مطلوب' });
    }
    const db = getDb();
    const userId = req.session.userId;
    const data = await getFundLedgerReportData(db, userId, fundId);
    if (!data) return res.status(404).json({ success: false, message: 'الصندوق غير موجود' });
    if (data.rows && data.rows.length) {
      data.rows = await enrichFundLedgerDisplayNotes(db, userId, data.rows);
    }
    const html = renderFundLedger(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    const name = `حركات-صندوق-${data.fund.name || fundId}.pdf`;
    sendPdf(res, name, buf);
  } catch (e) {
    console.error('[reports] fund-ledger PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

router.get('/pdf/movements', requireAuth, async (req, res) => {
  try {
    const cycleId = parseCycleId(req.query.cycleId);
    const db = getDb();
    const userId = req.session.userId;
    if (cycleId) {
      const c = await ensureCycleOwnership(db, userId, cycleId);
      if (!c) return res.status(404).json({ success: false, message: 'الدورة غير موجودة' });
    }
    const data = await getMovementsReportData(db, userId, cycleId);
    if (cycleId && !data) return res.status(404).json({ success: false, message: 'الدورة غير موجودة' });
    const html = renderMovements(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    sendPdf(res, 'حركات.pdf', buf);
  } catch (e) {
    console.error('[reports] movements PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

router.get('/pdf/comprehensive', requireAuth, async (req, res) => {
  try {
    const cycleId = parseCycleId(req.query.cycleId);
    const db = getDb();
    const userId = req.session.userId;
    if (cycleId) {
      const c = await ensureCycleOwnership(db, userId, cycleId);
      if (!c) return res.status(404).json({ success: false, message: 'الدورة غير موجودة' });
    }
    const data = await getComprehensiveReportData(db, userId, cycleId);
    const html = renderComprehensive(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    sendPdf(res, 'تقرير-شامل.pdf', buf);
  } catch (e) {
    console.error('[reports] comprehensive PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

/** JSON ملخص للعرض (اختياري) */
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const cycleId = parseCycleId(req.query.cycleId);
    const db = getDb();
    const s = await getSummarySnapshot(db, req.session.userId, cycleId);
    res.json({ success: true, summary: s });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** POST /api/reports/cycle-unified — PDF موحّد للدورة (مطابقة + جدول حركات) */
router.post('/cycle-unified', requireAuth, async (req, res) => {
  try {
    const cycleId = parseInt((req.body && req.body.cycleId) || '', 10);
    if (!cycleId) {
      return res.status(400).json({ success: false, message: 'cycleId مطلوب' });
    }
    const db = getDb();
    const userId = req.session.userId;
    const c = await ensureCycleOwnership(db, userId, cycleId);
    if (!c) return res.status(404).json({ success: false, message: 'الدورة غير موجودة' });
    const data = await getCycleUnifiedLedgerReportData(db, userId, cycleId);
    if (!data) return res.status(404).json({ success: false, message: 'تعذر بناء التقرير' });
    const html = renderCycleUnifiedLedger(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBufferWithFooter(html);
    const name = `تقرير-موحد-${safeFilenamePart(data.cycleName)}-${filenameDateYmd()}.pdf`;
    sendPdf(res, name, buf);
  } catch (e) {
    console.error('[reports] cycle-unified PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

/** GET /api/reports/pdf/reconciliation?cycleId= */
router.get('/pdf/reconciliation', requireAuth, async (req, res) => {
  try {
    const cycleId = parseCycleId(req.query.cycleId);
    const db = getDb();
    const userId = req.session.userId;
    const data = await getReconciliationReportData(db, userId, cycleId);
    const html = renderReconciliationReport(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    const name = `تقرير-مطابقة-${safeFilenamePart(data.cycleName)}-${filenameDateYmd()}.pdf`;
    sendPdf(res, name, buf);
  } catch (e) {
    console.error('[reports] reconciliation PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

/** GET /api/reports/pdf/all-sub-agencies?cycleId= */
router.get('/pdf/all-sub-agencies', requireAuth, async (req, res) => {
  try {
    const cycleId = parseCycleId(req.query.cycleId);
    const db = getDb();
    const userId = req.session.userId;
    if (cycleId) {
      const c = await ensureCycleOwnership(db, userId, cycleId);
      if (!c) return res.status(404).json({ success: false, message: 'الدورة غير موجودة' });
    }
    const data = await getAllSubAgenciesBulkReportData(db, userId, cycleId);
    const html = renderBulkSubAgencies(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    sendPdf(res, `وكالات-فرعية-${filenameDateYmd()}.pdf`, buf);
  } catch (e) {
    console.error('[reports] all-sub-agencies PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

/** GET /api/reports/pdf/all-funds */
router.get('/pdf/all-funds', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const data = await getAllFundsBulkReportData(db, req.session.userId);
    const html = renderBulkFunds(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    sendPdf(res, `صناديق-${filenameDateYmd()}.pdf`, buf);
  } catch (e) {
    console.error('[reports] all-funds PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

/** GET /api/reports/pdf/accreditations-net?cycleId= — اعتمادات مع صافي */
router.get('/pdf/accreditations-net', requireAuth, async (req, res) => {
  try {
    const cycleId = parseCycleId(req.query.cycleId);
    const db = getDb();
    const userId = req.session.userId;
    if (cycleId) {
      const c = await ensureCycleOwnership(db, userId, cycleId);
      if (!c) return res.status(404).json({ success: false, message: 'الدورة غير موجودة' });
    }
    const data = await getAccreditationsReportData(db, userId, cycleId);
    const html = renderAccreditationsWithNet(data, resolveReportTerminologyMode(req));
    const buf = await htmlToPdfBuffer(html);
    sendPdf(res, `اعتمادات-صافي-${filenameDateYmd()}.pdf`, buf);
  } catch (e) {
    console.error('[reports] accreditations-net PDF:', e);
    res.status(500).json({ success: false, message: e.message || 'فشل إنشاء PDF' });
  }
});

module.exports = router;
