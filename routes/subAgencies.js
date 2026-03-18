const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');

/** قائمة الوكالات مع الرصيد */
router.get('/list', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const agencies = db.prepare(`
      SELECT id, name, commission_percent, created_at
      FROM shipping_sub_agencies
      ORDER BY name
    `).all();
    const balances = agencies.map(a => {
      const bal = calculateAgencyBalance(db, a.id);
      return { ...a, balance: bal };
    });
    res.json({ success: true, agencies: balances });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الوكالات' });
  }
});

/** حساب رصيد الوكالة: أرباح + مكافآت - خصومات - مستحقات */
function calculateAgencyBalance(db, subAgencyId) {
  const rows = db.prepare(`
    SELECT type, SUM(amount) as total
    FROM sub_agency_transactions
    WHERE sub_agency_id = ?
    GROUP BY type
  `).all(subAgencyId);
  let balance = 0;
  rows.forEach(r => {
    const t = r.total || 0;
    if (r.type === 'profit' || r.type === 'reward') balance += t;
    else if (r.type === 'deduction' || r.type === 'due') balance -= t;
  });
  return balance;
}

/** إضافة وكالة */
router.post('/add', requireAuth, (req, res) => {
  try {
    const { name, commissionPercent } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'اسم الوكالة مطلوب' });
    const db = getDb();
    const pct = parseFloat(commissionPercent);
    const pctVal = isNaN(pct) || pct < 0 ? 0 : Math.min(100, pct);
    const r = db.prepare('INSERT INTO shipping_sub_agencies (name, commission_percent) VALUES (?, ?)').run(String(name).trim(), pctVal);
    res.json({ success: true, message: 'تم إضافة الوكالة', id: r.lastInsertRowid });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإضافة' });
  }
});

/** تحديث نسبة الوكالة */
router.post('/:id/update-percent', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { commissionPercent } = req.body || {};
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const pct = parseFloat(commissionPercent);
    const pctVal = isNaN(pct) || pct < 0 ? 0 : Math.min(100, pct);
    const db = getDb();
    db.prepare('UPDATE shipping_sub_agencies SET commission_percent = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(pctVal, id);
    res.json({ success: true, message: 'تم تحديث النسبة' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل التحديث' });
  }
});

/** تفاصيل وكالة واحدة */
router.get('/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const agency = db.prepare('SELECT * FROM shipping_sub_agencies WHERE id = ?').get(id);
    if (!agency) return res.json({ success: false, message: 'الوكالة غير موجودة' });
    const balance = calculateAgencyBalance(db, id);
    res.json({ success: true, agency: { ...agency, balance } });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب التفاصيل' });
  }
});

/** الدورات المالية */
router.get('/cycles/list', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id, name FROM financial_cycles WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
    res.json({ success: true, cycles: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الدورات', cycles: [] });
  }
});

/** حساب ربح الوكالة (يشمل الأرباح + المكافآت) */
router.get('/:id/profit', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { cycleId } = req.query || {};
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const agency = db.prepare('SELECT commission_percent FROM shipping_sub_agencies WHERE id = ?').get(id);
    if (!agency) return res.json({ success: false, message: 'الوكالة غير موجودة' });
    let sql = `SELECT SUM(amount) as total FROM sub_agency_transactions WHERE sub_agency_id = ? AND type IN ('profit', 'reward')`;
    const params = [id];
    if (cycleId) { sql += ' AND cycle_id = ?'; params.push(cycleId); }
    const row = db.prepare(sql).get(...params);
    const profit = row?.total || 0;
    res.json({ success: true, profit, commissionPercent: agency.commission_percent });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الربح' });
  }
});

/** إضافة مكافأة */
router.post('/:id/reward', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, notes } = req.body || {};
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'المبلغ غير صالح' });
    const db = getDb();
    db.prepare(`
      INSERT INTO sub_agency_transactions (sub_agency_id, type, amount, notes)
      VALUES (?, 'reward', ?, ?)
    `).run(id, amt, notes || null);
    res.json({ success: true, message: 'تم إضافة المكافأة' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإضافة' });
  }
});

/** سجل المعاملات */
router.get('/:id/transactions', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { fromDate, toDate, type } = req.query || {};
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    let sql = 'SELECT * FROM sub_agency_transactions WHERE sub_agency_id = ?';
    const params = [id];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (fromDate) { sql += ' AND date(created_at) >= date(?)'; params.push(fromDate); }
    if (toDate) { sql += ' AND date(created_at) <= date(?)'; params.push(toDate); }
    sql += ' ORDER BY created_at DESC';
    const rows = db.prepare(sql).all(...params);
    const typeLabels = { profit: 'ربح', reward: 'مكافأة', deduction: 'خصم', due: 'مستحقات' };
    const list = rows.map(r => ({ ...r, typeLabel: typeLabels[r.type] || r.type }));
    res.json({ success: true, transactions: list });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب السجل' });
  }
});

/** المستخدمين التابعين للوكالة (من الشحن) */
router.get('/:id/users', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const rows = db.prepare(`
      SELECT DISTINCT buyer_user_id as user_id
      FROM shipping_transactions
      WHERE buyer_type = 'sub_agent' AND buyer_sub_agency_id = ? AND buyer_user_id IS NOT NULL
    `).all(id);
    const users = rows.map(r => ({ id: r.user_id, name: r.user_id }));
    res.json({ success: true, users });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب المستخدمين', users: [] });
  }
});

/** ربط عمليات الشحن: عند البيع لوكيل فرعي نضيف ربح + خصم إن وجد */
function registerShippingForAgency(db, tx) {
  if (tx.type !== 'sell' || tx.buyer_type !== 'sub_agent' || !tx.buyer_sub_agency_id) return;
  const agency = db.prepare('SELECT commission_percent FROM shipping_sub_agencies WHERE id = ?').get(tx.buyer_sub_agency_id);
  if (!agency) return;
  const profit = (tx.total || 0) * (agency.commission_percent || 0) / 100;
  if (profit > 0) {
    db.prepare(`
      INSERT INTO sub_agency_transactions (sub_agency_id, type, amount, notes, shipping_transaction_id)
      VALUES (?, 'profit', ?, ?, ?)
    `).run(tx.buyer_sub_agency_id, profit, 'ربح من بيع', tx.id);
  }
  if (tx.payment_method === 'agency_deduction' && tx.total > 0) {
    db.prepare(`
      INSERT INTO sub_agency_transactions (sub_agency_id, type, amount, notes, shipping_transaction_id)
      VALUES (?, 'due', ?, ?, ?)
    `).run(tx.buyer_sub_agency_id, tx.total, 'خصم من نسبة الوكالة', tx.id);
  }
}

module.exports = router;
module.exports.registerShippingForAgency = registerShippingForAgency;
