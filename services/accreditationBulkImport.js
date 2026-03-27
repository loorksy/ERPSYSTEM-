const { adjustFundBalance, getMainFundId } = require('./fundService');
const { insertLedgerEntry, insertNetProfitLedgerAndMirrorFund } = require('./ledgerService');

/**
 * استيراد أرصدة معتمدين من ملف: أعمدة A كود، B اسم، C رصيد، D معتمد رئيسي.
 * بدون وساطة: المبلغ كاملاً يزيد رصيد المعتمد ويُسجَّل في الصندوق الرئيسي (main_cash) مثل السابق.
 * مع brokeragePct (0–100): نسبة الوساطة → صافي الربح، والباقي → الصندوق الرئيسي (نفس منطق إضافة مبلغ يدويًا).
 */
function parseCsvTextToRows(text) {
  if (!text || !String(text).trim()) return [];
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => line.split(/[,\t]/).map((c) => c.trim()));
}

/**
 * معاينة صفوف الاستيراد (بدون تعديل قاعدة البيانات).
 * @param {any[][]} rows — صف رؤوس + بيانات
 */
function buildBulkPreview(rows) {
  if (!rows || rows.length < 2) return [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const code = row[0] != null ? String(row[0]).trim() : '';
    const name = row[1] != null ? String(row[1]).trim() : '';
    const raw = row[2];
    const bal = parseFloat(String(raw != null ? raw : '').replace(/,/g, ''));
    const parentRef = row[3] != null ? String(row[3]).trim() : '';
    let error = null;
    if (!code) error = 'كود مطلوب';
    else if (isNaN(bal) || bal <= 0) error = 'مبلغ غير صالح';
    out.push({
      lineIndex: i + 1,
      code,
      name,
      amount: bal,
      parentRef,
      valid: !error,
      error,
    });
  }
  return out;
}

/**
 * @param {object[]} items — { code, name?, amount, parentRef?, brokeragePct?, salaryDirection?, amountKind? }
 * @param {string} [amountKind] — 'salary' | 'debt_to_us' لكل صف أو افتراضي
 */
