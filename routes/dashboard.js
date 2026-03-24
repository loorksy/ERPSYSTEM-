const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { calculateCashBoxBalance, fetchDeferredBalanceUsers } = require('../services/agencySyncService');
const { getFundTotalsByCurrency, getMainFundSummary, transferProfitToFund } = require('../services/fundService');

router.get('/', requireAuth, (req, res) => {
  res.render('dashboard', {
    title: 'لوحة التحكم',
    page: 'home',
    user: req.session.user
  });
});

/** إحصائيات لوحة التحكم: رصيد الصندوق، رصيد المؤجل، رصيد الشحن */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const { cycleId } = req.query || {};
    const db = getDb();
    const userId = req.session.userId;

    let cycles = (await db.query('SELECT id, name FROM financial_cycles WHERE user_id = $1 ORDER BY created_at DESC', [userId])).rows;
    const defaultCycleId = cycleId ? parseInt(cycleId, 10) : (cycles[0]?.id || null);

    let cashBalance = 0;
    let deferredBalance = 0;
    let shippingBalance = 0;
    let snapshotCash = 0;
    let totalRevenue = 0;
    let netProfit = 0;
    let capitalRecovered = 0;
    let totalDebts = 0;
    let accreditationDebtTotal = 0;

    const shipRows = (await db.query(`
      SELECT type, item_type, SUM(quantity) as sum_qty
      FROM shipping_transactions
      GROUP BY type, item_type
    `)).rows;
    let goldBalance = 0;
    let crystalBalance = 0;
    shipRows.forEach(r => {
      const qty = r.sum_qty || 0;
      if (r.item_type === 'gold') {
        if (r.type === 'buy') goldBalance += qty;
        else goldBalance -= qty;
      } else if (r.item_type === 'crystal') {
        if (r.type === 'buy') crystalBalance += qty;
        else crystalBalance -= qty;
      }
    });
    shippingBalance = goldBalance + crystalBalance;

    const sellAgg = (await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status != 'debt' THEN total ELSE 0 END), 0)::float AS revenue_completed,
        COALESCE(SUM(total), 0)::float AS revenue_all,
        COALESCE(SUM(profit_amount), 0)::float AS profit_sum,
        COALESCE(SUM(capital_amount), 0)::float AS capital_sum,
        COALESCE(SUM(CASE WHEN status = 'debt' THEN total ELSE 0 END), 0)::float AS debt_sell
      FROM shipping_transactions WHERE type = 'sell'
    `)).rows[0];
    totalRevenue = sellAgg?.revenue_all ?? 0;
    netProfit = sellAgg?.profit_sum ?? 0;
    capitalRecovered = sellAgg?.capital_sum ?? 0;
    let shippingDebt = sellAgg?.debt_sell ?? 0;

    try {
      const accDebt = (await db.query(`
        SELECT COALESCE(SUM(-balance_amount), 0)::float AS t
        FROM accreditation_entities WHERE user_id = $1 AND balance_amount < 0
      `, [userId])).rows[0];
      accreditationDebtTotal = accDebt?.t ?? 0;
    } catch (_) {
      accreditationDebtTotal = 0;
    }

    totalDebts = shippingDebt + accreditationDebtTotal;

    const fundTotals = await getFundTotalsByCurrency(db, userId);
    let fundUsd = 0;
    fundTotals.forEach((r) => {
      if (r.currency === 'USD') fundUsd += r.total || 0;
    });
    const mainFund = await getMainFundSummary(db, userId);

    if (defaultCycleId) {
      const cashSnapshot = (await db.query(`
        SELECT cash_balance FROM cash_box_snapshot WHERE cycle_id = $1 ORDER BY snapshot_at DESC LIMIT 1
      `, [defaultCycleId])).rows[0];
      snapshotCash = cashSnapshot?.cash_balance ?? 0;

      const deferredRows = (await db.query(`
        SELECT SUM(balance_d) as total FROM deferred_balance_users WHERE cycle_id = $1
      `, [defaultCycleId])).rows[0];
      deferredBalance = deferredRows?.total ?? 0;
    }

    cashBalance = fundUsd + snapshotCash;

    res.json({
      success: true,
      cashBalance,
      snapshotCash,
      fundTotals,
      mainFund,
      deferredBalance,
      shippingBalance,
      goldBalance,
      crystalBalance,
      cycles,
      cycleId: defaultCycleId,
      totalRevenue,
      netProfit,
      capitalRecovered,
      totalDebts,
      shippingDebt,
      accreditationDebtTotal,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الإحصائيات' });
  }
});

/** حساب رصيد الصندوق وتحديث اللقطة (يُستدعى عند الحاجة) */
router.post('/refresh-cash', requireAuth, async (req, res) => {
  try {
    const { cycleId } = req.body || {};
    const cid = parseInt(cycleId, 10);
    if (!cid) return res.json({ success: false, message: 'الدورة مطلوبة' });
    const db = getDb();
    const cycle = (await db.query('SELECT id FROM financial_cycles WHERE id = $1 AND user_id = $2', [cid, req.session.userId])).rows[0];
    if (!cycle) return res.json({ success: false, message: 'الدورة غير موجودة' });
    const result = await calculateCashBoxBalance(cid, req.session.userId);
    if (!result) return res.json({ success: false, message: 'فشل حساب رصيد الصندوق' });
    res.json({ success: true, cashBalance: result.cashBalance || 0 });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** تحديث رصيد المؤجل من جدول الوكيل */
router.post('/refresh-deferred', requireAuth, async (req, res) => {
  try {
    const { cycleId } = req.body || {};
    const cid = parseInt(cycleId, 10);
    if (!cid) return res.json({ success: false, message: 'الدورة مطلوبة' });
    const db = getDb();
    const cycle = (await db.query('SELECT id FROM financial_cycles WHERE id = $1 AND user_id = $2', [cid, req.session.userId])).rows[0];
    if (!cycle) return res.json({ success: false, message: 'الدورة غير موجودة' });
    const users = await fetchDeferredBalanceUsers(cid, req.session.userId);
    const total = users.reduce((s, u) => s + (u.balance_d || 0), 0);
    res.json({ success: true, users, deferredBalance: total });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** مصادر الأموال: الصناديع وأرصدتها */
router.get('/fund-sources', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.userId;
    const funds = (await db.query(
      `SELECT id, name, fund_number, country, region_syria, is_main, transfer_company_id
       FROM funds WHERE user_id = $1 ORDER BY is_main DESC, name`,
      [userId]
    )).rows;
    const out = [];
    for (const f of funds) {
      const bals = (await db.query(
        'SELECT currency, amount FROM fund_balances WHERE fund_id = $1',
        [f.id]
      )).rows;
      out.push({ ...f, balances: bals });
    }
    const snap = (await db.query(
      `SELECT c.id, c.name, s.cash_balance
       FROM financial_cycles c
       LEFT JOIN LATERAL (
         SELECT cash_balance FROM cash_box_snapshot WHERE cycle_id = c.id ORDER BY snapshot_at DESC LIMIT 1
       ) s ON true
       WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 5`,
      [userId]
    )).rows;
    res.json({ success: true, funds: out, recentSnapshots: snap });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', funds: [] });
  }
});

/** تفصيل الديون (شحن دين + اعتمادات سالبة) */
router.get('/debts-detail', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.userId;
    const ship = (await db.query(
      `SELECT id, total, quantity, item_type, created_at, buyer_type, status
       FROM shipping_transactions WHERE type = 'sell' AND status = 'debt' ORDER BY created_at DESC LIMIT 200`,
    )).rows;
    const acc = (await db.query(
      `SELECT id, name, code, balance_amount FROM accreditation_entities WHERE user_id = $1 AND balance_amount < 0 ORDER BY balance_amount`,
      [userId]
    )).rows;
    res.json({ success: true, shippingDebts: ship, accreditationDebts: acc });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', shippingDebts: [], accreditationDebts: [] });
  }
});

/** ترحيل أرباح إلى صندوق (دفعات متعددة عبر طلبات متتابعة) */
router.post('/transfer-profit', requireAuth, async (req, res) => {
  try {
    const { fundId, amount, currency, cycleId, notes, batches } = req.body || {};
    const db = getDb();
    const userId = req.session.userId;
    if (Array.isArray(batches) && batches.length) {
      for (const b of batches) {
        const fid = parseInt(b.fundId, 10);
        const amt = parseFloat(b.amount);
        if (!fid || isNaN(amt) || amt <= 0) continue;
        await transferProfitToFund(db, userId, fid, amt, b.currency || currency || 'USD', b.cycleId || cycleId || null, b.notes || notes);
      }
      return res.json({ success: true, message: 'تم ترحيل الدفعات' });
    }
    const fid = parseInt(fundId, 10);
    const amt = parseFloat(amount);
    if (!fid || isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'صندوق ومبلغ صالحان مطلوبان' });
    await transferProfitToFund(db, userId, fid, amt, currency || 'USD', cycleId ? parseInt(cycleId, 10) : null, notes);
    res.json({ success: true, message: 'تم ترحيل الربح' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** قائمة المستخدمين غير المدققين (رصيد مؤجل) */
router.get('/deferred-users', requireAuth, async (req, res) => {
  try {
    const { cycleId } = req.query || {};
    const cid = parseInt(cycleId, 10);
    if (!cid) return res.json({ success: false, message: 'الدورة مطلوبة', users: [] });
    const db = getDb();
    const cycle = (await db.query('SELECT id FROM financial_cycles WHERE id = $1 AND user_id = $2', [cid, req.session.userId])).rows[0];
    if (!cycle) return res.json({ success: false, message: 'الدورة غير موجودة', users: [] });
    const users = (await db.query('SELECT member_user_id, extra_id_c, balance_d FROM deferred_balance_users WHERE cycle_id = $1 ORDER BY member_user_id', [cid])).rows;
    res.json({ success: true, users });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', users: [] });
  }
});

module.exports = router;
