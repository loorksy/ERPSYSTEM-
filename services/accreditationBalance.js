/**
 * أرصدة المعتمد: علينا (payable) ولنا (receivable).
 * balance_amount = balance_payable - balance_receivable (صافٍ للتوافق مع الكود القديم).
 */

function netToBuckets(net) {
  const n = Number(net) || 0;
  if (n >= 0) return { pay: n, rec: 0 };
  return { pay: 0, rec: -n };
}

function bucketsToNet(pay, rec) {
  return (Number(pay) || 0) - (Number(rec) || 0);
}

/** راتب علينا: يقلّل ما ندين به ثم يزيد ما للمعتمد علينا */
function applySalaryToThem(pay, rec, amt) {
  let p = Number(pay) || 0;
  let r = Number(rec) || 0;
  let rem = Number(amt) || 0;
  const takePay = Math.min(p, rem);
  p -= takePay;
  rem -= takePay;
  if (rem > 0) r += rem;
  return { pay: p, rec: r };
}

/** تحويل/تسليم نقدي من حساب المعتمد: يقلّل الصافي */
function applyTransferOut(pay, rec, amt) {
  const net = bucketsToNet(pay, rec) - (Number(amt) || 0);
  return netToBuckets(net);
}

async function syncNetBalance(db, entityId) {
  await db.query(
    `UPDATE accreditation_entities SET balance_amount = COALESCE(balance_payable,0) - COALESCE(balance_receivable,0) WHERE id = $1`,
    [entityId]
  );
}

async function readBuckets(db, entityId) {
  const row = (await db.query(
    'SELECT balance_payable, balance_receivable FROM accreditation_entities WHERE id = $1',
    [entityId]
  )).rows[0];
  if (!row) return { pay: 0, rec: 0 };
  return { pay: Number(row.balance_payable) || 0, rec: Number(row.balance_receivable) || 0 };
}

module.exports = {
  netToBuckets,
  bucketsToNet,
  applySalaryToThem,
  applyTransferOut,
  syncNetBalance,
  readBuckets,
};
