function normalizePayableCurrency(currency) {
  if (currency == null || String(currency).trim() === '') return null;
  return String(currency).trim();
}

/**
 * تسوية ديون مسجّلة في entity_payables (FIFO حسب created_at).
 * @param {string} [currency] إن وُجدت، تُسوّى فقط التزامات بنفس العملة (مطابقة COALESCE مع USD).
 * @returns {{ settled: number }} المبلغ المُسدَّد فعلياً من maxAmount
 */
async function settleOpenPayablesFifo(db, userId, entityType, entityId, maxAmount, currency) {
  const cap = Math.max(0, parseFloat(maxAmount) || 0);
  if (cap <= 0) return { settled: 0 };
  const cur = normalizePayableCurrency(currency);
  let sql = `SELECT id, amount FROM entity_payables
     WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3 AND amount > 0.0001`;
  const params = [userId, entityType, entityId];
  if (cur != null) {
    sql += ` AND COALESCE(NULLIF(TRIM(currency), ''), 'USD') = $4`;
    params.push(cur);
  }
  sql += ` ORDER BY created_at ASC`;
  const rows = (await db.query(sql, params)).rows;
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

async function sumOpenPayables(db, userId, entityType, entityId, currency) {
  const cur = normalizePayableCurrency(currency);
  let sql = `SELECT COALESCE(SUM(amount), 0)::float AS t FROM entity_payables
     WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3 AND amount > 0.0001`;
  const params = [userId, entityType, entityId];
  if (cur != null) {
    sql += ` AND COALESCE(NULLIF(TRIM(currency), ''), 'USD') = $4`;
    params.push(cur);
  }
  const row = (await db.query(sql, params)).rows[0];
  return row && row.t != null ? row.t : 0;
}

module.exports = { settleOpenPayablesFifo, sumOpenPayables };
