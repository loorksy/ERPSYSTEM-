const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { adjustFundBalance, getMainFundId, getMainFundUsdBalance } = require('../services/fundService');
const { insertLedgerEntry, insertNetProfitLedgerAndMirrorFund } = require('../services/ledgerService');
const {
  processAccreditationBulkRows,
  processAccreditationBulkRowsFromItems,
  parseCsvTextToRows,
  buildBulkPreview,
} = require('../services/accreditationBulkImport');
const { extractSpreadsheetIdFromUrl, fetchSheetRowsUsingStoredGoogleConfig } = require('../services/googleSheetReadService');
const {
  syncNetBalance,
  applySalaryToThem,
  applyTransferOut,
  computeLedgerWithBalanceAfter,
} = require('../services/accreditationBalance');
const {
  splitDebtPayableWithDiscount,
  roundMoney,
  parseReceivableOffsetFromBody,
  isReceivableOffsetChoiceMissing,
  debtPayableLedgerNote,
} = require('../services/accreditationDebtAmounts');

const uploadsDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir, limits: { fileSize: 15 * 1024 * 1024 } });

/** صافي USD من قيود رصيد مرجعي ومرتجعات في سجل الصندوق — يُخصم من التزام «دين علينا» قبل تسجيل entity_payables */
async function sumFundReferenceAndReturnUsdForFund(db, fundId) {
  const r = (await db.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS t FROM fund_ledger
     WHERE fund_id = $1 AND UPPER(COALESCE(currency,'USD')) = 'USD'
       AND type IN ('opening_reference', 'return_in', 'return_out', 'return_recorded')`,
    [fundId]
  )).rows[0];
  return Math.max(0, Number(r?.t) || 0);
}

/** تقدير من سجل شركة التحويل (لا يوجد عمود نوع — يُستثنى سطور تحويل معتمد) */
async function sumCompanyReferenceReturnUsdHeuristic(db, companyId) {
  const r = (await db.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS t FROM transfer_company_ledger
     WHERE company_id = $1 AND UPPER(COALESCE(currency,'USD')) = 'USD'
       AND amount > 0.0001
       AND COALESCE(notes,'') NOT ILIKE '%تحويل إلى معتمد%'
       AND (
         COALESCE(notes,'') ILIKE '%افتتاحي%' OR COALESCE(notes,'') ILIKE '%مرتجع%'
         OR COALESCE(notes,'') ILIKE '%return%'
       )`,
    [companyId]
  )).rows[0];
  return Math.max(0, Number(r?.t) || 0);
}

