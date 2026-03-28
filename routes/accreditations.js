const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { adjustFundBalance, getMainFundId } = require('../services/fundService');
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
} = require('../services/accreditationBalance');
const { splitDebtPayableWithDiscount } = require('../services/accreditationDebtAmounts');

const uploadsDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir, limits: { fileSize: 15 * 1024 * 1024 } });

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
 * - راتب لنا/علينا: وساطة → صافي الربح، الباقي → الصندوق الرئيسي (لنا فقط).
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

    // دين علينا — الصافي في الصندوق ومطلوب الدفع؛ الخصم كربح (يتطابق مع إجمالي النقد دون فروق)
    if (kind === 'debt_payable') {
      const mainFundId = await getMainFundId(db, req.session.userId);
      if (!mainFundId) {
        return res.json({ success: false, message: 'عيّن صندوقاً رئيسياً من قسم الصناديق قبل تسجيل دين علينا.' });
      }
      const { netAmt, discountAmt, metaJson } = splitDebtPayableWithDiscount(amt, discountPctRaw);
      const ledgerMeta =
        metaJson ||
        (!isNaN(discountPct) && discountPct > 0 ? JSON.stringify({ discountPct }) : null);
      const noteDebt = notes || (discountAmt > 0
        ? `دين علينا — صافي بعد خصم ${discountPct}%`
        : 'دين علينا — مطلوب دفع');
      pay += netAmt;
      const led = await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
         VALUES ($1, 'debt_to_them', $2, 'USD', 'to_them', $3, $4, $5) RETURNING id`,
        [id, netAmt, cid, noteDebt, ledgerMeta]
      );
      const ledgerId = led.rows[0]?.id;
      await db.query('UPDATE accreditation_entities SET balance_payable = $1 WHERE id = $2', [pay, id]);
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
        message: discountAmt > 0
          ? 'تم تسجيل دين علينا (صافي) والخصم كربح'
          : 'تم تسجيل دين علينا والصندوق الرئيسي',
        newBalance: out.balance_amount,
        balance_payable: out.balance_payable,
        balance_receivable: out.balance_receivable,
      });
    }

    // لهم — مثل «علينا» (صافي + خصم ربح) لكن بدون أي إيداع في الصندوق الرئيسي
    if (kind === 'debt_payable_no_fund') {
      const debtMeta = !isNaN(discountPct) && discountPct > 0 ? JSON.stringify({ discountPct }) : null;
      const { netAmt, discountAmt, metaJson } = splitDebtPayableWithDiscount(amt, discountPctRaw);
      const ledgerMeta = metaJson || debtMeta;
      const noteDebt = notes || (discountAmt > 0
        ? `لهم — صافي بعد خصم ${discountPct}%`
        : 'لهم — مطلوب دفع (بدون صندوق رئيسي)');
      pay += netAmt;
      const led = await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
         VALUES ($1, 'debt_to_them_no_fund', $2, 'USD', 'to_them', $3, $4, $5) RETURNING id`,
        [id, netAmt, cid, noteDebt, ledgerMeta]
      );
      const ledgerId = led.rows[0]?.id;
      await db.query('UPDATE accreditation_entities SET balance_payable = $1 WHERE id = $2', [pay, id]);
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
        message: discountAmt > 0 ? 'تم تسجيل لهم (صافي) والخصم كربح' : 'تم تسجيل لهم — مطلوب دفع فقط',
        newBalance: out.balance_amount,
        balance_payable: out.balance_payable,
        balance_receivable: out.balance_receivable,
      });
    }

    const mainFundId = await getMainFundId(db, req.session.userId);
    if (!mainFundId) {
      return res.json({ success: false, message: 'عيّن صندوقاً رئيسياً من قسم الصناديق قبل إضافة مبالغ.' });
    }
    const pct = parseFloat(brokeragePct);
    const brokerageAmount = !isNaN(pct) && pct > 0 ? amt * (pct / 100) : 0;
    const remainder = amt - brokerageAmount;
    const dir = salaryDirection === 'to_us' ? 'to_us' : 'to_them';

    if (dir === 'to_us') {
      pay += amt;
    } else {
      const br = applySalaryToThem(pay, rec, amt);
      pay = br.pay;
      rec = br.rec;
    }

    const led = await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, brokerage_pct, brokerage_amount, cycle_id, notes)
       VALUES ($1, 'salary', $2, 'USD', $3, $4, $5, $6, $7) RETURNING id`,
      [id, amt, dir, !isNaN(pct) ? pct : null, brokerageAmount || null, cid, notes || null]
    );
    const ledgerId = led.rows[0]?.id;

    await db.query(
      'UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3',
      [pay, rec, id]
    );
    await syncNetBalance(db, id);

    // خصم اختياري من «لنا» عند إضافة مبلغ يزيد رصيد «علينا» (راتب لنا)
    if (dir === 'to_us' && !isNaN(discountPct) && discountPct > 0 && rec > 0) {
      const cut = Math.min(rec, amt * (discountPct / 100));
      rec -= cut;
      await db.query(
        'UPDATE accreditation_entities SET balance_receivable = $1 WHERE id = $2',
        [rec, id]
      );
      await syncNetBalance(db, id);
    }

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
    if (remainder !== 0 && dir === 'to_us') {
      await adjustFundBalance(
        db, mainFundId, 'USD', remainder, 'accreditation_remainder',
        'باقي بعد الوساطة', 'accreditation_ledger', ledgerId
      );
      await insertLedgerEntry(db, {
        userId: req.session.userId,
        bucket: 'main_cash',
        sourceType: 'accreditation_remainder',
        amount: remainder,
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
      message: 'تم التسجيل',
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
    const { cycleId, items, defaultBrokeragePct } = req.body || {};
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return res.json({ success: false, message: 'لا توجد صفوف' });
    const db = getDb();
    const out = await processAccreditationBulkRowsFromItems(db, req.session.userId, list, cycleId, defaultBrokeragePct);
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
    const { transferType, amount, fundId, companyId, notes } = req.body || {};
    const amt = parseFloat(amount);
    if (!id || isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const db = getDb();
    const ent = (await db.query(
      'SELECT * FROM accreditation_entities WHERE id = $1 AND user_id = $2',
      [id, req.session.userId]
    )).rows[0];
    if (!ent) return res.json({ success: false, message: 'غير موجود' });
    const meta = { transferType, fundId, companyId };
    let metaJson = JSON.stringify(meta);
    if (transferType === 'fund') {
      const fid = parseInt(fundId, 10);
      if (!fid) return res.json({ success: false, message: 'اختر الصندوق' });
      await adjustFundBalance(db, fid, 'USD', amt, 'accreditation_transfer_in', 'تحويل من معتمد', 'accreditation_entities', id);
    } else if (transferType === 'company') {
      const cid = parseInt(companyId, 10);
      if (!cid) return res.json({ success: false, message: 'اختر الشركة' });
      await db.query(
        `INSERT INTO transfer_company_ledger (company_id, amount, currency, notes) VALUES ($1, $2, 'USD', $3)`,
        [cid, amt, notes || 'تحويل معتمد']
      );
      await db.query(
        `UPDATE transfer_companies SET balance_amount = balance_amount + $1 WHERE id = $2 AND user_id = $3`,
        [amt, cid, req.session.userId]
      );
    }
    let pay = Number(ent.balance_payable) || 0;
    let rec = Number(ent.balance_receivable) || 0;
    const buckets = applyTransferOut(pay, rec, amt);
    pay = buckets.pay;
    rec = buckets.rec;
    await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, notes, meta_json)
       VALUES ($1, 'transfer', $2, 'USD', $3, $4)`,
      [id, amt, notes || null, metaJson]
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
    const ledger = (await db.query(
      'SELECT * FROM accreditation_ledger WHERE accreditation_id = $1 ORDER BY created_at DESC LIMIT 300',
      [id]
    )).rows;
    res.json({ success: true, entity: row, ledger });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
