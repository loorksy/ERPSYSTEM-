const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { calculateCashBoxBalance, fetchDeferredBalanceUsers } = require('../services/agencySyncService');
const {
  getFundTotalsByCurrency,
  getMainFundSummary,
  getMainFundUsdBalance,
  getProfitFundUsdBalance,
  transferProfitToFund,
} = require('../services/fundService');
const { computeDebtBreakdown, computeReceivablesToUs } = require('../services/debtAggregation');
const { computePaymentDue } = require('../services/paymentDueService');
const { sumLedgerBucket } = require('../services/ledgerService');
const { sumDeferredTotalAllCycles, mergeMemberDeferredIntoCycle } = require('../services/deferredSalaryService');

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
    const shippingProfit = sellAgg?.profit_sum ?? 0;
    let ledgerNetProfit = 0;
    let totalExpensesLedger = 0;
    try {
      ledgerNetProfit = await sumLedgerBucket(db, userId, 'net_profit', 'USD');
      totalExpensesLedger = await sumLedgerBucket(db, userId, 'expense', 'USD');
    } catch (_) {
      ledgerNetProfit = 0;
      totalExpensesLedger = 0;
    }
    netProfit = shippingProfit + ledgerNetProfit;
    capitalRecovered = sellAgg?.capital_sum ?? 0;
    let shippingDebt = sellAgg?.debt_sell ?? 0;

    let receivablesToUsTotal = null;
    let paymentDueTotal = null;
    try {
      const recv = await computeReceivablesToUs(db, userId);
      receivablesToUsTotal = recv.totalUsd;
    } catch (_) {
      receivablesToUsTotal = null;
    }
    try {
      const due = await computePaymentDue(db, userId);
      paymentDueTotal = due.totalUsd;
    } catch (_) {
      paymentDueTotal = null;
    }

    let debtBreakdown = {
      shippingDebt: 0,
      accreditationDebtTotal: 0,
      payablesSumUsd: 0,
      companyDebtFromBalance: 0,
      fundDebtFromBalance: 0,
      fxSpreadSumUsd: 0,
      totalDebts: 0,
    };
    try {
      debtBreakdown = await computeDebtBreakdown(db, userId);
    } catch (_) {
      try {
        const accPay = (await db.query(
          `SELECT COALESCE(SUM(balance_payable), 0)::float AS t
           FROM accreditation_entities WHERE user_id = $1 AND COALESCE(balance_payable, 0) > 0.0001`,
          [userId]
        )).rows[0];
        accreditationDebtTotal = accPay?.t ?? 0;
      } catch (__) {
        accreditationDebtTotal = 0;
      }
      debtBreakdown = {
        shippingDebt,
        accreditationDebtTotal,
        accreditationPayableUsd: accreditationDebtTotal,
        accreditationReceivableUsd: 0,
        payablesSumUsd: 0,
        companyDebtFromBalance: 0,
        fundDebtFromBalance: 0,
        fxSpreadSumUsd: 0,
        totalDebts: shippingDebt + accreditationDebtTotal,
      };
    }
    shippingDebt = debtBreakdown.shippingDebt;
    accreditationDebtTotal = debtBreakdown.accreditationDebtTotal;
    totalDebts = debtBreakdown.totalDebts;

    const fundTotals = await getFundTotalsByCurrency(db, userId);
    let fundUsd = 0;
    fundTotals.forEach((r) => {
      if (r.currency === 'USD') fundUsd += r.total || 0;
    });
    const mainFund = await getMainFundSummary(db, userId);
    const { usd: mainFundUsd } = await getMainFundUsdBalance(db, userId);
    const { usd: profitFundUsd, profitFundId } = await getProfitFundUsdBalance(db, userId);

    /** إجمالي المؤجل عبر كل الدورات (أرصدة غير مدققة متراكمة) */
    deferredBalance = await sumDeferredTotalAllCycles(db, userId);

    /**
     * بطاقة «رصيد الصندوق» = رصيد الصندوق الرئيسي المحاسبي فقط (fund_balances).
     * صندوق الربح منفصل ولا يُجمع في fundTotals ولا في هذه البطاقة.
     * الربح الصافي المعروض = شحن + دفتر صافي الربح (لا يُضاف رصيد صندوق الربح لتفادي الازدواج مع القيود).
     */
    cashBalance = mainFundUsd || 0;

    res.json({
      success: true,
      cashBalance,
      fundTotals,
      mainFund,
      profitFundUsd,
      profitFundId,
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
      receivablesToUsTotal,
      paymentDueTotal,
      shippingDebt,
      accreditationDebtTotal,
      accreditationPayableUsd: debtBreakdown.accreditationPayableUsd ?? debtBreakdown.accreditationDebtTotal,
      accreditationReceivableUsd: debtBreakdown.accreditationReceivableUsd ?? 0,
      payablesSumUsd: debtBreakdown.payablesSumUsd,
      companyDebtFromBalance: debtBreakdown.companyDebtFromBalance,
      fundDebtFromBalance: debtBreakdown.fundDebtFromBalance,
      fxSpreadSumUsd: debtBreakdown.fxSpreadSumUsd,
      mainFundUsd,
      fundUsdAll: fundUsd,
      shippingProfit,
      ledgerNetProfit,
      totalExpenses: totalExpensesLedger,
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
    const deferredBalance = await sumDeferredTotalAllCycles(db, req.session.userId);
    res.json({ success: true, users, deferredBalance });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** مصادر الأموال: الصناديق وأرصدتها */
router.get('/fund-sources', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.userId;
    const funds = (await db.query(
      `SELECT id, name, fund_number, country, region_syria, is_main, transfer_company_id,
              COALESCE(exclude_from_dashboard, 0) AS exclude_from_dashboard
       FROM funds WHERE user_id = $1 ORDER BY is_main DESC, name`,
      [userId]
    )).rows;
    const { usd: profitPoolUsd, profitFundId: profitPoolFundId } = await getProfitFundUsdBalance(db, userId);
    const out = [];
    for (const f of funds) {
      if (f.exclude_from_dashboard) continue;
      const bals = (await db.query(
        'SELECT currency, amount FROM fund_balances WHERE fund_id = $1',
        [f.id]
      )).rows;
      out.push({ ...f, balances: bals });
    }
    res.json({
      success: true,
      funds: out,
      profitPoolUsd,
      profitPoolFundId,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', funds: [] });
  }
});

/** «ديين لنا»: أرصدة موجبة لنا عبر الكيانات */
router.get('/receivables-to-us', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const data = await computeReceivablesToUs(db, req.session.userId);
    res.json({ success: true, ...data });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** «مطلوب دفع» — صفحة مستقلة */
router.get('/payment-due', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const data = await computePaymentDue(db, req.session.userId);
    res.json({ success: true, ...data });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
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

/** قائمة المؤجل: بدون cycleId = كل الدورات؛ مع cycleId = تلك الدورة فقط */
router.get('/deferred-users', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.userId;
    const cidRaw = req.query.cycleId;
    const cid = cidRaw ? parseInt(cidRaw, 10) : null;

    if (cid) {
      const cycle = (await db.query('SELECT id FROM financial_cycles WHERE id = $1 AND user_id = $2', [cid, userId])).rows[0];
      if (!cycle) return res.json({ success: false, message: 'الدورة غير موجودة', users: [] });
      const users = (await db.query(
        `SELECT l.member_user_id, l.extra_id_c, l.balance_d, l.salary_before_discount, l.cycle_id, c.name AS cycle_name
         FROM deferred_salary_lines l
         JOIN financial_cycles c ON c.id = l.cycle_id AND c.user_id = l.user_id
         WHERE l.user_id = $1 AND l.cycle_id = $2
         AND (
           EXISTS (SELECT 1 FROM payroll_user_audit_cache p WHERE p.user_id = l.user_id AND p.cycle_id = l.cycle_id)
           OR l.sheet_source = 'member_adjustment'
         )
         ORDER BY l.member_user_id`,
        [userId, cid]
      )).rows;
      return res.json({ success: true, mode: 'cycle', cycleId: cid, users });
    }

    const users = (await db.query(
      `SELECT l.member_user_id, l.extra_id_c, l.balance_d, l.salary_before_discount, l.cycle_id, c.name AS cycle_name
       FROM deferred_salary_lines l
       JOIN financial_cycles c ON c.id = l.cycle_id AND c.user_id = l.user_id
       WHERE l.user_id = $1
       AND (
         EXISTS (SELECT 1 FROM payroll_user_audit_cache p WHERE p.user_id = l.user_id AND p.cycle_id = l.cycle_id)
         OR l.sheet_source = 'member_adjustment'
       )
       ORDER BY c.created_at DESC NULLS LAST, l.member_user_id`,
      [userId]
    )).rows;
    const totalDeferred = await sumDeferredTotalAllCycles(db, userId);
    res.json({ success: true, mode: 'all', users, totalDeferred });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', users: [] });
  }
});

/** دمج كل رواتب المؤجل لرقم مستخدم في دورة مالية واحدة وتسجيل التدقيق */
router.post('/deferred-merge', requireAuth, async (req, res) => {
  try {
    const { memberUserId, targetCycleId } = req.body || {};
    const cid = parseInt(targetCycleId, 10);
    if (!memberUserId || !cid) {
      return res.json({ success: false, message: 'رقم المستخدم والدورة المستهدفة مطلوبان' });
    }
    const db = getDb();
    const r = await mergeMemberDeferredIntoCycle(db, req.session.userId, String(memberUserId), cid);
    if (!r.success) return res.json(r);
    res.json({ success: true, message: 'تم دمج الأرصدة وتسجيل التدقيق في الدورة المختارة', ...r });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
