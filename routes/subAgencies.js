const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { recalculateSyncProfitsForCycle } = require('../services/agencySyncService');
const { adjustFundBalance, getMainFundId } = require('../services/fundService');
const { insertLedgerEntry } = require('../services/ledgerService');

/** قائمة الوكالات مع الرصيد */
router.get('/list', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const agencies = (await db.query(`
      SELECT id, name, commission_percent, created_at
      FROM shipping_sub_agencies
      ORDER BY name
    `)).rows;
    const balances = [];
    for (const a of agencies) {
      const bal = await calculateAgencyBalance(db, a.id);
      balances.push({ ...a, balance: bal });
    }
    res.json({ success: true, agencies: balances });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الوكالات' });
  }
});

/**
 * وكالات جاهزة للتسليم: رصيد إجمالي > 0.
 * مع cycleId: فقط من له حركة (sub_agency_transactions) مرتبطة بهذه الدورة — التسليم يصفّر الرصيد الكامل كالسابق.
 */
router.get('/delivery-candidates', requireAuth, async (req, res) => {
  try {
    const cycleId = req.query.cycleId ? parseInt(req.query.cycleId, 10) : null;
    const db = getDb();
    const agencies = (await db.query(`
      SELECT id, name, commission_percent, created_at
      FROM shipping_sub_agencies
      ORDER BY name
    `)).rows;
    const out = [];
    for (const a of agencies) {
      const bal = await calculateAgencyBalance(db, a.id);
      if (bal <= 0.0001) continue;
      if (cycleId) {
        const hit = (await db.query(
          `SELECT 1 FROM sub_agency_transactions WHERE sub_agency_id = $1 AND cycle_id = $2 LIMIT 1`,
          [a.id, cycleId]
        )).rows[0];
        if (!hit) continue;
      }
      out.push({ ...a, balance: bal });
    }
    res.json({ success: true, agencies: out, cycleId });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', agencies: [] });
  }
});

/** حساب رصيد الوكالة: أرباح + مكافآت - خصومات - مستحقات */
async function calculateAgencyBalance(db, subAgencyId) {
  const rows = (await db.query(`
    SELECT type, SUM(amount) as total
    FROM sub_agency_transactions
    WHERE sub_agency_id = $1
    GROUP BY type
  `, [subAgencyId])).rows;
  let balance = 0;
  rows.forEach(r => {
    const t = r.total || 0;
    if (r.type === 'profit' || r.type === 'reward') balance += t;
    else if (r.type === 'deduction' || r.type === 'due') balance -= t;
  });
  return balance;
}

/** إضافة وكالة */
router.post('/add', requireAuth, async (req, res) => {
  try {
    const { name, commissionPercent } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'اسم الوكالة مطلوب' });
    const db = getDb();
    const pct = parseFloat(commissionPercent);
    const pctVal = isNaN(pct) || pct < 0 ? 0 : Math.min(100, pct);
    const companyPct = 100 - pctVal;
    const r = await db.query('INSERT INTO shipping_sub_agencies (name, commission_percent, company_percent) VALUES ($1, $2, $3)', [String(name).trim(), pctVal, companyPct]);
    res.json({ success: true, message: 'تم إضافة الوكالة', id: r.lastInsertRowid });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإضافة' });
  }
});

/** حفظ نسبة الوكالة للدورة المالية + إعادة احتساب أرباح المزامنة من عمود W
 * نسبة الوكالة (commissionPercent) = نسبة ربح الشركة من W
 * مثال: 10% → الشركة تأخذ 10% والوكالة تأخذ 90%
 */
router.post('/:id/cycle-percent', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { cycleId, commissionPercent } = req.body || {};
    const cid = parseInt(cycleId, 10);
    if (!id || !cid) return res.json({ success: false, message: 'الوكالة والدورة مطلوبان' });
    const pct = parseFloat(commissionPercent);
    const pctVal = isNaN(pct) || pct < 0 ? 0 : Math.min(100, pct);
    const companyPct = pctVal;
    const db = getDb();
    const cycle = (await db.query('SELECT id FROM financial_cycles WHERE id = $1 AND user_id = $2', [cid, req.session.userId])).rows[0];
    if (!cycle) return res.json({ success: false, message: 'الدورة غير موجودة' });
    await db.query(
      `INSERT INTO sub_agency_cycle_settings (cycle_id, sub_agency_id, commission_percent, company_percent, saved_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (cycle_id, sub_agency_id) DO UPDATE SET
         commission_percent = excluded.commission_percent,
         company_percent = excluded.company_percent,
         saved_at = CURRENT_TIMESTAMP`,
      [cid, id, pctVal, companyPct]
    );
    await recalculateSyncProfitsForCycle(db, cid, req.session.userId);
    res.json({ success: true, message: 'تم حفظ النسبة وإعادة احتساب أرباح المزامنة لهذه الدورة' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الحفظ' });
  }
});

