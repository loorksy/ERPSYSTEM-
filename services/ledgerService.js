const { getDb } = require('../db/database');

/**
 * @param {object} db
 * @param {object} p
 * @param {number} p.userId
 * @param {'net_profit'|'main_cash'|'expense'|'payable'} p.bucket
 * @param {string} p.sourceType
 * @param {number} p.amount signed effect on bucket (positive increases profit/cash/expense balance)
 * @param {string} [p.currency]
 * @param {number|null} [p.cycleId]
 * @param {string|null} [p.refTable]
 * @param {number|null} [p.refId]
 * @param {string|null} [p.notes]
 * @param {object|null} [p.meta]
 */
async function insertLedgerEntry(db, p) {
  const cur = p.currency || 'USD';
  const amountAbs = Math.abs(Number(p.amount) || 0);
  const direction = (Number(p.amount) || 0) >= 0 ? 1 : -1;
  const r = await db.query(
    `INSERT INTO ledger_entries (user_id, bucket, source_type, amount, currency, direction, cycle_id, ref_table, ref_id, notes, meta_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      p.userId,
      p.bucket,
      p.sourceType,
      amountAbs,
      cur,
      direction,
      p.cycleId || null,
      p.refTable || null,
      p.refId || null,
      p.notes || null,
      p.meta != null ? JSON.stringify(p.meta) : null,
    ]
  );
  return r.rows[0]?.id;
}

/** إجمالي دلو معيّن */
async function sumLedgerBucket(db, userId, bucket, currency = 'USD') {
  const row = (await db.query(
    `SELECT COALESCE(SUM(amount * direction), 0)::float AS t
     FROM ledger_entries WHERE user_id = $1 AND bucket = $2 AND currency = $3`,
    [userId, bucket, currency]
  )).rows[0];
  return row?.t ?? 0;
}

async function sumExpenseEntries(db, userId, currency = 'USD') {
  const row = (await db.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS t FROM expense_entries WHERE user_id = $1`,
    [userId]
  )).rows[0];
  return row?.t ?? 0;
}

/** تجميع صافي الربح حسب نوع المصدر (دفتر bucket = net_profit) */
async function aggregateNetProfitBySource(db, userId, currency = 'USD') {
  const rows = (await db.query(
    `SELECT source_type, COALESCE(SUM(amount * direction), 0)::float AS total
     FROM ledger_entries
     WHERE user_id = $1 AND bucket = 'net_profit' AND currency = $2
     GROUP BY source_type
     ORDER BY ABS(COALESCE(SUM(amount * direction), 0)) DESC`,
    [userId, currency]
  )).rows;
  return rows;
}

module.exports = {
  insertLedgerEntry,
  sumLedgerBucket,
  sumExpenseEntries,
  aggregateNetProfitBySource,
};
