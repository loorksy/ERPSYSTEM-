const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { adjustFundBalance, getMainFundId } = require('../services/fundService');
const { insertLedgerEntry } = require('../services/ledgerService');

router.post('/add', requireAuth, async (req, res) => {
  try {
    const { cycleId, amount, brokeragePct, notes } = req.body || {};
    const amt = parseFloat(amount);
    const pct = parseFloat(brokeragePct);
    if (isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const db = getDb();
    const mainFundId = await getMainFundId(db, req.session.userId);
    if (!mainFundId) return res.json({ success: false, message: 'عيّن صندوقاً رئيسياً' });
    const p = !isNaN(pct) && pct > 0 ? Math.min(100, pct) : 0;
    const profitAmount = amt * (p / 100);
    const mainFundAmount = amt - profitAmount;

    const cid = cycleId ? parseInt(cycleId, 10) : null;
    const ins = await db.query(
      `INSERT INTO admin_brokerage_entries (user_id, cycle_id, amount, brokerage_pct, profit_amount, main_fund_amount, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.session.userId, cid, amt, p, profitAmount, mainFundAmount, notes || null]
    );
    const entryId = ins.rows[0].id;

    if (profitAmount > 0) {
      await insertLedgerEntry(db, {
        userId: req.session.userId,
        bucket: 'net_profit',
        sourceType: 'admin_brokerage',
        amount: profitAmount,
        cycleId: cid,
        refTable: 'admin_brokerage_entries',
        refId: entryId,
        notes: 'وساطة إدارية — ربح',
      });
    }
    if (mainFundAmount > 0) {
      await adjustFundBalance(
        db, mainFundId, 'USD', mainFundAmount, 'admin_brokerage',
        'وساطة إدارية — صندوق', 'admin_brokerage_entries', entryId
      );
      await insertLedgerEntry(db, {
        userId: req.session.userId,
        bucket: 'main_cash',
        sourceType: 'admin_brokerage',
        amount: mainFundAmount,
        cycleId: cid,
        refTable: 'admin_brokerage_entries',
        refId: entryId,
        notes: 'وساطة إدارية — رصيد',
      });
    }
    res.json({ success: true, message: 'تم التسجيل', id: entryId });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