/** تحديث نسبة الوكالة (company_percent = 100 - commission_percent) */
router.post('/:id/update-percent', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { commissionPercent } = req.body || {};
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const pct = parseFloat(commissionPercent);
    const pctVal = isNaN(pct) || pct < 0 ? 0 : Math.min(100, pct);
    const companyPct = 100 - pctVal;
    const db = getDb();
    await db.query('UPDATE shipping_sub_agencies SET commission_percent = $1, company_percent = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [pctVal, companyPct, id]);
    res.json({ success: true, message: 'تم تحديث النسبة' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل التحديث' });
  }
});

/** تفاصيل وكالة واحدة */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const agency = (await db.query('SELECT * FROM shipping_sub_agencies WHERE id = $1', [id])).rows[0];
    if (!agency) return res.json({ success: false, message: 'الوكالة غير موجودة' });
    const balance = await calculateAgencyBalance(db, id);
    res.json({ success: true, agency: { ...agency, balance } });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب التفاصيل' });
  }
});

/** الدورات المالية */
router.get('/cycles/list', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query('SELECT id, name FROM financial_cycles WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId])).rows;
    res.json({ success: true, cycles: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الدورات', cycles: [] });
  }
});

/** حساب ربح الوكالة (يشمل الأرباح + المكافآت) */
router.get('/:id/profit', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { cycleId } = req.query || {};
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const agency = (await db.query('SELECT commission_percent FROM shipping_sub_agencies WHERE id = $1', [id])).rows[0];
    if (!agency) return res.json({ success: false, message: 'الوكالة غير موجودة' });
    let sql = `SELECT SUM(amount) as total FROM sub_agency_transactions WHERE sub_agency_id = $1 AND type IN ('profit', 'reward')`;
    const params = [id];
    if (cycleId) { sql += ` AND cycle_id = $${params.length + 1}`; params.push(cycleId); }
    const row = (await db.query(sql, params)).rows[0];
    const profit = row?.total || 0;
    let cycleCommissionPercent = null;
    if (cycleId) {
      const s = (await db.query(
        'SELECT commission_percent FROM sub_agency_cycle_settings WHERE cycle_id = $1 AND sub_agency_id = $2',
        [cycleId, id]
      )).rows[0];
      cycleCommissionPercent = s?.commission_percent ?? null;
    }
    res.json({
      success: true,
      profit,
      commissionPercent: agency.commission_percent,
      cycleCommissionPercent,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الربح' });
  }
});

/** تسليم: تصفير رصيد وكالة فرعية محاسبياً (بدون خصم من الصندوق) */
router.post('/delivery-settle', requireAuth, async (req, res) => {
  try {
    const { cycleId, subAgencyIds } = req.body || {};
    const ids = Array.isArray(subAgencyIds) ? subAgencyIds.map(x => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return res.json({ success: false, message: 'اختر وكالة واحدة على الأقل' });
    const db = getDb();
    const cid = cycleId ? parseInt(cycleId, 10) : null;
    for (const sid of ids) {
      const bal = await calculateAgencyBalance(db, sid);
      if (bal <= 0) continue;
      await db.query(
        `INSERT INTO sub_agency_transactions (sub_agency_id, type, amount, notes, cycle_id)
         VALUES ($1, 'deduction', $2, $3, $4)`,
        [sid, bal, 'تسليم راتب — تصفير محاسبي', cid]
      );
    }
    res.json({ success: true, message: 'تم التسليم' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** إضافة مكافأة — افتراضياً خصم من الصندوق إذا كان الرصيد غير سالب؛ إذا كانت الوكالة مدينة لنا (رصيد سالب) يُسجَّل الائتمان فقط دون خصم نقدي ما لم يُفعَّل «خصم من الصندوق». */
router.post('/:id/reward', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, notes, deductFromFund } = req.body || {};
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'المبلغ غير صالح' });
    const db = getDb();
    const userId = req.session.userId;
    const balanceBefore = await calculateAgencyBalance(db, id);
    let useFund = deductFromFund;
    if (useFund === undefined || useFund === null) {
      useFund = balanceBefore >= 0;
    } else {
      useFund = Boolean(useFund);
    }
    await db.query(`
      INSERT INTO sub_agency_transactions (sub_agency_id, type, amount, notes)
      VALUES ($1, 'reward', $2, $3)
    `, [id, amt, notes || null]);
    if (useFund) {
      const mainId = await getMainFundId(db, userId);
      if (mainId) {
        await adjustFundBalance(db, mainId, 'USD', -amt, 'sub_agency_reward', notes || 'مكافأة وكالة فرعية', 'shipping_sub_agencies', id);
        await insertLedgerEntry(db, {
          userId,
          bucket: 'expense',
          sourceType: 'sub_agency_reward',
          amount: amt,
          refTable: 'shipping_sub_agencies',
          refId: id,
          notes: notes || 'مكافأة وكالة فرعية',
        });
      }
    }
    const msg = useFund
      ? 'تم إضافة المكافأة وخصمها من الصندوق الرئيسي'
      : 'تم تسجيل المكافأة محاسبياً دون خصم من الصندوق (ائتمان للوكالة فقط)';
    res.json({
      success: true,
      message: msg,
      deductFromFund: useFund,
      balanceBefore,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإضافة' });
  }
});

/** سجل المعاملات */
router.get('/:id/transactions', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { fromDate, toDate, type } = req.query || {};
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    let sql = 'SELECT * FROM sub_agency_transactions WHERE sub_agency_id = $1';
    const params = [id];
    if (type) { sql += ` AND type = $${params.length + 1}`; params.push(type); }
    if (fromDate) { sql += ` AND date(created_at) >= date($${params.length + 1})`; params.push(fromDate); }
    if (toDate) { sql += ` AND date(created_at) <= date($${params.length + 1})`; params.push(toDate); }
    sql += ' ORDER BY created_at DESC';
    const rows = (await db.query(sql, params)).rows;
    const typeLabels = { profit: 'ربح', reward: 'مكافأة', deduction: 'خصم', due: 'مستحقات' };
    const list = rows.map(r => ({ ...r, typeLabel: typeLabels[r.type] || r.type }));
    res.json({ success: true, transactions: list });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب السجل' });
  }
});

/** المستخدمين التابعين للوكالة (من المزامنة + الشحن) */
router.get('/:id/users', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const cycleId = req.query.cycleId ? parseInt(req.query.cycleId, 10) : null;

    let syncedUsers = [];
    try {
      syncedUsers = (await db.query(
        cycleId
          ? `SELECT member_user_id AS user_id, user_name AS name, base_profit_w FROM agency_cycle_users WHERE sub_agency_id = $1 AND cycle_id = $2 ORDER BY member_user_id`
          : `SELECT member_user_id AS user_id, user_name AS name, base_profit_w FROM agency_cycle_users WHERE sub_agency_id = $1 ORDER BY synced_at DESC`,
        cycleId ? [id, cycleId] : [id]
      )).rows;
    } catch (_) {
      syncedUsers = [];
    }

    if (syncedUsers.length > 0) {
      return res.json({ success: true, users: syncedUsers, source: 'sync' });
    }

    let shippingUsers = [];
    try {
      shippingUsers = (await db.query(`
        SELECT DISTINCT buyer_user_id as user_id
        FROM shipping_transactions
        WHERE buyer_type = 'sub_agent' AND buyer_sub_agency_id = $1 AND buyer_user_id IS NOT NULL
      `, [id])).rows;
    } catch (_) {
      shippingUsers = [];
    }
    const users = shippingUsers.map(r => ({ id: r.user_id, name: r.user_id }));
    res.json({ success: true, users, source: 'shipping' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب المستخدمين', users: [] });
  }
});

/** ربط عمليات الشحن: عند البيع لوكيل فرعي نضيف ربح + خصم إن وجد */
async function registerShippingForAgency(db, tx) {
  if (tx.type !== 'sell' || tx.buyer_type !== 'sub_agent' || !tx.buyer_sub_agency_id) return;
  const agency = (await db.query('SELECT commission_percent FROM shipping_sub_agencies WHERE id = $1', [tx.buyer_sub_agency_id])).rows[0];
  if (!agency) return;
  const profit = (tx.total || 0) * (agency.commission_percent || 0) / 100;
  if (profit > 0) {
    await db.query(`
      INSERT INTO sub_agency_transactions (sub_agency_id, type, amount, notes, shipping_transaction_id)
      VALUES ($1, 'profit', $2, $3, $4)
    `, [tx.buyer_sub_agency_id, profit, 'ربح من بيع', tx.id]);
  }
  if (tx.payment_method === 'agency_deduction' && tx.total > 0) {
    await db.query(`
      INSERT INTO sub_agency_transactions (sub_agency_id, type, amount, notes, shipping_transaction_id)
      VALUES ($1, 'due', $2, $3, $4)
    `, [tx.buyer_sub_agency_id, tx.total, 'خصم من نسبة الوكالة', tx.id]);
  }
}

module.exports = router;
module.exports.registerShippingForAgency = registerShippingForAgency;
