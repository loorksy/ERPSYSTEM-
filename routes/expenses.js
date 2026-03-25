const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { insertLedgerEntry, sumLedgerBucket, aggregateNetProfitBySource } = require('../services/ledgerService');
const { adjustFundBalance, getMainFundId } = require('../services/fundService');

router.get('/total', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const t = await sumLedgerBucket(db, req.session.userId, 'expense', 'USD');
    res.json({ success: true, total: t });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', total: 0 });
  }
});

/** سجل مصاريف موحّد: قيود الدفتر (expense) + سجلات يدوية بلا قيد مزدوج */
router.get('/ledger-unified', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.userId;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 400, 1), 500);
    const sourceFilter = (req.query.sourceType && String(req.query.sourceType).trim()) || null;

    const p = [userId];
    let sql = `
      SELECT id, created_at, amount, source_type, notes, ref_table, ref_id, direction,
             'ledger' AS source_kind
      FROM ledger_entries
      WHERE user_id = $1 AND bucket = 'expense' AND currency = 'USD'`;
    if (sourceFilter) {
      sql += ` AND source_type = $${p.length + 1}`;
      p.push(sourceFilter);
    }
    sql += ` ORDER BY created_at DESC LIMIT $${p.length + 1}`;
    p.push(limit);

    const ledgerRows = (await db.query(sql, p)).rows;

    const manualRows = (await db.query(
      `SELECT e.id, e.created_at, e.amount,
              COALESCE(e.category, 'manual') AS source_type,
              e.notes, 'expense_entries' AS ref_table, e.id AS ref_id,
              1 AS direction, 'manual_entry' AS source_kind
       FROM expense_entries e
       WHERE e.user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM ledger_entries l
         WHERE l.user_id = e.user_id AND l.ref_table = 'expense_entries' AND l.ref_id = e.id
       )
       ORDER BY e.created_at DESC
       LIMIT $2`,
      [userId, limit]
    )).rows;

    const merged = [...ledgerRows, ...manualRows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
    res.json({ success: true, rows: merged });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', rows: [] });
  }
});

/** تقرير مصادر صافي الربح حسب source_type */
router.get('/net-profit-by-source', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = await aggregateNetProfitBySource(db, req.session.userId);
    res.json({ success: true, rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', rows: [] });
  }
});

router.post('/add', requireAuth, async (req, res) => {
  try {
    const { amount, category, notes, debitMainFund } = req.body || {};
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const db = getDb();
    const userId = req.session.userId;
    if (debitMainFund) {
      const mainId = await getMainFundId(db, userId);
      if (!mainId) return res.json({ success: false, message: 'عيّن صندوقاً رئيسياً أولاً' });
      await adjustFundBalance(db, mainId, 'USD', -amt, 'manual_expense', notes || 'مصروف — خصم من الرئيسي', 'expense_entries', null);
    }
    const r = await db.query(
      `INSERT INTO expense_entries (user_id, amount, currency, category, notes) VALUES ($1, $2, 'USD', $3, $4) RETURNING id`,
      [userId, amt, category || 'manual', notes || null]
    );
    const id = r.rows[0].id;
    await insertLedgerEntry(db, {
      userId,
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