async function processAccreditationBulkRowsFromItems(db, userId, items, cycleId, defaultBrokeragePct) {
  if (!items || !items.length) {
    return { success: false, message: 'لا توجد صفوف', imported: 0, errors: [] };
  }
  const needsMainFund = items.some((it) => (it.amountKind === 'debt_to_us' ? false : true));
  let mainFundId = null;
  if (needsMainFund) {
    mainFundId = await getMainFundId(db, userId);
    if (!mainFundId) {
      return { success: false, message: 'عيّن صندوقاً رئيسياً أولاً', imported: 0, errors: [] };
    }
  }
  let defPct = parseFloat(defaultBrokeragePct);
  if (isNaN(defPct) || defPct < 0) defPct = 0;
  defPct = Math.min(100, defPct);

  let ok = 0;
  const errs = [];
  const cid = cycleId ? parseInt(cycleId, 10) : null;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const code = it.code != null ? String(it.code).trim() : '';
    const name = it.name != null ? String(it.name).trim() : '';
    const bal = parseFloat(String(it.amount != null ? it.amount : '').replace(/,/g, ''));
    const parentRef = it.parentRef != null ? String(it.parentRef).trim() : '';
    let pct = it.brokeragePct != null && it.brokeragePct !== '' ? parseFloat(it.brokeragePct) : defPct;
    if (isNaN(pct) || pct < 0) pct = 0;
    pct = Math.min(100, pct);
    const salaryDirection = it.salaryDirection === 'to_them' ? 'to_them' : 'to_us';
    const amountKind = it.amountKind === 'debt_to_us' ? 'debt_to_us' : 'salary';

    if (!code || isNaN(bal) || bal <= 0) {
      errs.push(`صف ${i + 1}: بيانات غير صالحة`);
      continue;
    }

    let ent = (await db.query(
      'SELECT id, balance_amount FROM accreditation_entities WHERE user_id = $1 AND (code = $2 OR name = $2) LIMIT 1',
      [userId, code]
    )).rows[0];
    if (!ent && name) {
      const ins = await db.query(
        `INSERT INTO accreditation_entities (user_id, name, code) VALUES ($1, $2, $3) RETURNING id, balance_amount`,
        [userId, name, code]
      );
      ent = { id: ins.rows[0].id, balance_amount: ins.rows[0].balance_amount || 0 };
    }
    if (!ent) {
      errs.push(`صف ${i + 1}: لم يُوجد معتمد`);
      continue;
    }

    if (amountKind === 'debt_to_us') {
      await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes)
         VALUES ($1, 'debt_to_us', $2, 'USD', 'to_us', $3, $4)`,
        [ent.id, bal, cid, (it.notes && String(it.notes).trim()) || 'استيراد — دين لنا']
      );
      const newBal = (ent.balance_amount || 0) - bal;
      await db.query('UPDATE accreditation_entities SET balance_amount = $1 WHERE id = $2', [newBal, ent.id]);
      ok++;
      continue;
    }

    const signed = salaryDirection === 'to_us' ? bal : -bal;
    const brokerageAmount = pct > 0 ? bal * (pct / 100) : 0;
    const remainder = bal - brokerageAmount;
    const led = await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, brokerage_pct, brokerage_amount, cycle_id, notes)
       VALUES ($1, 'salary', $2, 'USD', $3, $4, $5, $6, $7) RETURNING id`,
      [
        ent.id,
        bal,
        salaryDirection,
        pct > 0 ? pct : null,
        pct > 0 ? brokerageAmount : null,
        cid,
        'استيراد دفعة — ' + (parentRef || ''),
      ]
    );
    const ledgerId = led.lastInsertRowid != null ? led.lastInsertRowid : led.rows[0]?.id;
    const newBal = (ent.balance_amount || 0) + signed;
    await db.query('UPDATE accreditation_entities SET balance_amount = $1 WHERE id = $2', [newBal, ent.id]);

    if (brokerageAmount > 0) {
      await insertNetProfitLedgerAndMirrorFund(db, {
        userId,
        bucket: 'net_profit',
        sourceType: 'accreditation_brokerage',
        amount: brokerageAmount,
        cycleId: cid,
        refTable: 'accreditation_ledger',
        refId: ledgerId,
        notes: 'وساطة معتمد — استيراد دفعة',
      });
    }
    if (remainder > 0 && salaryDirection === 'to_us' && mainFundId) {
      const fundType = pct > 0 ? 'accreditation_remainder' : 'accreditation_bulk';
      const fundNotes = pct > 0 ? 'باقي بعد الوساطة — استيراد' : 'استيراد رصيد معتمد';
      await adjustFundBalance(db, mainFundId, 'USD', remainder, fundType, fundNotes, 'accreditation_ledger', ledgerId);
      await insertLedgerEntry(db, {
        userId,
        bucket: 'main_cash',
        sourceType: pct > 0 ? 'accreditation_remainder' : 'accreditation_bulk_import',
        amount: remainder,
        cycleId: cid,
        refTable: 'accreditation_ledger',
        refId: ledgerId,
        notes: pct > 0 ? 'باقي بعد الوساطة — استيراد' : 'استيراد رصيد معتمد',
      });
    }
    ok++;
  }
  return { success: true, message: `تم معالجة ${ok} صف`, imported: ok, errors: errs };
}

async function processAccreditationBulkRows(db, userId, rows, cycleId, brokeragePctOpt) {
  if (!rows || rows.length < 2) {
    return { success: false, message: 'لا توجد بيانات كافية', imported: 0, errors: [] };
  }
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    items.push({
      code: row[0] != null ? String(row[0]).trim() : '',
      name: row[1] != null ? String(row[1]).trim() : '',
      amount: row[2],
      parentRef: row[3] != null ? String(row[3]).trim() : '',
      brokeragePct: brokeragePctOpt,
      salaryDirection: 'to_us',
      amountKind: 'salary',
    });
  }
  return processAccreditationBulkRowsFromItems(db, userId, items, cycleId, brokeragePctOpt);
}

module.exports = {
  processAccreditationBulkRows,
  processAccreditationBulkRowsFromItems,
  parseCsvTextToRows,
  buildBulkPreview,
};
