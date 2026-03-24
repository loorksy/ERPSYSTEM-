/**
 * تجميع إجمالي الديون لعرض اللوحة وصفحة الديون (نفس المنطق في كلا المكانين).
 */
async function computeDebtBreakdown(db, userId) {
  const sellAgg = (await db.query(`
    SELECT COALESCE(SUM(CASE WHEN status = 'debt' THEN total ELSE 0 END), 0)::float AS debt_sell
    FROM shipping_transactions WHERE type = 'sell'
  `)).rows[0];
  const shippingDebt = sellAgg?.debt_sell ?? 0;

  const accDebt = (await db.query(`
    SELECT COALESCE(SUM(-balance_amount), 0)::float AS t
    FROM accreditation_entities WHERE user_id = $1 AND balance_amount < 0
  `, [userId])).rows[0];
  const accreditationDebtTotal = accDebt?.t ?? 0;

  let payablesSumUsd = 0;
  try {
    const payRows = (await db.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS t FROM entity_payables WHERE user_id = $1 AND currency = 'USD'`,
      [userId]
    )).rows[0];
    payablesSumUsd = payRows?.t ?? 0;
  } catch (_) {
    payablesSumUsd = 0;
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
    accreditationDebtTotal +
    payablesSumUsd +
    companyDebtFromBalance +
    fundDebtFromBalance;

  return {
    shippingDebt,
    accreditationDebtTotal,
    payablesSumUsd,
    companyDebtFromBalance,
    fundDebtFromBalance,
    totalDebts,
  };
}

module.exports = { computeDebtBreakdown };
