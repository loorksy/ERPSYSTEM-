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

/**
 * عكس صف سجل واحد لاستعادة («علينا»، «لنا») قبل التطبيق — يُستخدم لحساب رصيد الصافي بعد كل حركة بشكل عكسي من الوضع الحالي.
 */
function undoAccreditationLedgerRow(row, pay, rec) {
  const amt = Number(row.amount) || 0;
  const type = String(row.entry_type || '');
  if (type === 'debt_to_us') {
    return { pay, rec: rec - amt };
  }
  if (type === 'debt_to_them' || type === 'debt_to_them_no_fund') {
    return { pay: pay - amt, rec };
  }
  if (type === 'payable_discount_profit') {
    return { pay, rec };
  }
  if (type === 'salary') {
    if (row.direction === 'to_us') {
      return { pay: pay - amt, rec };
    }
    return undoSalaryToThem(pay, rec, amt);
  }
  if (type === 'transfer') {
    const net = bucketsToNet(pay, rec) + amt;
    return netToBuckets(net);
  }
  if (type === 'delivery') {
    return { pay: amt, rec };
  }
  if (type === 'deferred_reserve_sync') {
    try {
      const m = row.meta_json ? JSON.parse(row.meta_json) : {};
      if (m.balancePayableBefore != null) {
        return { pay: Number(m.balancePayableBefore) || 0, rec };
      }
    } catch (e) {}
    return { pay, rec };
  }
  return { pay, rec };
}

function undoSalaryToThem(p1, r1, amt) {
  const a = Number(amt) || 0;
  const ep = 0.01;
  const p0a = p1 + a;
  const r0a = r1;
  let fwd = applySalaryToThem(p0a, r0a, a);
  if (Math.abs(fwd.pay - p1) < ep && Math.abs(fwd.rec - r1) < ep) {
    return { pay: p0a, rec: r0a };
  }
  let best = { pay: p0a, rec: r0a, err: Infinity };
  for (let p0 = 0; p0 <= a + 1e-6; p0 += 0.01) {
    const r0 = r1 - (a - p0);
    if (r0 < -ep) continue;
    fwd = applySalaryToThem(p0, r0, a);
    const err = Math.abs(fwd.pay - p1) + Math.abs(fwd.rec - r1);
    if (err < best.err) {
      best = { pay: p0, rec: r0, err };
    }
    if (err < ep) {
      return { pay: p0, rec: r0 };
    }
  }
  if (best.err > 0.5) {
    console.warn('[accreditationBalance] undoSalaryToThem: approximate match', best.err);
  }
  return { pay: best.pay, rec: best.rec };
}

/**
 * يُرجع صفوف السجل مع balance_after (رصيد الصافي بعد الحركة) بترتيب created_at تنازلياً كما في API.
 * يعتمد على عكس القيود من الأرصدة الحالية؛ قيود راتب «لنا» مع خصم لاحق من «لنا» دون قيد ثانٍ قد تُحسب بشكل تقريبي.
 */
function computeLedgerWithBalanceAfter(entity, ledgerRows) {
  const sorted = [...ledgerRows].sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    if (ta !== tb) return tb - ta;
    return (b.id || 0) - (a.id || 0);
  });
  let pay = Number(entity.balance_payable) || 0;
  let rec = Number(entity.balance_receivable) || 0;
  return sorted.map((row) => {
    const balance_after = bucketsToNet(pay, rec);
    const prev = undoAccreditationLedgerRow(row, pay, rec);
    pay = prev.pay;
    rec = prev.rec;
    return { ...row, balance_after };
  });
}

module.exports = {
  netToBuckets,
  bucketsToNet,
  applySalaryToThem,
  applyTransferOut,
  syncNetBalance,
  readBuckets,
  computeLedgerWithBalanceAfter,
};
