const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { adjustFundBalance, getMainFundId } = require('../services/fundService');

router.get('/list', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query(
      `SELECT id, name, code, balance_amount, pinned, created_at
       FROM accreditation_entities WHERE user_id = $1
       ORDER BY pinned DESC, name`,
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

/** إضافة مبلغ (راتب لنا/عليه + وساطة + دورة) */
router.post('/:id/add-amount', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { salaryDirection, amount, brokeragePct, cycleId, notes } = req.body || {};
    const amt = parseFloat(amount);
    if (!id || isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const db = getDb();
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
    const mainFundId = await getMainFundId(db, req.session.userId);
    if (brokerageAmount > 0 && mainFundId) {
      await adjustFundBalance(
        db, mainFundId, 'USD', brokerageAmount, 'accreditation_brokerage',
        'وساطة معتمد', 'accreditation_ledger', ledgerId
      );
    }
    if (remainder !== 0 && dir === 'to_us' && mainFundId) {
      await adjustFundBalance(
        db, mainFundId, 'USD', remainder, 'accreditation_remainder',
        'باقي بعد الوساطة', 'accreditation_ledger', ledgerId
      );
    }
    res.json({ success: true, message: 'تم التسجيل', newBalance: newBal });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** تحويل: تسليم يدوي | صندوق | شركة | شحن (تسجيل فقط) */
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
    if (prevBal <= 0 && newBal < prevBal) {
      /* دين عليه إن رُفع الرصيد السالب */
    }
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
