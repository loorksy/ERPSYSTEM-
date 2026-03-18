const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { registerShippingForAgency } = require('./subAgencies');

// جلب الرصيد: رصيد الذهب = إجمالي الشراء ذهب - إجمالي البيع ذهب
router.get('/balance', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT type, item_type, SUM(quantity) as sum_qty
      FROM shipping_transactions
      GROUP BY type, item_type
    `).all();
    let goldBalance = 0;
    let crystalBalance = 0;
    rows.forEach(r => {
      const qty = r.sum_qty || 0;
      if (r.item_type === 'gold') {
        if (r.type === 'buy') goldBalance += qty;
        else goldBalance -= qty;
      } else if (r.item_type === 'crystal') {
        if (r.type === 'buy') crystalBalance += qty;
        else crystalBalance -= qty;
      }
    });
    res.json({ success: true, goldBalance, crystalBalance });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الرصيد' });
  }
});

// قائمة المعتمدين
router.get('/approved', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id, name FROM shipping_approved ORDER BY name').all();
    res.json({ success: true, list: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب المعتمدين' });
  }
});

// قائمة الوكالات الفرعية
router.get('/sub-agencies', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id, name FROM shipping_sub_agencies ORDER BY name').all();
    res.json({ success: true, list: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الوكالات' });
  }
});

// قائمة الشركات
router.get('/companies', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id, name FROM shipping_companies ORDER BY name').all();
    res.json({ success: true, list: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الشركات' });
  }
});

// قائمة المستخدمين (للخصم من الراتب) - يمكن ربطها لاحقاً من الرواتب
router.get('/users', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const cycles = db.prepare('SELECT id FROM financial_cycles WHERE user_id = ?').all(req.session.userId);
    const userIds = new Set();
    cycles.forEach(c => {
      const cache = db.prepare('SELECT management_data, agent_data FROM payroll_cycle_cache WHERE user_id = ? AND cycle_id = ?').get(req.session.userId, c.id);
      if (cache) {
        const parse = (d) => d ? (JSON.parse(d) || []) : [];
        for (const row of [...parse(cache.management_data), ...parse(cache.agent_data)]) {
          const id = row.user_id ?? row.userId ?? row.user_id_col ?? row.id;
          if (id != null) userIds.add(String(id));
        }
      }
    });
    const list = Array.from(userIds).sort().map(id => ({ id, name: id }));
    res.json({ success: true, list });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب المستخدمين', list: [] });
  }
});

// إضافة معتمد
router.post('/approved', requireAuth, (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'الاسم مطلوب' });
    const db = getDb();
    const r = db.prepare('INSERT INTO shipping_approved (name) VALUES (?)').run(String(name).trim());
    res.json({ success: true, message: 'تم إضافة المعتمد', id: r.lastInsertRowid });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإضافة' });
  }
});

// إضافة وكالة فرعية (من الشحن أو الوكالات)
router.post('/sub-agencies', requireAuth, (req, res) => {
  try {
    const { name, commissionPercent } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'الاسم مطلوب' });
    const db = getDb();
    const pct = parseFloat(commissionPercent);
    const pctVal = (isNaN(pct) || pct < 0) ? 0 : Math.min(100, pct);
    const r = db.prepare('INSERT INTO shipping_sub_agencies (name, commission_percent) VALUES (?, ?)').run(String(name).trim(), pctVal);
    res.json({ success: true, message: 'تم إضافة الوكالة', id: r.lastInsertRowid });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإضافة' });
  }
});

// إضافة شركة
router.post('/companies', requireAuth, (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'اسم الشركة مطلوب' });
    const db = getDb();
    const r = db.prepare('INSERT INTO shipping_companies (name) VALUES (?)').run(String(name).trim());
    res.json({ success: true, message: 'تم إضافة الشركة', id: r.lastInsertRowid });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإضافة' });
  }
});

// إضافة عملية بيع
router.post('/sell', requireAuth, (req, res) => {
  try {
    const body = req.body || {};
    const { buyerType, userNumber, approvedId, subAgencyId, itemType, quantity, unitPrice, paymentMethod, salaryDeductionUserId, notes } = body;
    const qty = parseFloat(quantity);
    const price = parseFloat(unitPrice);
    if (!itemType || !buyerType || !quantity || isNaN(qty) || qty <= 0 || isNaN(price) || price < 0 || !paymentMethod) {
      return res.json({ success: false, message: 'تأكد من ملء جميع الحقول المطلوبة' });
    }
    const total = qty * price;
    const status = paymentMethod === 'debt' ? 'debt' : 'completed';
    const db = getDb();
    const r = db.prepare(`
      INSERT INTO shipping_transactions (type, item_type, quantity, unit_price, total, payment_method, status, buyer_type, buyer_user_id, buyer_approved_id, buyer_sub_agency_id, salary_deduction_user_id, notes)
      VALUES ('sell', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemType, qty, price, total, paymentMethod, status, buyerType, buyerType === 'user' ? (userNumber || null) : null, buyerType === 'approved' ? (approvedId || null) : null, buyerType === 'sub_agent' ? (subAgencyId || null) : null, paymentMethod === 'salary_deduction' ? (salaryDeductionUserId || null) : null, notes || null);
    const txId = r.lastInsertRowid;
    const txRow = { id: txId, type: 'sell', buyer_type: buyerType, buyer_sub_agency_id: subAgencyId ? parseInt(subAgencyId, 10) : null, payment_method: paymentMethod, total };
    registerShippingForAgency(db, txRow);
    res.json({ success: true, message: 'تم تسجيل عملية البيع' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل تسجيل البيع' });
  }
});

