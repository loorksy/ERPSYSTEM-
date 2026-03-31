/**
 * تجميع إجمالي الديون لعرض اللوحة وصفحة الديون (نفس المنطق في كلا المكانين).
 */
async function computeDebtBreakdown(db, userId) {
  const sellAgg = (await db.query(`
    SELECT COALESCE(SUM(CASE WHEN status = 'debt' THEN total ELSE 0 END), 0)::float AS debt_sell
    FROM shipping_transactions WHERE type = 'sell'
  `)).rows[0];
  const shippingDebt = sellAgg?.debt_sell ?? 0;

  /** مطلوب دفع للمعتمد (علينا تجاه المعتمد) — يُحسب من balance_payable فقط */
  const accPayable = (await db.query(
    `SELECT COALESCE(SUM(balance_payable), 0)::float AS t
     FROM accreditation_entities WHERE user_id = $1 AND COALESCE(balance_payable, 0) > 0.0001`,
    [userId]
  )).rows[0];
  const accreditationPayableUsd = accPayable?.t ?? 0;

  /** دين لنا على المعتمد (رصيد سالب net = لصالحنا) — لا يُضاف إلى إجمالي التزاماتنا */
  const accRecv = (await db.query(
    `SELECT COALESCE(SUM(-balance_amount), 0)::float AS t
     FROM accreditation_entities WHERE user_id = $1 AND balance_amount < -0.0001`,
    [userId]
  )).rows[0];
  const accreditationReceivableUsd = accRecv?.t ?? 0;

  let payablesSumUsd = 0;
  /** مجموع صفوف entity_payables المنسوبة لتحويل معتمد بوضع payable (نص الملاحظة يبدأ بـ «تحويل معتمد» كما في accreditations.js) */
  let entityPayablesFromAccTransferUsd = 0;
  try {
    const payRows = (await db.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS t FROM entity_payables WHERE user_id = $1 AND currency = 'USD'`,
      [userId]
    )).rows[0];
    payablesSumUsd = payRows?.t ?? 0;
    const epAcc = (await db.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS t FROM entity_payables
       WHERE user_id = $1 AND currency = 'USD'
       AND COALESCE(TRIM(notes), '') ILIKE 'تحويل معتمد%'`,
      [userId]
    )).rows[0];
    entityPayablesFromAccTransferUsd = epAcc?.t ?? 0;
  } catch (_) {
    payablesSumUsd = 0;
    entityPayablesFromAccTransferUsd = 0;
  }
  const entityPayablesOtherUsd = Math.max(0, payablesSumUsd - entityPayablesFromAccTransferUsd);

  let fxSpreadSumUsd = 0;
  try {
    const fxRow = (await db.query(
      `SELECT COALESCE(SUM(spread_usd), 0)::float AS t FROM fx_spread_entries WHERE user_id = $1`,
      [userId]
    )).rows[0];
    fxSpreadSumUsd = fxRow?.t ?? 0;
  } catch (_) {
    fxSpreadSumUsd = 0;
  }

  const negCompanies = (await db.query(
    `SELECT id, name, balance_amount, balance_currency
     FROM transfer_companies
     WHERE user_id = $1 AND balance_amount < 0`,
    [userId]
  )).rows;

  const negFunds = (await db.query(
    `SELECT f.id, f.name, fb.amount, fb.currency
     FROM funds f
     JOIN fund_balances fb ON fb.fund_id = f.id
     WHERE f.user_id = $1 AND fb.amount < 0 AND fb.currency = 'USD'`,
    [userId]
  )).rows;

  let companyDebtFromBalance = 0;
  negCompanies.forEach((c) => {
    if ((c.balance_currency || 'USD') === 'USD') companyDebtFromBalance += Math.abs(c.balance_amount || 0);
  });

  let fundDebtFromBalance = 0;
  negFunds.forEach((f) => {
    fundDebtFromBalance += Math.abs(f.amount || 0);
  });

  const totalDebts =
    shippingDebt +
    accreditationPayableUsd +
    payablesSumUsd +
    companyDebtFromBalance +
    fundDebtFromBalance;

  return {
    shippingDebt,
    /** @deprecated استخدم accreditationPayableUsd أو accreditationReceivableUsd حسب السياق */
    accreditationDebtTotal: accreditationPayableUsd,
    accreditationPayableUsd,
    accreditationReceivableUsd,
    payablesSumUsd,
    entityPayablesFromAccTransferUsd,
    entityPayablesOtherUsd,
    companyDebtFromBalance,
    fundDebtFromBalance,
    fxSpreadSumUsd,
    totalDebts,
  };
}

