/**
 * مخزون الشحن: متوسط مرجح للتكلفة لكل (user_id, item_type).
 * الشراء: المبلغ المدخل = إجمالي قيمة الكمية.
 * البيع: المبلغ المدخل = إجمالي إيراد تلك الكمية.
 */

const { getDb } = require('../db/database');

async function getInventoryRow(db, userId, itemType) {
  const r = (await db.query(
    'SELECT quantity_on_hand, total_cost_basis FROM shipping_inventory WHERE user_id = $1 AND item_type = $2',
    [userId, itemType]
  )).rows[0];
  return r || { quantity_on_hand: 0, total_cost_basis: 0 };
}

function avgCost(row) {
  const q = row.quantity_on_hand || 0;
  if (q <= 0) return 0;
  return (row.total_cost_basis || 0) / q;
}

/**
 * @returns {{ newQty: number, newTotalCost: number, unitCost: number }}
 */
async function applyBuy(db, userId, itemType, quantity, lineTotalAmount) {
  const row = await getInventoryRow(db, userId, itemType);
  const q = quantity;
  const addCost = lineTotalAmount;
  const newQty = (row.quantity_on_hand || 0) + q;
  const newTotalCost = (row.total_cost_basis || 0) + addCost;
  await db.query(
    `INSERT INTO shipping_inventory (user_id, item_type, quantity_on_hand, total_cost_basis)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, item_type) DO UPDATE SET
       quantity_on_hand = excluded.quantity_on_hand,
       total_cost_basis = excluded.total_cost_basis`,
    [userId, itemType, newQty, newTotalCost]
  );
  const unitCost = newQty > 0 ? newTotalCost / newQty : 0;
  return { newQty, newTotalCost, unitCost };
}

/**
 * @returns {{ costAllocated: number, profit: number, capital: number, newQty: number }}
 */
async function applySell(db, userId, itemType, quantity, lineTotalRevenue) {
  const row = await getInventoryRow(db, userId, itemType);
  const qoh = row.quantity_on_hand || 0;
  if (quantity > qoh + 1e-9) {
    const err = new Error(`الكمية غير كافية في المخزون (${itemType}). المتاح: ${qoh}`);
    err.code = 'INSUFFICIENT_QTY';
    throw err;
  }
  const ac = avgCost(row);
  const costAllocated = quantity * ac;
  const profit = lineTotalRevenue - costAllocated;
  const capital = costAllocated;
  const newQty = qoh - quantity;
  const newTotalCost = (row.total_cost_basis || 0) - costAllocated;
  await db.query(
    `INSERT INTO shipping_inventory (user_id, item_type, quantity_on_hand, total_cost_basis)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, item_type) DO UPDATE SET
       quantity_on_hand = excluded.quantity_on_hand,
       total_cost_basis = excluded.total_cost_basis`,
    [userId, itemType, Math.max(0, newQty), Math.max(0, newTotalCost)]
  );
  return { costAllocated, profit, capital, newQty };
}

module.exports = {
  getInventoryRow,
  avgCost,
  applyBuy,
  applySell,
};
