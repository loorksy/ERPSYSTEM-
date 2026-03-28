/**
 * «مطلوب دفع»: التزامات نقدية تجاه المعتمد (رصيد موجب) + وكالة فرعية برصيد لصالحها (موجب).
 * يُحسب مشتقاً من الأرصدة الحالية دون جدول منفصل.
 */
async function computePaymentDue(db, userId) {
  const accRows = (await db.query(
    `SELECT id, name, code, balance_amount, balance_payable FROM accreditation_entities
     WHERE user_id = $1 AND COALESCE(balance_payable, 0) > 0.0001 ORDER BY name`,
    [userId]
  )).rows;

  const subRows = (await db.query(`
    SELECT s.id, s.name,
      COALESCE(SUM(CASE WHEN t.type IN ('profit', 'reward') THEN t.amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN t.type IN ('deduction', 'due') THEN t.amount ELSE 0 END), 0) AS balance
    FROM shipping_sub_agencies s
    LEFT JOIN sub_agency_transactions t ON t.sub_agency_id = s.id
    GROUP BY s.id, s.name
    HAVING (
      COALESCE(SUM(CASE WHEN t.type IN ('profit', 'reward') THEN t.amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN t.type IN ('deduction', 'due') THEN t.amount ELSE 0 END), 0)
    ) > 0.0001
    ORDER BY s.name
  `)).rows;

  let totalUsd = 0;
  accRows.forEach((r) => {
    totalUsd += Number(r.balance_payable != null ? r.balance_payable : r.balance_amount) || 0;
  });
  subRows.forEach((r) => {
    totalUsd += Number(r.balance) || 0;
  });

  return {
    totalUsd,
    accreditations: accRows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      amountDueUsd: Number(r.balance_payable != null ? r.balance_payable : r.balance_amount) || 0,
    })),
    subAgencies: subRows.map((r) => ({
      id: r.id,
      name: r.name,
      balanceRaw: r.balance,
      amountDueUsd: Number(r.balance) || 0,
    })),
  };
}

module.exports = { computePaymentDue };
