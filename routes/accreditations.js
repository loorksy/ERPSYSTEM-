const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { adjustFundBalance, getMainFundId } = require('../services/fundService');
const { insertLedgerEntry } = require('../services/ledgerService');
const { processAccreditationBulkRows, parseCsvTextToRows } = require('../services/accreditationBulkImport');
const { extractSpreadsheetIdFromUrl, fetchSheetRowsUsingStoredGoogleConfig } = require('../services/googleSheetReadService');

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
      `SELECT id, name, code, balance_amount, pinned, is_primary, created_at
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

/** إضافة مبلغ: وساطة → صافي الربح، الباقي → الصندوق الرئيسي */
router.post('/:id/add-amount', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { salaryDirection, amount, brokeragePct, cycleId, notes } = req.body || {};
    const amt = parseFloat(amount);
    if (!id || isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const db = getDb();
    const mainFundId = await getMainFundId(db, req.session.userId);
    if (!mainFundId) {
      return res.json({ success: false, message: 'عيّن صندوقاً رئيسياً من قسم الصناديع قبل إضافة مبالغ.' });
    }
    const ent = (await db.query(
      'SELECT id, balance_amount FROM accreditation_entities WHERE id = $1 AND user_id = $2',
      [id, req.session.userId]
    )).rows[0];
    if (!ent) return res.json({ success: false, message: 'غير موجود' });
    const pct = parseFloat(brokeragePct);
    const brokerageAmount = !isNaN(pct) && pct > 0 ? amt * (pct / 100) : 0;
    const remainder = amt - brokerageAmount;
    const dir = salaryDirection === 'to_us' ? 'to_us' : 'to_them';
    const signed = dir === 'to_us' ? amt : -amt;
    const led = await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, brokerage_pct, brokerage_amount, cycle_id, notes)
       VALUES ($1, 'salary', $2, 'USD', $3, $4, $5, $6, $7) RETURNING id`,
      [id, amt, dir, !isNaN(pct) ? pct : null, brokerageAmount || null, cycleId ? parseInt(cycleId, 10) : null, notes || null]
    );
    const ledgerId = led.rows[0]?.id;
    const newBal = (ent.balance_amount || 0) + signed;
    await db.query('UPDATE accreditation_entities SET balance_amount = $1 WHERE id = $2', [newBal, id]);

    if (brokerageAmount > 0) {
      await insertLedgerEntry(db, {
        userId: req.session.userId,
        bucket: 'net_profit',
        sourceType: 'accreditation_brokerage',
        amount: brokerageAmount,
        cycleId: cycleId ? parseInt(cycleId, 10) : null,
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
        cycleId: cycleId ? parseInt(cycleId, 10) : null,
        refTable: 'accreditation_ledger',
        refId: ledgerId,
        notes: 'باقي بعد الوساطة',
      });
    }
    res.json({ success: true, message: 'تم التسجيل', newBalance: newBal });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** رفع أرصدة: أعمدة A كود، B اسم، C رصيد، D معتمد رئيسي (كود أو اسم) */
router.post('/bulk-balance', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { cycleId } = req.body || {};
    if (!req.file) return res.json({ success: false, message: 'الملف مطلوب' });
    const rows = parseUploadedRows(req.file.path, req.file.mimetype);
    const db = getDb();
    const out = await processAccreditationBulkRows(db, req.session.userId, rows, cycleId);
    res.json(out);
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** لصق CSV/TSV كنص (نفس أعمدة الملف) */
router.post('/bulk-balance-text', requireAuth, async (req, res) => {
  try {
    const { csvText, cycleId } = req.body || {};
    const rows = parseCsvTextToRows(csvText || '');
    const db = getDb();
    const out = await processAccreditationBulkRows(db, req.session.userId, rows, cycleId);
    res.json(out);
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** جلب ورقة من رابط Google Sheet (يتطلب ربط Google في إعدادات الجداول) */
router.post('/bulk-balance-sheet-url', requireAuth, async (req, res) => {
  try {
    const { sheetUrl, sheetName, cycleId } = req.body || {};
    const sid = extractSpreadsheetIdFromUrl(sheetUrl);
    if (!sid) return res.json({ success: false, message: 'رابط Google Sheet غير صالح' });
    const db = getDb();
    const result = await fetchSheetRowsUsingStoredGoogleConfig(db, sid, sheetName || null);
    const rows = result.values || [];
    if (rows.length < 2) {
      return res.json({ success: false, message: 'الورقة فارغة أو غير قابلة للقراءة', sheetTitleUsed: result.sheetTitleUsed });
    }
    const out = await processAccreditationBulkRows(db, req.session.userId, rows, cycleId);
    res.json({ ...out, sheetTitleUsed: result.sheetTitleUsed });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الورقة' });
  }
});

/** تسليم: تصفير أرصدة معتمدين (بدون خصم من الصندوق) */
router.post('/delivery-settle', requireAuth, async (req, res) => {
  try {
    const { cycleId, accreditationIds } = req.body || {};
    const cid = cycleId ? parseInt(cycleId, 10) : null;
    const ids = Array.isArray(accreditationIds) ? accreditationIds.map(x => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return res.json({ success: false, message: 'اختر معتمداً واحداً على الأقل' });
    const db = getDb();
    for (const aid of ids) {
      const ent = (await db.query(
        'SELECT id, balance_amount FROM accreditation_entities WHERE id = $1 AND user_id = $2',
        [aid, req.session.userId]
      )).rows[0];
      if (!ent) continue;
      const prev = ent.balance_amount || 0;
      if (prev === 0) continue;
      await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes)
         VALUES ($1, 'delivery', $2, 'USD', 'to_them', $3, $4)`,
        [aid, Math.abs(prev), cid, 'تسليم راتب — تصفير محاسبي']
      );
      await db.query('UPDATE accreditation_entities SET balance_amount = 0 WHERE id = $1', [aid]);
    }
    res.json({ success: true, message: 'تم التسليم' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** قائمة معتمدين برصيد لدورة */
router.get('/with-balance', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query(
      `SELECT id, name, code, balance_amount FROM accreditation_entities
       WHERE user_id = $1 AND balance_amount > 0.0001 ORDER BY name`,
      [req.session.userId]
    )).rows;
    res.json({ success: true, list: rows });
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
    const prevBal = ent.balance_amount || 0;
    const newBal = prevBal - amt;
    await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, notes, meta_json)
       VALUES ($1, 'transfer', $2, 'USD', $3, $4)`,
      [id, amt, notes || null, metaJson]
    );
    await db.query('UPDATE accreditation_entities SET balance_amount = $1 WHERE id = $2', [newBal, id]);
    res.json({ success: true, message: 'تم التحويل', newBalance: newBal });
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
