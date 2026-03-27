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

/**
 * إدراج قيد net_profit ثم مرآة آمنة إلى صندوق الربح (بدون تكرار مع حركات الوكالات المزدوجة).
 */
async function insertNetProfitLedgerAndMirrorFund(db, p) {
  const id = await insertLedgerEntry(db, p);
  if (p.bucket !== 'net_profit' || !id) return id;
  const { mirrorNetProfitLedgerToProfitFund } = require('./fundService');
  await mirrorNetProfitLedgerToProfitFund(db, {
    userId: p.userId,
    ledgerEntryId: id,
    amountSigned: Number(p.amount) || 0,
    sourceType: p.sourceType,
    currency: p.currency || 'USD',
    notes: p.notes,
  });
  return id;
}

/** إجمالي دلو معيّن */
async function sumLedgerBucket(db, userId, bucket, currency = 'USD') {
  if (bucket === 'net_profit') {
    const row = (await db.query(
      `SELECT COALESCE(SUM(le.amount * le.direction), 0)::float AS t
       FROM ledger_entries le
       WHERE le.user_id = $1 AND le.bucket = $2 AND le.currency = $3
       AND NOT (
         le.source_type = 'cycle_creation_discount_profit'
         AND le.cycle_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM ledger_entries l2
           WHERE l2.user_id = le.user_id
           AND l2.cycle_id = le.cycle_id
           AND l2.source_type = 'transfer_discount_profit'
           AND l2.bucket = 'net_profit'
         )
       )`,
      [userId, bucket, currency]
    )).rows[0];
    return row?.t ?? 0;
  }
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
    `SELECT le.source_type, COALESCE(SUM(le.amount * le.direction), 0)::float AS total
     FROM ledger_entries le
     WHERE le.user_id = $1 AND le.bucket = 'net_profit' AND le.currency = $2
     AND NOT (
       le.source_type = 'cycle_creation_discount_profit'
       AND le.cycle_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM ledger_entries l2
         WHERE l2.user_id = le.user_id
         AND l2.cycle_id = le.cycle_id
         AND l2.source_type = 'transfer_discount_profit'
         AND l2.bucket = 'net_profit'
       )
     )
     GROUP BY le.source_type
     ORDER BY ABS(COALESCE(SUM(le.amount * le.direction), 0)) DESC`,
    [userId, currency]
  )).rows;
  const shipRow = (await db.query(
    `SELECT COALESCE(SUM(profit_amount), 0)::float AS t FROM shipping_transactions WHERE type = 'sell'`
  )).rows[0];
  const shippingTotal = Math.round((Number(shipRow?.t) || 0) * 100) / 100;
  const merged = [...rows];
  const idx = merged.findIndex((r) => r.source_type === 'shipping_sale_profit');
  if (idx >= 0) merged[idx] = { source_type: 'shipping_sale_profit', total: shippingTotal };
  else if (shippingTotal !== 0) merged.push({ source_type: 'shipping_sale_profit', total: shippingTotal });
  merged.sort((a, b) => Math.abs(Number(b.total) || 0) - Math.abs(Number(a.total) || 0));
  return merged;
}

module.exports = {
  insertLedgerEntry,
  insertNetProfitLedgerAndMirrorFund,
  sumLedgerBucket,
  sumExpenseEntries,
  aggregateNetProfitBySource,
};
