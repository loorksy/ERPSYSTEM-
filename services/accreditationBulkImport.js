const { adjustFundBalance, getMainFundId } = require('./fundService');
const { insertLedgerEntry } = require('./ledgerService');

/**
 * نفس منطق استيراد الأرصدة من ملف: أعمدة A كود، B اسم، C رصيد، D معتمد رئيسي.
 * @param {object} db
 * @param {number} userId
 * @param {string[][]} rows
 * @param {number|null} cycleId
 */
async function processAccreditationBulkRows(db, userId, rows, cycleId) {
  if (!rows || rows.length < 2) {
    return { success: false, message: 'لا توجد بيانات كافية', imported: 0, errors: [] };
  }
  const mainFundId = await getMainFundId(db, userId);
  if (!mainFundId) {
    return { success: false, message: 'عيّن صندوقاً رئيسياً أولاً', imported: 0, errors: [] };
  }
  let ok = 0;
  const errs = [];
  const cid = cycleId ? parseInt(cycleId, 10) : null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const code = row[0] != null ? String(row[0]).trim() : '';
    const name = row[1] != null ? String(row[1]).trim() : '';
    const bal = parseFloat(String(row[2]).replace(/,/g, ''));
    const parentRef = row[3] != null ? String(row[3]).trim() : '';
    if (!code || isNaN(bal) || bal <= 0) continue;
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
    const led = await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes)
       VALUES ($1, 'salary', $2, 'USD', 'to_us', $3, $4) RETURNING id`,
      [ent.id, bal, cid, 'استيراد دفعة — ' + (parentRef || '')]
    );
    const lid = led.rows[0].id;
    await db.query('UPDATE accreditation_entities SET balance_amount = balance_amount + $1 WHERE id = $2', [bal, ent.id]);
    await adjustFundBalance(db, mainFundId, 'USD', bal, 'accreditation_bulk', 'استيراد رصيد معتمد', 'accreditation_ledger', lid);
    await insertLedgerEntry(db, {
      userId,
      bucket: 'main_cash',
      sourceType: 'accreditation_bulk_import',
      amount: bal,
      cycleId: cid,
      refTable: 'accreditation_ledger',
      refId: lid,
    });
    ok++;
  }
  return { success: true, message: `تم معالجة ${ok} صف`, imported: ok, errors: errs };
}

function parseCsvTextToRows(text) {
  if (!text || !String(text).trim()) return [];
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => line.split(/[,\t]/).map((c) => c.trim()));
}

module.exports = { processAccreditationBulkRows, parseCsvTextToRows };
