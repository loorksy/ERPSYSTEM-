/**
 * تقسيم «دين علينا» عند وجود نسبة خصم: الصافي للصندوق ومطلوب الدفع، والخصم كربح.
 */
function roundMoney(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/**
 * @param {number} grossAmount — المبلغ الإجمالي المُدخل
 * @param {string|number|null|undefined} discountPctRaw — نسبة 0–100 أو فارغ
 * @returns {{ netAmt: number, discountAmt: number, metaJson: string|null }}
 */
function splitDebtPayableWithDiscount(grossAmount, discountPctRaw) {
  const g = Number(grossAmount);
  if (isNaN(g) || g <= 0) return { netAmt: 0, discountAmt: 0, metaJson: null };
  const pct =
    discountPctRaw != null && discountPctRaw !== '' ? parseFloat(discountPctRaw) : null;
  if (isNaN(pct) || pct <= 0 || pct > 100) {
    return { netAmt: roundMoney(g), discountAmt: 0, metaJson: null };
  }
  const discountAmt = roundMoney(g * (pct / 100));
  const netAmt = roundMoney(g - discountAmt);
  const metaJson = JSON.stringify({
    discountPct: pct,
    grossAmount: g,
    discountAmount: discountAmt,
    netAmount: netAmt,
  });
  return { netAmt, discountAmt, metaJson };
}

/**
 * خصم من «دين لنا» عند إضافة ائتمان (علينا/راتب لنا).
 * @param {object} body - req.body (receivableOffsetMode, receivableOffsetUsd)
 * @param {number} recBefore
 * @param {number} grossCredit - المبلغ الإجمالي للائتمان
 * @param {{ salaryRemainderAfterBrokerage?: number }} [opts] — للراتب: لا يتجاوز الخصم الباقي بعد الوساطة (إيداع الصندوق)
 */
function parseReceivableOffsetFromBody(body, recBefore, grossCredit, opts = {}) {
  const rec0 = roundMoney(recBefore);
  const gross = roundMoney(grossCredit);
  const rawMode = body && body.receivableOffsetMode;
  const mode =
    rawMode == null || rawMode === ''
      ? ''
      : String(rawMode).trim().toLowerCase();
  const rawCustom = body && body.receivableOffsetUsd;

  if (rec0 <= 0.0001) return { s: 0, mode: 'defer' };
  /* فراغ أو تأجيل أو أي قيمة غير full/custom = بدون خصم من دين لنا */
  if (!mode || mode === 'defer') return { s: 0, mode: 'defer' };

  let maxCap = roundMoney(Math.min(rec0, gross));
  if (opts.salaryRemainderAfterBrokerage != null) {
    const rem = roundMoney(opts.salaryRemainderAfterBrokerage);
    maxCap = roundMoney(Math.min(maxCap, rem));
  }

  let s = 0;
  if (mode === 'full') {
    s = maxCap;
  } else if (mode === 'custom') {
    const c = roundMoney(parseFloat(rawCustom));
    if (isNaN(c) || c <= 0) {
      const err = new Error('أدخل مبلغ الخصم من الدين أو اختر تأجيل');
      err.code = 'INVALID_OFFSET';
      throw err;
    }
    if (c > maxCap + 0.001) {
      const err = new Error(`الخصم لا يتجاوز ${maxCap.toFixed(2)}`);
      err.code = 'INVALID_OFFSET';
      throw err;
    }
    s = c;
  } else {
    return { s: 0, mode: 'defer' };
  }

  return { s: roundMoney(s), mode };
}

/** عند وجود «دين لنا»: لا يُقبل وضع دون إقرار صريح — يمنع إرسال defer افتراضياً من عميل نصي. */
function isReceivableOffsetChoiceMissing(body) {
  const m = body && body.receivableOffsetMode;
  if (m == null || String(m).trim() === '') return true;
  const mode = String(m).trim().toLowerCase();
  if (!['defer', 'full', 'custom'].includes(mode)) return true;
  if (body.receivableOffsetAcknowledged !== true) return true;
  return false;
}

/**
 * ملاحظة قيد «علينا/لهم» توضّح تأجيل الخصم مقابل خصم كامل/مخصص.
 * @param {boolean} hadReceivableBefore — كان هناك دين لنا قبل العملية
 */
function debtPayableLedgerNote({
  kindLabel,
  notes,
  discountAmt,
  discountPct,
  offsetUsd,
  offsetMode,
  hadReceivableBefore,
}) {
  const n = notes && String(notes).trim();
  if (n) return n;
  if (discountAmt > 0) {
    return discountPct != null && !isNaN(Number(discountPct))
      ? `${kindLabel} — صافي بعد خصم ${discountPct}%`
      : `${kindLabel} — صافي بعد خصم`;
  }
  if (offsetUsd <= 0.0001) {
    if (hadReceivableBefore && offsetMode === 'defer') {
      return `${kindLabel} — تأجيل خصم من دين لنا (المبلغ الكامل لمصلحتهم؛ دين لنا على المعتمد دون تغيير)`;
    }
    return kindLabel === 'لهم'
      ? 'لهم — مطلوب دفع (بدون صندوق رئيسي)'
      : 'دين علينا — مطلوب دفع';
  }
  if (offsetMode === 'full') {
    return `${kindLabel} — خصم كامل من دين لنا (${offsetUsd.toFixed(2)})؛ الباقي دين علينا (رصيد له)`;
  }
  if (offsetMode === 'custom') {
    return `${kindLabel} — خصم مخصص ${offsetUsd.toFixed(2)} من دين لنا؛ الباقي دين علينا (رصيد له)`;
  }
  return `${kindLabel} — بعد خصم ${offsetUsd.toFixed(2)} من دين لنا`;
}

module.exports = {
  roundMoney,
  splitDebtPayableWithDiscount,
  parseReceivableOffsetFromBody,
  isReceivableOffsetChoiceMissing,
  debtPayableLedgerNote,
};
