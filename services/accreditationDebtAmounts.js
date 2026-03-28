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

module.exports = {
  roundMoney,
  splitDebtPayableWithDiscount,
};