function parseUploadedRows(filePath, mimetype) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const ext = path.extname(filePath).toLowerCase();
  let rows = [];
  try {
    if (ext === '.csv' || mimetype === 'text/csv') {
      const buf = fs.readFileSync(filePath, 'utf8');
      const lines = buf.split(/\r?\n/).filter(l => l.trim());
      rows = lines.map(line => line.split(/[,\t]/).map(c => c.trim()));
    } else {
      const wb = XLSX.readFile(filePath, { cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    }
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
  return rows;
}

router.get('/list', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query(
      `SELECT id, name, code, balance_amount, balance_payable, balance_receivable, pinned, is_primary, created_at
       FROM accreditation_entities WHERE user_id = $1
       ORDER BY is_primary DESC, pinned DESC, name`,
      [req.session.userId]
    )).rows;
    res.json({ success: true, list: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', list: [] });
  }
});

router.post('/add', requireAuth, async (req, res) => {
  try {
    const { name, code } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'الاسم مطلوب' });
    const db = getDb();
    const r = await db.query(
      `INSERT INTO accreditation_entities (user_id, name, code) VALUES ($1, $2, $3)`,
      [req.session.userId, String(name).trim(), code ? String(code).trim() : null]
    );
    res.json({ success: true, message: 'تمت الإضافة', id: r.lastInsertRowid });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.post('/:id/pin', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { pinned } = req.body || {};
    if (!id) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    await db.query(
      'UPDATE accreditation_entities SET pinned = $1 WHERE id = $2 AND user_id = $3',
      [pinned ? 1 : 0, id, req.session.userId]
    );
    res.json({ success: true, message: 'تم' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/**
 * إضافة مبلغ:
 * - راتب لنا/علينا: وساطة → صافي الربح، الباقي → الصندوق الرئيسي (لنا فقط). لا خصم تلقائي من «دين لنا» من نسبة خصم الراتب — التسوية يدوية.
 * - دين لنا (لنا): balance_receivable فقط، بدون صندوق وبدون خصم % من الواجهة.
 * - دين علينا (علينا): balance_payable + الصندوق بالصافي؛ الخصم → صافي الربح + صندوق الربح.
 * - لهم (debt_payable_no_fund): مثل علينا لكن بدون إيداع صندوق رئيسي؛ balance_payable + ربح خصم فقط.
 */
router.post('/:id/add-amount', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { salaryDirection, amount, brokeragePct, cycleId, notes, amountKind, discountPct: discountPctRaw } = req.body || {};
    const amt = parseFloat(amount);
    if (!id || isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const db = getDb();
    const ent = (await db.query(
      'SELECT id, balance_amount, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1 AND user_id = $2',
      [id, req.session.userId]
    )).rows[0];
    if (!ent) return res.json({ success: false, message: 'غير موجود' });

    let pay = Number(ent.balance_payable) || 0;
    let rec = Number(ent.balance_receivable) || 0;
    const cid = cycleId ? parseInt(cycleId, 10) : null;
    const discountPct = discountPctRaw != null && discountPctRaw !== '' ? parseFloat(discountPctRaw) : null;

    const kind = amountKind || 'salary';

    // دين لنا — على المعتمد (بدون صندوق، بدون خصم % من الواجهة)
    if (kind === 'debt_receivable' || kind === 'debt_to_us') {
      rec += amt;
      await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
         VALUES ($1, 'debt_to_us', $2, 'USD', 'to_us', $3, $4, $5)`,
        [id, amt, cid, notes || 'دين لنا — على المعتمد', null]
      );
      await db.query(
        'UPDATE accreditation_entities SET balance_receivable = $1 WHERE id = $2',
        [rec, id]
      );
      await syncNetBalance(db, id);
      const out = (await db.query(
        'SELECT balance_amount, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1',
        [id]
      )).rows[0];
      return res.json({
        success: true,
        message: 'تم تسجيل دين لنا على المعتمد',
        newBalance: out.balance_amount,
        balance_payable: out.balance_payable,
        balance_receivable: out.balance_receivable,
      });
    }

    // دين علينا — الصافي في الصندوق ومطلوب الدفع؛ خصم اختياري من «دين لنا» من المبلغ الإجمالي ثم split على المتبقي
    if (kind === 'debt_payable') {
      const mainFundId = await getMainFundId(db, req.session.userId);
      if (!mainFundId) {
        return res.json({ success: false, message: 'عيّن صندوقاً رئيسياً من قسم الصناديق قبل تسجيل دين علينا.' });
      }
      const rec0 = roundMoney(rec);
      const gross = roundMoney(amt);
      if (rec0 > 0.0001 && (isReceivableOffsetChoiceMissing(req.body))) {
        return res.status(400).json({
          success: false,
          code: 'RECEIVABLE_OFFSET_REQUIRED',
          message: 'يرجى اختيار خصم من الدين أو التأجيل من نافذة التأكيد',
        });
      }
      let offsetUsd = 0;
      let offsetMode = 'defer';
      try {
        const parsed = parseReceivableOffsetFromBody(req.body, rec0, gross);
        offsetUsd = parsed.s;
        offsetMode = parsed.mode;
      } catch (e) {
        return res.json({ success: false, message: e.message || 'فشل', code: e.code });
      }
      const remainingGross = roundMoney(gross - offsetUsd);
      if (remainingGross < 0) {
        return res.json({ success: false, message: 'المبلغ بعد خصم الدين غير صالح' });
      }
      const { netAmt, discountAmt, metaJson } = splitDebtPayableWithDiscount(remainingGross, discountPctRaw);
      const baseMeta = metaJson ? JSON.parse(metaJson) : {};
      const debtMetaObj = {
        ...baseMeta,
        grossInputUsd: gross,
        offsetFromReceivableUsd: offsetUsd,
        remainingGrossAfterOffsetUsd: remainingGross,
        receivableOffsetMode: offsetMode,
      };
      const ledgerMeta = JSON.stringify(debtMetaObj);
      const noteDebt = debtPayableLedgerNote({
        kindLabel: 'دين علينا',
        notes,
        discountAmt,
        discountPct,
        offsetUsd,
        offsetMode,
        hadReceivableBefore: rec0 > 0.0001,
      });
      pay = roundMoney(pay + netAmt);
      rec = roundMoney(rec0 - offsetUsd);

      let ledgerId;
      if (offsetUsd > 0.0001) {
        await db.query(
          `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
           VALUES ($1, 'receivable_offset_from_credit', $2, 'USD', 'to_us', $3, $4, $5)`,
          [
            id,
            offsetUsd,
            cid,
            notes || `خصم من دين لنا — بموجب ائتمان ${gross.toFixed(2)}`,
            JSON.stringify({ grossInputUsd: gross, offsetUsd }),
          ]
        );
      }
      if (netAmt <= 0.0001 && discountAmt <= 0.0001) {
        await db.query('UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3', [
          pay,
          rec,
          id,
        ]);
        await syncNetBalance(db, id);
        const outOnly = (await db.query(
          'SELECT balance_amount, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1',
          [id]
        )).rows[0];
        return res.json({
          success: true,
          message:
            rec0 > 0.0001 && offsetUsd <= 0.0001 && offsetMode === 'defer'
              ? 'تم التسجيل — تأجيل خصم دين لنا (دين لنا ورصيد له يظهران معًا)'
              : 'تم خصم من دين لنا (لا يوجد باقي إيداع بعد الخصم)',
          newBalance: outOnly.balance_amount,
          balance_payable: outOnly.balance_payable,
          balance_receivable: outOnly.balance_receivable,
        });
      }
      const led = await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
         VALUES ($1, 'debt_to_them', $2, 'USD', 'to_them', $3, $4, $5) RETURNING id`,
        [id, netAmt, cid, noteDebt, ledgerMeta]
      );
      ledgerId = led.rows[0]?.id;
      await db.query('UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3', [
        pay,
        rec,
        id,
      ]);
      await syncNetBalance(db, id);
      if (netAmt > 0) {
        await adjustFundBalance(
          db, mainFundId, 'USD', netAmt, 'accreditation_debt_payable',
          'دين علينا — معتمد', 'accreditation_ledger', ledgerId
        );
        await insertLedgerEntry(db, {
          userId: req.session.userId,
          bucket: 'main_cash',
          sourceType: 'accreditation_debt_payable',
          amount: netAmt,
          cycleId: cid,
          refTable: 'accreditation_ledger',
          refId: ledgerId,
          notes: 'دين علينا — معتمد',
        });
      }
      if (discountAmt > 0) {
        await insertNetProfitLedgerAndMirrorFund(db, {
          userId: req.session.userId,
          bucket: 'net_profit',
          sourceType: 'accreditation_payable_discount',
          amount: discountAmt,
          currency: 'USD',
          cycleId: cid,
          refTable: 'accreditation_ledger',
          refId: ledgerId,
          notes: 'ربح خصم من دين علينا (معتمد)',
        });
        await db.query(
          `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
           VALUES ($1, 'payable_discount_profit', $2, 'USD', 'to_us', $3, $4, $5)`,
          [
            id,
            discountAmt,
            cid,
            'ربح خصم من دين علينا',
            JSON.stringify({ linkedDebtLedgerId: ledgerId }),
          ]
        );
      }
      const out = (await db.query(
        'SELECT balance_amount, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1',
        [id]
      )).rows[0];
      return res.json({
        success: true,
        message:
          discountAmt > 0
            ? 'تم تسجيل دين علينا (صافي) والخصم كربح'
            : rec0 > 0.0001 && offsetUsd <= 0.0001 && offsetMode === 'defer'
              ? 'تم التسجيل — تأجيل خصم دين لنا (دين لنا ورصيد له يظهران معًا في الملف)'
              : offsetUsd > 0.0001 && offsetMode === 'full'
                ? 'تم التسجيل — خصم كامل من دين لنا والباقي دين علينا (رصيد له)'
                : offsetUsd > 0.0001 && offsetMode === 'custom'
                  ? 'تم التسجيل — خصم مخصص من دين لنا والباقي دين علينا (رصيد له)'
                  : 'تم تسجيل دين علينا والصندوق الرئيسي',
        newBalance: out.balance_amount,
        balance_payable: out.balance_payable,
        balance_receivable: out.balance_receivable,
      });
    }

    // لهم — مثل «علينا» (صافي + خصم ربح) لكن بدون أي إيداع في الصندوق الرئيسي؛ خصم من «دين لنا» على الإجمالي ثم split
    if (kind === 'debt_payable_no_fund') {
      const rec0 = roundMoney(rec);
      const gross = roundMoney(amt);
      if (rec0 > 0.0001 && (isReceivableOffsetChoiceMissing(req.body))) {
        return res.status(400).json({
          success: false,
          code: 'RECEIVABLE_OFFSET_REQUIRED',
          message: 'يرجى اختيار خصم من الدين أو التأجيل من نافذة التأكيد',
        });
      }
      let offsetUsd = 0;
      let offsetMode = 'defer';
      try {
        const parsed = parseReceivableOffsetFromBody(req.body, rec0, gross);
        offsetUsd = parsed.s;
        offsetMode = parsed.mode;
      } catch (e) {
        return res.json({ success: false, message: e.message || 'فشل', code: e.code });
      }
      const remainingGross = roundMoney(gross - offsetUsd);
      if (remainingGross < 0) {
        return res.json({ success: false, message: 'المبلغ بعد خصم الدين غير صالح' });
      }
      const { netAmt, discountAmt, metaJson } = splitDebtPayableWithDiscount(remainingGross, discountPctRaw);
      const baseMeta = metaJson ? JSON.parse(metaJson) : {};
      const debtMetaObj = {
        ...baseMeta,
        grossInputUsd: gross,
        offsetFromReceivableUsd: offsetUsd,
        remainingGrossAfterOffsetUsd: remainingGross,
        noMainFund: true,
        receivableOffsetMode: offsetMode,
      };
      const ledgerMeta = JSON.stringify(debtMetaObj);
      const noteDebt = debtPayableLedgerNote({
        kindLabel: 'لهم',
        notes,
        discountAmt,
        discountPct,
        offsetUsd,
        offsetMode,
        hadReceivableBefore: rec0 > 0.0001,
      });
      pay = roundMoney(pay + netAmt);
      rec = roundMoney(rec0 - offsetUsd);

      if (offsetUsd > 0.0001) {
        await db.query(
          `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
           VALUES ($1, 'receivable_offset_from_credit', $2, 'USD', 'to_us', $3, $4, $5)`,
          [
            id,
            offsetUsd,
            cid,
            notes || `خصم من دين لنا — بموجب لهم ${gross.toFixed(2)}`,
            JSON.stringify({ grossInputUsd: gross, offsetUsd, noMainFund: true }),
          ]
        );
      }
      if (netAmt <= 0.0001 && discountAmt <= 0.0001) {
        await db.query('UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3', [
          pay,
          rec,
          id,
        ]);
        await syncNetBalance(db, id);
        const outNf = (await db.query(
          'SELECT balance_amount, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1',
          [id]
        )).rows[0];
        return res.json({
          success: true,
          message:
            rec0 > 0.0001 && offsetUsd <= 0.0001 && offsetMode === 'defer'
              ? 'تم التسجيل — تأجيل خصم دين لنا (دين لنا ورصيد له يظهران معًا)'
              : 'تم خصم من دين لنا (لا يوجد باقي مطلوب دفع بعد الخصم)',
          newBalance: outNf.balance_amount,
          balance_payable: outNf.balance_payable,
          balance_receivable: outNf.balance_receivable,
        });
      }
      const led = await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
         VALUES ($1, 'debt_to_them_no_fund', $2, 'USD', 'to_them', $3, $4, $5) RETURNING id`,
        [id, netAmt, cid, noteDebt, ledgerMeta]
      );
      const ledgerId = led.rows[0]?.id;
      await db.query('UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3', [
        pay,
        rec,
        id,
      ]);
      await syncNetBalance(db, id);
      if (discountAmt > 0) {
        await insertNetProfitLedgerAndMirrorFund(db, {
          userId: req.session.userId,
          bucket: 'net_profit',
          sourceType: 'accreditation_payable_discount',
          amount: discountAmt,
          currency: 'USD',
          cycleId: cid,
          refTable: 'accreditation_ledger',
          refId: ledgerId,
          notes: 'ربح خصم من دين لهم (معتمد — بدون صندوق رئيسي)',
        });
        await db.query(
          `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
           VALUES ($1, 'payable_discount_profit', $2, 'USD', 'to_us', $3, $4, $5)`,
          [
            id,
            discountAmt,
            cid,
            'ربح خصم من دين لهم',
            JSON.stringify({ linkedDebtLedgerId: ledgerId, noMainFund: true }),
          ]
        );
      }
      const out = (await db.query(
        'SELECT balance_amount, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1',
        [id]
      )).rows[0];
      return res.json({
        success: true,
        message:
          discountAmt > 0
            ? 'تم تسجيل لهم (صافي) والخصم كربح'
            : rec0 > 0.0001 && offsetUsd <= 0.0001 && offsetMode === 'defer'
              ? 'تم التسجيل — تأجيل خصم دين لنا (دين لنا ورصيد له يظهران معًا في الملف)'
              : offsetUsd > 0.0001 && offsetMode === 'full'
                ? 'تم التسجيل — خصم كامل من دين لنا والباقي لهم (رصيد له)'
                : offsetUsd > 0.0001 && offsetMode === 'custom'
                  ? 'تم التسجيل — خصم مخصص من دين لنا والباقي لهم (رصيد له)'
                  : 'تم تسجيل لهم — مطلوب دفع فقط',
        newBalance: out.balance_amount,
        balance_payable: out.balance_payable,
        balance_receivable: out.balance_receivable,
      });
    }

    const mainFundId = await getMainFundId(db, req.session.userId);
    if (!mainFundId) {
      return res.json({ success: false, message: 'عيّن صندوقاً رئيسياً من قسم الصناديق قبل إضافة مبالغ.' });
    }
    const rec0 = roundMoney(rec);
    const pct = parseFloat(brokeragePct);
    const brokerageAmount = !isNaN(pct) && pct > 0 ? roundMoney(amt * (pct / 100)) : 0;
    const remainder = roundMoney(amt - brokerageAmount);
    const dir = salaryDirection === 'to_us' ? 'to_us' : 'to_them';

    let offsetUsd = 0;
    let offsetMode = 'defer';
    if (dir === 'to_us') {
      if (rec0 > 0.0001 && (isReceivableOffsetChoiceMissing(req.body))) {
        return res.status(400).json({
          success: false,
          code: 'RECEIVABLE_OFFSET_REQUIRED',
          message: 'يرجى اختيار خصم من الدين أو التأجيل من نافذة التأكيد',
        });
      }
      try {
        const parsed = parseReceivableOffsetFromBody(req.body, rec0, amt, {
          salaryRemainderAfterBrokerage: remainder,
        });
        offsetUsd = parsed.s;
        offsetMode = parsed.mode;
      } catch (e) {
        return res.json({ success: false, message: e.message || 'فشل', code: e.code });
      }
      pay = roundMoney(pay + amt - offsetUsd);
      rec = roundMoney(rec0 - offsetUsd);
    } else if (rec0 > 0.0001) {
      /** وجود «دين لنا» على المعتمد: لا تطبيق applySalaryToThem (كان يضيف المتبقي إلى لنا).
       *  يُسجَّل المبلغ كاملًا في «علينا» حتى تُحدَّد التسوية يدويًا من شاشة التسوية. */
      pay = roundMoney(pay + amt);
      rec = roundMoney(rec0);
    } else {
      const br = applySalaryToThem(pay, rec0, amt);
      pay = roundMoney(br.pay);
      rec = roundMoney(br.rec);
    }

    const fundDepositToUs = dir === 'to_us' ? roundMoney(remainder - offsetUsd) : 0;

    if (dir === 'to_us' && offsetUsd > 0.0001) {
      await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
         VALUES ($1, 'receivable_offset_from_credit', $2, 'USD', 'to_us', $3, $4, $5)`,
        [
          id,
          offsetUsd,
          cid,
          notes || `خصم من دين لنا — بموجب راتب ${amt.toFixed(2)}`,
          JSON.stringify({ grossSalaryUsd: amt, offsetUsd }),
        ]
      );
    }

    const salaryMetaObj =
      dir === 'to_us'
        ? {
            grossSalaryUsd: amt,
            remainderAfterBrokerageUsd: remainder,
            fundDepositUsd: fundDepositToUs,
            receivableOffsetMode: offsetMode,
            offsetUsd,
            offsetFromReceivableUsd: offsetUsd,
          }
        : null;
    const salaryMeta = salaryMetaObj ? JSON.stringify(salaryMetaObj) : null;

    let salaryNotes = notes && String(notes).trim() ? notes : null;
    if (!salaryNotes && dir === 'to_us') {
      if (rec0 > 0.0001 && offsetUsd <= 0.0001 && offsetMode === 'defer') {
        salaryNotes =
          'راتب لنا — تأجيل خصم من دين لنا (دين لنا دون تغيير؛ المبلغ يُسجّل لمصلحتهم والصندوق)';
      } else if (offsetUsd > 0.0001) {
        salaryNotes =
          offsetMode === 'full'
            ? `راتب لنا — خصم كامل من دين لنا (${offsetUsd.toFixed(2)})؛ الباقي للصندوق`
            : `راتب لنا — خصم مخصص ${offsetUsd.toFixed(2)} من دين لنا؛ الباقي للصندوق`;
      }
    }

    const led = await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, brokerage_pct, brokerage_amount, cycle_id, notes, meta_json)
       VALUES ($1, 'salary', $2, 'USD', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [id, amt, dir, !isNaN(pct) ? pct : null, brokerageAmount || null, cid, salaryNotes, salaryMeta]
    );
    const ledgerId = led.rows[0]?.id;

    await db.query(
      'UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3',
      [pay, rec, id]
    );
    await syncNetBalance(db, id);

    if (brokerageAmount > 0) {
      await insertNetProfitLedgerAndMirrorFund(db, {
        userId: req.session.userId,
        bucket: 'net_profit',
        sourceType: 'accreditation_brokerage',
        amount: brokerageAmount,
        cycleId: cid,
        refTable: 'accreditation_ledger',
        refId: ledgerId,
        notes: 'وساطة معتمد',
      });
    }
    if (Math.abs(fundDepositToUs) > 0.0001 && dir === 'to_us') {
      await adjustFundBalance(
        db, mainFundId, 'USD', fundDepositToUs, 'accreditation_remainder',
        'باقي بعد الوساطة', 'accreditation_ledger', ledgerId
      );
      await insertLedgerEntry(db, {
        userId: req.session.userId,
        bucket: 'main_cash',
        sourceType: 'accreditation_remainder',
        amount: fundDepositToUs,
        cycleId: cid,
        refTable: 'accreditation_ledger',
        refId: ledgerId,
        notes: 'باقي بعد الوساطة',
      });
    }
    const out = (await db.query(
      'SELECT balance_amount, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1',
      [id]
    )).rows[0];
    res.json({
      success: true,
      message: (() => {
        if (dir !== 'to_us') return 'تم التسجيل';
        if (rec0 > 0.0001 && offsetUsd <= 0.0001 && offsetMode === 'defer') {
          return 'تم التسجيل — تأجيل خصم دين لنا (دين لنا ورصيد له يظهران معًا في الملف)';
        }
        if (offsetUsd > 0.0001 && offsetMode === 'full') {
          return 'تم التسجيل — خصم كامل من دين لنا والباقي للصندوق';
        }
        if (offsetUsd > 0.0001 && offsetMode === 'custom') {
          return 'تم التسجيل — خصم مخصص من دين لنا والباقي للصندوق';
        }
        return 'تم التسجيل';
      })(),
      newBalance: out.balance_amount,
      balance_payable: out.balance_payable,
      balance_receivable: out.balance_receivable,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/**
 * تسوية يدوية بين «دين لنا» و«دين علينا» عند وجودهما معًا (يُخفّض balance_payable و balance_receivable بنفس المبلغ).
 * لا يمر عبر الصندوق — مجرد تصفية بين طرفي حساب المعتمد.
 */
router.post('/:id/settle-receivable-payable', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, cycleId, notes } = req.body || {};
    const amtRaw = parseFloat(amount);
    if (!id || isNaN(amtRaw) || amtRaw <= 0) {
      return res.json({ success: false, message: 'مبلغ غير صالح' });
    }
    const db = getDb();
    const ent = (await db.query(
      'SELECT id, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1 AND user_id = $2',
      [id, req.session.userId]
    )).rows[0];
    if (!ent) return res.json({ success: false, message: 'غير موجود' });
    let pay = roundMoney(ent.balance_payable);
    let rec = roundMoney(ent.balance_receivable);
    const maxSettle = roundMoney(Math.min(pay, rec));
    if (maxSettle <= 0.0001) {
      return res.json({
        success: false,
        message: 'لا يوجد دين لنا ودين علينا معًا للتسوية.',
      });
    }
    const settled = roundMoney(amtRaw);
    if (settled <= 0) {
      return res.json({ success: false, message: 'المبلغ بعد التقريب غير صالح' });
    }
    if (settled > maxSettle + 0.001) {
      return res.json({
        success: false,
        message: `المبلغ يتجاوز الحد الأقصى للتسوية (${maxSettle.toFixed(2)} USD). أدخل قيمة ≤ ${maxSettle.toFixed(2)}.`,
      });
    }
    pay = roundMoney(pay - settled);
    rec = roundMoney(rec - settled);
    const cid = cycleId ? parseInt(cycleId, 10) : null;
    const note =
      (notes && String(notes).trim()) ||
      `تسوية يدوية: ${settled.toFixed(2)} USD من دين لنا ومن علينا`;
    await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
       VALUES ($1, 'receivable_settlement', $2, 'USD', 'to_us', $3, $4, $5)`,
      [
        id,
        settled,
        cid,
        note,
        JSON.stringify({ settledUsd: settled, balancePayableAfter: pay, balanceReceivableAfter: rec }),
      ]
    );
    await db.query(
      'UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3',
      [pay, rec, id]
    );
    await syncNetBalance(db, id);
    const out = (await db.query(
      'SELECT balance_amount, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1',
      [id]
    )).rows[0];
    res.json({
      success: true,
      message: 'تمت التسوية',
      newBalance: out.balance_amount,
      balance_payable: out.balance_payable,
      balance_receivable: out.balance_receivable,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** معاينة فقط — ملف */
router.post('/bulk-balance-parse-file', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, message: 'الملف مطلوب' });
    const rows = parseUploadedRows(req.file.path, req.file.mimetype);
    const preview = buildBulkPreview(rows);
    res.json({ success: true, preview });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** معاينة فقط — نص */
router.post('/bulk-balance-parse-text', requireAuth, async (req, res) => {
  try {
    const { csvText } = req.body || {};
    const rows = parseCsvTextToRows(csvText || '');
    const preview = buildBulkPreview(rows);
    res.json({ success: true, preview });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** معاينة فقط — Google Sheet */
router.post('/bulk-balance-parse-sheet-url', requireAuth, async (req, res) => {
  try {
    const { sheetUrl, sheetName } = req.body || {};
    const sid = extractSpreadsheetIdFromUrl(sheetUrl);
    if (!sid) return res.json({ success: false, message: 'رابط Google Sheet غير صالح' });
    const db = getDb();
    const result = await fetchSheetRowsUsingStoredGoogleConfig(db, sid, sheetName || null);
    const rows = result.values || [];
    if (rows.length < 2) {
      return res.json({ success: false, message: 'الورقة فارغة أو غير قابلة للقراءة', sheetTitleUsed: result.sheetTitleUsed });
    }
    const preview = buildBulkPreview(rows);
    res.json({ success: true, preview, sheetTitleUsed: result.sheetTitleUsed });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** حفظ بعد المراجعة */
router.post('/bulk-balance-commit', requireAuth, async (req, res) => {
  try {
    const {
      cycleId,
      items,
      defaultBrokeragePct,
      receivableOffsetMode,
      receivableOffsetUsd,
      receivableOffsetAcknowledged,
    } = req.body || {};
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return res.json({ success: false, message: 'لا توجد صفوف' });
    const db = getDb();
    const offsetOpts = {
      receivableOffsetMode,
      receivableOffsetUsd,
      receivableOffsetAcknowledged,
    };
    const out = await processAccreditationBulkRowsFromItems(db, req.session.userId, list, cycleId, defaultBrokeragePct, offsetOpts);
    res.json(out);
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** رفع أرصدة: أعمدة A كود، B اسم، C رصيد، D معتمد رئيسي (كود أو اسم) */
router.post('/bulk-balance', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { cycleId, brokeragePct } = req.body || {};
    if (!req.file) return res.json({ success: false, message: 'الملف مطلوب' });
    const rows = parseUploadedRows(req.file.path, req.file.mimetype);
    const db = getDb();
    const out = await processAccreditationBulkRows(db, req.session.userId, rows, cycleId, brokeragePct);
    res.json(out);
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** لصق CSV/TSV كنص (نفس أعمدة الملف) */
router.post('/bulk-balance-text', requireAuth, async (req, res) => {
  try {
    const { csvText, cycleId, brokeragePct } = req.body || {};
    const rows = parseCsvTextToRows(csvText || '');
    const db = getDb();
    const out = await processAccreditationBulkRows(db, req.session.userId, rows, cycleId, brokeragePct);
    res.json(out);
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** جلب ورقة من رابط Google Sheet (يتطلب ربط Google في إعدادات الجداول) */
router.post('/bulk-balance-sheet-url', requireAuth, async (req, res) => {
  try {
    const { sheetUrl, sheetName, cycleId, brokeragePct } = req.body || {};
    const sid = extractSpreadsheetIdFromUrl(sheetUrl);
    if (!sid) return res.json({ success: false, message: 'رابط Google Sheet غير صالح' });
    const db = getDb();
    const result = await fetchSheetRowsUsingStoredGoogleConfig(db, sid, sheetName || null);
    const rows = result.values || [];
    if (rows.length < 2) {
      return res.json({ success: false, message: 'الورقة فارغة أو غير قابلة للقراءة', sheetTitleUsed: result.sheetTitleUsed });
    }
    const out = await processAccreditationBulkRows(db, req.session.userId, rows, cycleId, brokeragePct);
    res.json({ ...out, sheetTitleUsed: result.sheetTitleUsed });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الورقة' });
  }
});

/** تسليم: تصفير «علينا» فقط (balance_payable) — دون خصم من الصندوق الرئيسي */
router.post('/delivery-settle', requireAuth, async (req, res) => {
  try {
    const { cycleId, accreditationIds } = req.body || {};
    const cid = cycleId ? parseInt(cycleId, 10) : null;
    const ids = Array.isArray(accreditationIds) ? accreditationIds.map(x => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return res.json({ success: false, message: 'اختر معتمداً واحداً على الأقل' });
    const db = getDb();
    for (const aid of ids) {
      const ent = (await db.query(
        'SELECT id, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1 AND user_id = $2',
        [aid, req.session.userId]
      )).rows[0];
      if (!ent) continue;
      const pay = Number(ent.balance_payable) || 0;
      if (pay <= 0.0001) continue;
      await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes)
         VALUES ($1, 'delivery', $2, 'USD', 'to_them', $3, $4)`,
        [aid, pay, cid, 'تسليم — تصفير مطلوب الدفع (علينا) دون صندوق']
      );
      await db.query(
        'UPDATE accreditation_entities SET balance_payable = 0 WHERE id = $1',
        [aid]
      );
      await syncNetBalance(db, aid);
    }
    res.json({ success: true, message: 'تم التسليم' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/**
 * معتمدون جاهزون للتسليم (رصيد > 0).
 * بدون cycleId: كل من له رصيد موجب.
 * مع cycleId: من له رصيد موجب وله قيد في accreditation_ledger مرتبط بهذه الدورة (نشاط محاسبي في الدورة).
 */
router.get('/with-balance', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.userId;
    const cycleId = req.query.cycleId ? parseInt(req.query.cycleId, 10) : null;
    if (!cycleId) {
      const rows = (await db.query(
        `SELECT id, name, code, balance_amount, balance_payable, balance_receivable FROM accreditation_entities
         WHERE user_id = $1 AND COALESCE(balance_payable, 0) > 0.0001 ORDER BY name`,
        [userId]
      )).rows;
      return res.json({ success: true, list: rows, cycleId: null });
    }
    const rows = (await db.query(
      `SELECT e.id, e.name, e.code, e.balance_amount, e.balance_payable, e.balance_receivable
       FROM accreditation_entities e
       WHERE e.user_id = $1
         AND COALESCE(e.balance_payable, 0) > 0.0001
         AND EXISTS (
           SELECT 1 FROM accreditation_ledger l
           WHERE l.accreditation_id = e.id AND l.cycle_id = $2
         )
       ORDER BY e.name`,
      [userId, cycleId]
    )).rows;
    res.json({ success: true, list: rows, cycleId });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', list: [] });
  }
});

router.post('/:id/transfer', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { transferType, amount, fundId, companyId, notes, transferMode: transferModeRaw } = req.body || {};
    const amt = parseFloat(amount);
    if (!id || isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const db = getDb();
    const uid = req.session.userId;
    const ent = (await db.query(
      'SELECT * FROM accreditation_entities WHERE id = $1 AND user_id = $2',
      [id, uid]
    )).rows[0];
    if (!ent) return res.json({ success: false, message: 'غير موجود' });
    const accName = String(ent.name || '').trim() || 'معتمد';
    const noteUser = notes && String(notes).trim() ? String(notes).trim() : null;

    /** @type {'payable'|'main_fund'|'legacy'|undefined} */
    let mode = transferModeRaw;
    if (transferType === 'fund' || transferType === 'company') {
      if (mode !== 'payable' && mode !== 'main_fund') mode = 'legacy';
    } else {
      mode = undefined;
    }

    const meta = { transferType, fundId, companyId, transferMode: mode, accName };

    if (transferType === 'fund') {
      const fid = parseInt(fundId, 10);
      if (!fid) return res.json({ success: false, message: 'اختر الصندوق' });
      const destFund = (await db.query(
        'SELECT id, name FROM funds WHERE id = $1 AND user_id = $2',
        [fid, uid]
      )).rows[0];
      if (!destFund) return res.json({ success: false, message: 'صندوق غير صالح' });

      if (mode === 'payable') {
        const offsetUsd = await sumFundReferenceAndReturnUsdForFund(db, fid);
        const appliedOffset = Math.min(amt, offsetUsd);
        const payableInsert = Math.max(0, amt - appliedOffset);
        meta.payableGrossUsd = amt;
        meta.payableOffsetFromReferenceUsd = appliedOffset;
        meta.payableRecordedUsd = payableInsert;
        if (payableInsert > 0.0001) {
          const epNote = `تحويل معتمد — ${accName}${
            appliedOffset > 0.0001 ? ` — بعد خصم ${appliedOffset.toFixed(2)} USD من رصيد مرجعي/مرتجع` : ''
          }${noteUser ? ` — ${noteUser}` : ''}`;
          await db.query(
            `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes, settlement_mode)
             VALUES ($1, 'fund', $2, $3, 'USD', $4, 'payable')`,
            [uid, fid, payableInsert, epNote]
          );
        }
        const ledNote =
          payableInsert > 0.0001
            ? `تحويل إلى معتمد ${accName} — دين علينا (${payableInsert.toFixed(2)} USD)${
                appliedOffset > 0.0001 ? ` — خصم من مرجعي/مرتجع ${appliedOffset.toFixed(2)} USD` : ''
              }${noteUser ? ` — ${noteUser}` : ''}`
            : `تحويل إلى معتمد ${accName} — تسوية كاملة من رصيد مرجعي/مرتجع (${amt.toFixed(2)} USD)${
                noteUser ? ` — ${noteUser}` : ''
              }`;
        await adjustFundBalance(
          db,
          fid,
          'USD',
          0,
          'accreditation_transfer_payable',
          ledNote,
          'accreditation_entities',
          id
        );
      } else if (mode === 'main_fund') {
        const { mainFundId, usd: mainUsd } = await getMainFundUsdBalance(db, uid);
        if (!mainFundId) return res.json({ success: false, message: 'لا يوجد صندوق رئيسي' });
        if ((Number(mainUsd) || 0) < amt - 0.0001) {
          return res.json({
            success: false,
            code: 'INSUFFICIENT_MAIN',
            message: 'رصيد الصندوق الرئيسي غير كافٍ.',
          });
        }
        await adjustFundBalance(
          db,
          mainFundId,
          'USD',
          -amt,
          'accreditation_transfer_from_main',
          `تحويل إلى معتمد ${accName} (صندوق)${noteUser ? ` — ${noteUser}` : ''}`,
          'accreditation_entities',
          id
        );
        await adjustFundBalance(
          db,
          fid,
          'USD',
          amt,
          'accreditation_transfer_in',
          `تحويل إلى معتمد ${accName}${noteUser ? ` — ${noteUser}` : ''}`,
          'accreditation_entities',
          id
        );
      } else {
        await adjustFundBalance(
          db,
          fid,
          'USD',
          amt,
          'accreditation_transfer_in',
          'تحويل من معتمد',
          'accreditation_entities',
          id
        );
      }
    } else if (transferType === 'company') {
      const cid = parseInt(companyId, 10);
      if (!cid) return res.json({ success: false, message: 'اختر الشركة' });
      const comp = (await db.query(
        'SELECT id, name FROM transfer_companies WHERE id = $1 AND user_id = $2',
        [cid, uid]
      )).rows[0];
      if (!comp) return res.json({ success: false, message: 'شركة غير موجودة' });

      if (mode === 'payable') {
        const offsetUsd = await sumCompanyReferenceReturnUsdHeuristic(db, cid);
        const appliedOffset = Math.min(amt, offsetUsd);
        const payableInsert = Math.max(0, amt - appliedOffset);
        meta.payableGrossUsd = amt;
        meta.payableOffsetFromReferenceUsd = appliedOffset;
        meta.payableRecordedUsd = payableInsert;
        if (payableInsert > 0.0001) {
          const epNote = `تحويل معتمد — ${accName}${
            appliedOffset > 0.0001 ? ` — بعد خصم ${appliedOffset.toFixed(2)} USD من رصيد افتتاحي/مرتجع` : ''
          }${noteUser ? ` — ${noteUser}` : ''}`;
          await db.query(
            `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes, settlement_mode)
             VALUES ($1, 'transfer_company', $2, $3, 'USD', $4, 'payable')`,
            [uid, cid, payableInsert, epNote]
          );
        }
        const ledNote =
          payableInsert > 0.0001
            ? `تحويل إلى معتمد ${accName} — دين علينا (${payableInsert.toFixed(2)} USD)${
                appliedOffset > 0.0001 ? ` — خصم من افتتاحي/مرتجع ${appliedOffset.toFixed(2)} USD` : ''
              }${noteUser ? ` — ${noteUser}` : ''}`
            : `تحويل إلى معتمد ${accName} — تسوية كاملة من رصيد افتتاحي/مرتجع (${amt.toFixed(2)} USD)${
                noteUser ? ` — ${noteUser}` : ''
              }`;
        await db.query(
          `INSERT INTO transfer_company_ledger (company_id, amount, currency, notes, ref_table, ref_id)
           VALUES ($1, $2, 'USD', $3, 'accreditation_entities', $4)`,
          [cid, 0, ledNote, id]
        );
      } else if (mode === 'main_fund') {
        const { mainFundId, usd: mainUsd } = await getMainFundUsdBalance(db, uid);
        if (!mainFundId) return res.json({ success: false, message: 'لا يوجد صندوق رئيسي' });
        if ((Number(mainUsd) || 0) < amt - 0.0001) {
          return res.json({
            success: false,
            code: 'INSUFFICIENT_MAIN',
            message: 'رصيد الصندوق الرئيسي غير كافٍ.',
          });
        }
        await adjustFundBalance(
          db,
          mainFundId,
          'USD',
          -amt,
          'accreditation_transfer_from_main',
          `تحويل إلى معتمد ${accName} (شركة)${noteUser ? ` — ${noteUser}` : ''}`,
          'accreditation_entities',
          id
        );
        const ledNote = `تحويل إلى معتمد ${accName}${noteUser ? ` — ${noteUser}` : ''}`;
        await db.query(
          `INSERT INTO transfer_company_ledger (company_id, amount, currency, notes, ref_table, ref_id) VALUES ($1, $2, 'USD', $3, 'accreditation_entities', $4)`,
          [cid, amt, ledNote, id]
        );
        await db.query(
          `UPDATE transfer_companies SET balance_amount = balance_amount + $1 WHERE id = $2 AND user_id = $3`,
          [amt, cid, uid]
        );
      } else {
        await db.query(
          `INSERT INTO transfer_company_ledger (company_id, amount, currency, notes, ref_table, ref_id) VALUES ($1, $2, 'USD', $3, 'accreditation_entities', $4)`,
          [cid, amt, noteUser || 'تحويل معتمد', id]
        );
        await db.query(
          `UPDATE transfer_companies SET balance_amount = balance_amount + $1 WHERE id = $2 AND user_id = $3`,
          [amt, cid, uid]
        );
      }
    }

    let pay = Number(ent.balance_payable) || 0;
    let rec = Number(ent.balance_receivable) || 0;
    const buckets = applyTransferOut(pay, rec, amt);
    pay = buckets.pay;
    rec = buckets.rec;
    const metaJson = JSON.stringify(meta);
    await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, notes, meta_json)
       VALUES ($1, 'transfer', $2, 'USD', $3, $4)`,
      [id, amt, noteUser, metaJson]
    );
    await db.query(
      'UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3',
      [pay, rec, id]
    );
    await syncNetBalance(db, id);
    const out = (await db.query(
      'SELECT balance_amount, balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1',
      [id]
    )).rows[0];
    res.json({
      success: true,
      message: 'تم التحويل',
      newBalance: out.balance_amount,
      balance_payable: out.balance_payable,
      balance_receivable: out.balance_receivable,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const row = (await db.query(
      'SELECT * FROM accreditation_entities WHERE id = $1 AND user_id = $2',
      [id, req.session.userId]
    )).rows[0];
    if (!row) return res.json({ success: false, message: 'غير موجود' });
    const ledgerRaw = (await db.query(
      'SELECT * FROM accreditation_ledger WHERE accreditation_id = $1 ORDER BY created_at DESC LIMIT 300',
      [id]
    )).rows;
    const ledger = computeLedgerWithBalanceAfter(row, ledgerRaw);
    const payN = roundMoney(row.balance_payable);
    const recN = roundMoney(row.balance_receivable);
    const settlementPending = payN > 0.0001 && recN > 0.0001;
    const maxSettlement = settlementPending ? roundMoney(Math.min(payN, recN)) : 0;
    res.json({
      success: true,
      entity: row,
      ledger,
      settlementPending,
      maxSettlement,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
