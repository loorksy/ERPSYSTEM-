const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { insertLedgerEntry, sumLedgerBucket } = require('../services/ledgerService');

router.get('/total', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const t = await sumLedgerBucket(db, req.session.userId, 'expense', 'USD');
    res.json({ success: true, total: t });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', total: 0 });
  }
});

router.post('/add', requireAuth, async (req, res) => {
  try {
    const { amount, category, notes } = req.body || {};
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const db = getDb();
    const r = await db.query(
      `INSERT INTO expense_entries (user_id, amount, currency, category, notes) VALUES ($1, $2, 'USD', $3, $4) RETURNING id`,
      [req.session.userId, amt, category || 'manual', notes || null]
    );
    const id = r.rows[0].id;
    await insertLedgerEntry(db, {
      userId: req.session.userId,
      bucket: 'expense',
      sourceType: 'manual_expense',
      amount: amt,
      refTable: 'expense_entries',
      refId: id,
      notes: notes || 'مصروف يدوي',
    });
    res.json({ success: true, message: 'تم التسجيل', id });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
