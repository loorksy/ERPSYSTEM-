const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { computeDebtBreakdown } = require('../services/debtAggregation');

/** ملخص الديون للصفحة الرئيسية للديون */
router.get('/overview', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.userId;

    const breakdown = await computeDebtBreakdown(db, userId);

    const negCompanies = (await db.query(
      `SELECT id, name, balance_amount, balance_currency
       FROM transfer_companies
       WHERE user_id = $1 AND balance_amount < 0
       ORDER BY balance_amount ASC`,
      [userId]
    )).rows;

    const negFunds = (await db.query(
      `SELECT f.id, f.name, fb.amount, fb.currency
       FROM funds f
       JOIN fund_balances fb ON fb.fund_id = f.id
       WHERE f.user_id = $1 AND fb.amount < 0 AND fb.currency = 'USD'`,
      [userId]
    )).rows;

    let payablesList = [];
    try {
      payablesList = (await db.query(
        `SELECT id, entity_type, entity_id, amount, currency, notes, created_at
         FROM entity_payables WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [userId]
      )).rows;
    } catch (_) {}

    res.json({
      success: true,
      ...breakdown,
      negativeCompanies: negCompanies,
      negativeFunds: negFunds,
      payablesList,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', totalDebts: 0 });
  }
});

/** تسجيل دين صريح (مديونية على حسابنا) */
router.post('/register', requireAuth, async (req, res) => {
  try {
    const { entityType, entityId, amount, currency, notes } = req.body || {};
    const et = entityType === 'fund' ? 'fund' : 'transfer_company';
    const eid = parseInt(entityId, 10);
    const amt = parseFloat(amount);
    const cur = (currency || 'USD').trim();
    if (!eid || isNaN(amt) || amt <= 0) {
      return res.json({ success: false, message: 'كيان ومبلغ صالحان مطلوبان' });
    }
    const db = getDb();
    const userId = req.session.userId;
    if (et === 'transfer_company') {
      const ok = (await db.query('SELECT id FROM transfer_companies WHERE id = $1 AND user_id = $2', [eid, userId])).rows[0];
      if (!ok) return res.json({ success: false, message: 'شركة غير موجودة' });
    } else {
      const ok = (await db.query('SELECT id FROM funds WHERE id = $1 AND user_id = $2', [eid, userId])).rows[0];
      if (!ok) return res.json({ success: false, message: 'صندوق غير موجود' });
    }
    const r = await db.query(
      `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, et, eid, amt, cur, notes || null]
    );
    res.json({ success: true, id: r.rows[0].id, message: 'تم تسجيل الدين' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
