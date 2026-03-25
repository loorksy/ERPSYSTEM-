/**
 * تسوية ديون مسجّلة في entity_payables (FIFO حسب created_at).
 * @returns {{ settled: number }} المبلغ المُسدَّد فعلياً من maxAmount
 */
async function settleOpenPayablesFifo(db, userId, entityType, entityId, maxAmount) {
  const cap = Math.max(0, parseFloat(maxAmount) || 0);
  if (cap <= 0) return { settled: 0 };
  const rows = (await db.query(
    `SELECT id, amount FROM entity_payables
     WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3 AND amount > 0.0001
     ORDER BY created_at ASC`,
    [userId, entityType, entityId]
  )).rows;
  let left = cap;
  let settled = 0;
  for (const row of rows) {
    if (left <= 0) break;
    const rowAmt = parseFloat(row.amount) || 0;
    const take = Math.min(rowAmt, left);
    settled += take;
    left -= take;
    const newAmt = rowAmt - take;
    if (newAmt < 0.0001) {
      await db.query('DELETE FROM entity_payables WHERE id = $1', [row.id]);
    } else {
      await db.query('UPDATE entity_payables SET amount = $1 WHERE id = $2', [newAmt, row.id]);
    }
  }
  return { settled };
}

async function sumOpenPayables(db, userId, entityType, entityId) {
  const row = (await db.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS t FROM entity_payables
     WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3 AND amount > 0.0001`,
    [userId, entityType, entityId]
  )).rows[0];
  return row && row.t != null ? row.t : 0;
}

module.exports = { settleOpenPayablesFifo, sumOpenPayables };