/**
 * تجميع «ديين لنا»: وكالات فرعية (رصيد سالب)، معتمدين (رصيد سالب = لنا عليهم)، مستخدمون، مرتجعات صناديق (يبقى بالصندوق) صافية.
 * أرصدة المعتمد الموجبة تُعرض في «مطلوب دفع» وليست ديناً لنا.
 */
async function computeReceivablesToUs(db, userId) {
  const subAgencyRows = (await db.query(`
    SELECT s.id, s.name,
      COALESCE(SUM(CASE WHEN t.type IN ('profit', 'reward') THEN t.amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN t.type IN ('deduction', 'due') THEN t.amount ELSE 0 END), 0) AS balance
    FROM shipping_sub_agencies s
    LEFT JOIN sub_agency_transactions t ON t.sub_agency_id = s.id
    GROUP BY s.id, s.name
    HAVING (
      COALESCE(SUM(CASE WHEN t.type IN ('profit', 'reward') THEN t.amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN t.type IN ('deduction', 'due') THEN t.amount ELSE 0 END), 0)
    ) < -0.0001
    ORDER BY s.name
  `)).rows;

  let totalUsd = 0;
  subAgencyRows.forEach((r) => {
    totalUsd += Math.abs(r.balance || 0);
  });

  const accreditations = (await db.query(
    `SELECT id, name, balance_amount FROM accreditation_entities WHERE user_id = $1 AND balance_amount < -0.0001 ORDER BY name`,
    [userId]
  )).rows;
  accreditations.forEach((r) => {
    totalUsd += Math.abs(Number(r.balance_amount) || 0);
  });

  const members = (await db.query(
    `SELECT member_user_id, debt_to_company_usd FROM member_profiles
     WHERE user_id = $1 AND COALESCE(debt_to_company_usd, 0) > 0.0001
     ORDER BY member_user_id`,
    [userId]
  )).rows;
  members.forEach((r) => {
    totalUsd += Number(r.debt_to_company_usd) || 0;
  });

  /**
   * مرتجعات «يبقى بالصندوق» للصناديق فقط: الصافي بعد تسوية «دين علينا» (net_amount)، لا يُكرَّر مع أرصدة شركات التحويل.
   * ترحيل لصندوق آخر (transfer_to_fund) لا يُدخل هنا — النقد يظهر في الصندوق المستلم.
   */
  const retRow = (await db.query(
    `SELECT COALESCE(SUM(COALESCE(net_amount, amount)), 0)::float AS t
     FROM financial_returns
     WHERE user_id = $1
       AND disposition = 'remain_at_entity'
       AND entity_type = 'fund'
       AND cancelled_at IS NULL
       AND COALESCE(NULLIF(TRIM(currency), ''), 'USD') = 'USD'`,
    [userId]
  )).rows[0];
  const returnsPendingUsd = retRow?.t ?? 0;
  totalUsd += returnsPendingUsd;

  /** رصيد موجب = أصل لنا لدى شركة التحويل (عكس الرصيد السالب في صفحة دين علينا) */
  const posCompanyRows = (await db.query(
    `SELECT id, name, balance_amount, balance_currency
     FROM transfer_companies
     WHERE user_id = $1 AND balance_amount > 0.0001
     ORDER BY name`,
    [userId]
  )).rows;
  const transferCompanies = [];
  posCompanyRows.forEach((c) => {
    if ((c.balance_currency || 'USD') === 'USD') {
      const amt = Number(c.balance_amount) || 0;
      totalUsd += amt;
      transferCompanies.push({
        id: c.id,
        name: c.name,
        amountOwedToUs: amt,
        balanceCurrency: c.balance_currency || 'USD',
      });
    }
  });

  return {
    totalUsd,
    transferCompanies,
    subAgencies: subAgencyRows.map((r) => ({
      id: r.id,
      name: r.name,
      balanceRaw: r.balance,
      amountOwedToUs: Math.abs(r.balance || 0),
    })),
    accreditations: accreditations.map((r) => ({
      id: r.id,
      name: r.name,
      amountOwedToUs: Math.abs(Number(r.balance_amount) || 0),
    })),
    members: members.map((r) => ({
      memberUserId: r.member_user_id,
      amountOwedToUs: Number(r.debt_to_company_usd) || 0,
    })),
    returnsPendingUsd,
  };
}

/**
 * توسعة مستقبلية محتملة: تسجيل صريح لتحويلات نقدية للوكالة مقابل نصيب الربح
 * (أنواع حركات جديدة أو جدول مرتبط بالصندوق) — راجع منطق sub_agency_transactions و fund_ledger.
 */

module.exports = { computeDebtBreakdown, computeReceivablesToUs };