// إضافة عملية شراء
router.post('/buy', requireAuth, (req, res) => {
  try {
    const body = req.body || {};
    const { purchaseSource, companyName, companyId, itemType, quantity, unitPrice, paymentMethod, notes } = body;
    const qty = parseFloat(quantity);
    const price = parseFloat(unitPrice);
    if (!itemType || !purchaseSource || !quantity || isNaN(qty) || qty <= 0 || isNaN(price) || price < 0 || !paymentMethod) {
      return res.json({ success: false, message: 'تأكد من ملء جميع الحقول المطلوبة' });
    }
    const db = getDb();
    let finalCompanyName = null;
    let finalCompanyId = null;
    if (purchaseSource === 'company') {
      if (companyId) {
        const row = db.prepare('SELECT id, name FROM shipping_companies WHERE id = ?').get(companyId);
        if (row) {
          finalCompanyId = row.id;
          finalCompanyName = row.name;
        }
      }
      if (!finalCompanyName && companyName) finalCompanyName = String(companyName).trim();
      if (!finalCompanyName) return res.json({ success: false, message: 'اسم الشركة مطلوب' });
    }
    const total = qty * price;
    const status = paymentMethod === 'debt' ? 'debt' : 'completed';
    db.prepare(`
      INSERT INTO shipping_transactions (type, item_type, quantity, unit_price, total, payment_method, status, purchase_source, purchase_company_id, purchase_company_name, notes)
      VALUES ('buy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemType, qty, price, total, paymentMethod, status, purchaseSource, finalCompanyId, finalCompanyName, notes || null);
    res.json({ success: true, message: 'تم تسجيل عملية الشراء' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل تسجيل الشراء' });
  }
});

// جلب السجل مع التصفية
router.get('/transactions', requireAuth, (req, res) => {
  try {
    const { type, buyerType, buyerId, fromDate, toDate, status } = req.query || {};
    const db = getDb();
    let sql = 'SELECT * FROM shipping_transactions WHERE 1=1';
    const params = [];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (buyerType) { sql += ' AND buyer_type = ?'; params.push(buyerType); }
    if (buyerId) {
      if (buyerType === 'user') { sql += ' AND buyer_user_id = ?'; params.push(buyerId); }
      else if (buyerType === 'approved') { sql += ' AND buyer_approved_id = ?'; params.push(buyerId); }
      else if (buyerType === 'sub_agent') { sql += ' AND buyer_sub_agency_id = ?'; params.push(buyerId); }
    }
    if (fromDate) { sql += ' AND date(created_at) >= date(?)'; params.push(fromDate); }
    if (toDate) { sql += ' AND date(created_at) <= date(?)'; params.push(toDate); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const rows = db.prepare(sql).all(...params);
    res.json({ success: true, transactions: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب السجل' });
  }
});

module.exports = router;
