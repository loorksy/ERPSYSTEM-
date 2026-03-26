const { getDb } = require('../db/database');

async function getMainFundId(db, userId) {
  const r = (await db.query('SELECT id FROM funds WHERE user_id = $1 AND is_main = 1 LIMIT 1', [userId])).rows[0];
  if (r) return r.id;
  const r2 = (await db.query('SELECT id FROM funds WHERE user_id = $1 ORDER BY id ASC LIMIT 1', [userId])).rows[0];
  if (r2) return r2.id;
  return await ensureDefaultMainFund(db, userId);
}

async function ensureDefaultMainFund(db, userId) {
  const existing = (await db.query('SELECT id FROM funds WHERE user_id = $1 AND is_main = 1 LIMIT 1', [userId])).rows[0];
  if (existing) return existing.id;
  const r = await db.query(
    `INSERT INTO funds (user_id, name, fund_number, is_main) VALUES ($1, 'الصندوق الرئيسي', 'MAIN-001', 1) RETURNING id`,
    [userId]
  );
  const fundId = r.rows[0].id;
  await db.query(
    `INSERT INTO fund_balances (fund_id, currency, amount) VALUES ($1, 'USD', 0) ON CONFLICT (fund_id, currency) DO NOTHING`,
    [fundId]
  );
  return fundId;
}

async function adjustFundBalance(db, fundId, currency, delta, type, notes, refTable, refId) {
  const cur = currency || 'USD';
  await db.query(
    `INSERT INTO fund_balances (fund_id, currency, amount) VALUES ($1, $2, $3)
     ON CONFLICT (fund_id, currency) DO UPDATE SET amount = fund_balances.amount + $3`,
    [fundId, cur, delta]
  );
  await db.query(
    `INSERT INTO fund_ledger (fund_id, type, amount, currency, notes, ref_table, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [fundId, type, delta, cur, notes || null, refTable || null, refId || null]
  );
}

async function creditFundBalance(db, fundId, currency, delta, type, notes, refTable, refId) {
  return adjustFundBalance(db, fundId, currency, delta, type, notes, refTable, refId);
}

async function debitFundBalance(db, fundId, currency, amount, type, notes, refTable, refId) {
  return adjustFundBalance(db, fundId, currency, -Math.abs(amount), type, notes, refTable, refId);
}

/**
 * عند بيع نقدي: إيداع إجمالي البيع في الصندوق الرئيسي (الإيراد = ربح + رأس مال).
 */
async function creditShippingCashSale(db, userId, lineTotal, notes, shippingTxId) {
  const fundId = await getMainFundId(db, userId);
  if (!fundId || lineTotal <= 0) return;
  await creditFundBalance(
    db,
    fundId,
    'USD',
    lineTotal,
    'shipping_sale_cash',
    notes || 'بيع شحن — كاش',
    'shipping_transactions',
    shippingTxId
  );
}

async function debitShippingCashBuy(db, userId, lineTotal, notes, shippingTxId) {
  const fundId = await getMainFundId(db, userId);
  if (!fundId || lineTotal <= 0) return;
  await debitFundBalance(
    db,
    fundId,
    'USD',
    lineTotal,
    'shipping_buy_cash',
    notes || 'شراء شحن — كاش',
    'shipping_transactions',
    shippingTxId
  );
}

async function getFundTotalsByCurrency(db, userId) {
  const rows = (await db.query(
    `SELECT fb.currency, SUM(fb.amount)::float AS total
     FROM fund_balances fb
     JOIN funds f ON f.id = fb.fund_id
     WHERE f.user_id = $1
     GROUP BY fb.currency`,
    [userId]
  )).rows;
  return rows;
}

async function getMainFundSummary(db, userId) {
  const main = (await db.query(
    `SELECT f.id, f.name, f.fund_number FROM funds f WHERE f.user_id = $1 AND f.is_main = 1 LIMIT 1`,
    [userId]
  )).rows[0];
  return main || null;
}

async function getMainFundUsdBalance(db, userId) {
  const mainId = await getMainFundId(db, userId);
  if (!mainId) return { mainFundId: null, usd: 0 };
  const row = (await db.query(
    'SELECT amount FROM fund_balances WHERE fund_id = $1 AND currency = $2',
    [mainId, 'USD']
  )).rows[0];
  return { mainFundId: mainId, usd: row?.amount ?? 0 };
}

/**
 * ترحيل أرباح إلى صندوق (دفعة واحدة).
 */
async function transferProfitToFund(db, userId, fundId, amount, currency, cycleId, notes) {
  const cur = currency || 'USD';
  await creditFundBalance(db, fundId, cur, amount, 'profit_transfer', notes || 'ترحيل أرباح', 'profit_transfer_batches', null);
  await db.query(
    `INSERT INTO profit_transfer_batches (user_id, fund_id, amount, currency, cycle_id, notes) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, fundId, amount, cur, cycleId || null, notes || null]
  );
}

module.exports = {
  getMainFundId,
  ensureDefaultMainFund,
  creditFundBalance,
  adjustFundBalance,
  debitFundBalance,
  creditShippingCashSale,
  debitShippingCashBuy,
  getFundTotalsByCurrency,
  getMainFundSummary,
  getMainFundUsdBalance,
  transferProfitToFund,
};
