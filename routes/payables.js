const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { computeDebtBreakdown } = require('../services/debtAggregation');

/** ملخص «دين علينا» حسب التصنيف */
router.get('/overview', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.userId;
    const breakdown = await computeDebtBreakdown(db, userId);

    const payRows = (await db.query(
      `SELECT id, entity_type, entity_id, amount, currency, notes, created_at
       FROM entity_payables WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [userId]
    )).rows;

    const negCompanies = (await db.query(
      `SELECT id, name, balance_amount FROM transfer_companies WHERE user_id = $1 AND balance_amount < 0 ORDER BY balance_amount`,
      [userId]
    )).rows;

    const negFunds = (await db.query(
      `SELECT f.id, f.name, fb.amount FROM funds f
       JOIN fund_balances fb ON fb.fund_id = f.id
       WHERE f.user_id = $1 AND fb.amount < 0 AND fb.currency = 'USD'`,
      [userId]
    )).rows;

    res.json({
      success: true,
      breakdown,
      entityPayablesSplit: {
        fromAccreditationTransferUsd: breakdown.entityPayablesFromAccTransferUsd ?? 0,
        otherUsd: breakdown.entityPayablesOtherUsd ?? 0,
      },
      payables: payRows,
      negativeCompanies: negCompanies,
      negativeFunds: negFunds,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
