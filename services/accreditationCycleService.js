const { getDb } = require('../db/database');
const { getCycleColumns } = require('./payrollSearchService');
const { parseDecimal } = require('../utils/numbers');
const { adjustFundBalance, getMainFundId } = require('./fundService');
const { insertLedgerEntry } = require('./ledgerService');
const { syncNetBalance } = require('./accreditationBalance');

function columnLetterToIndex(letter) {
  if (letter == null || letter === '') return null;
  const s = String(letter).trim().toUpperCase();
  let idx = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 65;
    if (c < 0 || c > 25) return null;
    idx = idx * 26 + (c + 1);
  }
  return idx - 1;
}

function sumAgentSalaryColumn(agentData, salaryColLetter) {
  const idx = columnLetterToIndex(salaryColLetter || 'D') ?? 3;
  const rows = Array.isArray(agentData) ? agentData : [];
  let sum = 0;
  for (let i = 1; i < rows.length; i++) {
    sum += parseDecimal(rows[i] && rows[i][idx]);
  }
  return Math.round(sum * 100) / 100;
}

/**
 * عند إنشاء دورة مالية: إنشاء/تحديث المعتمد الرئيسي وإدراج مجموع جدول الوكيل في الصندوق الرئيسي.
 * يُطبَّق خصم نسبة التحويل: المبلغ الصافي يذهب للصندوق، ونسبة الخصم تُسجل ربحاً صافياً.
 */
async function ensurePrimaryAccreditationAfterCycleCreate(db, userId, cycleId, agentDataJson) {
  let agentData = [];
  try {
    agentData = typeof agentDataJson === 'string' ? JSON.parse(agentDataJson) : agentDataJson;
  } catch (_) {
    agentData = [];
  }
  if (!Array.isArray(agentData) || agentData.length < 2) {
    return { skipped: true, reason: 'no_agent_data' };
  }

  const cols = await getCycleColumns(userId, cycleId);
  const totalBeforeDiscount = sumAgentSalaryColumn(agentData, cols.agent_salary_col);
  if (totalBeforeDiscount <= 0) {
    const existing = (await db.query(
      'SELECT id FROM accreditation_entities WHERE user_id = $1 AND is_primary = 1 LIMIT 1',
      [userId]
    )).rows[0];
    if (!existing) {
      const r = await db.query(
        `INSERT INTO accreditation_entities (user_id, name, code, balance_amount, balance_payable, balance_receivable, is_primary)
         VALUES ($1, $2, $3, 0, 0, 0, 1) RETURNING id`,
        [userId, 'معتمد رئيسي', 'PRIMARY']
      );
      return { skipped: false, id: r.rows[0].id, total: 0 };
    }
    return { skipped: true, reason: 'no_salary_total', id: existing.id };
  }

  const cycle = (await db.query(
    'SELECT transfer_discount_pct FROM financial_cycles WHERE id = $1 AND user_id = $2',
    [cycleId, userId]
  )).rows[0];
  const discountPct = (cycle?.transfer_discount_pct != null && !isNaN(cycle.transfer_discount_pct))
    ? Number(cycle.transfer_discount_pct) : 0;
  const discountProfit = Math.round(totalBeforeDiscount * (discountPct / 100) * 100) / 100;
  const netTotal = Math.round((totalBeforeDiscount - discountProfit) * 100) / 100;

  let existing = (await db.query(
    'SELECT id FROM accreditation_entities WHERE user_id = $1 AND is_primary = 1 LIMIT 1',
    [userId]
  )).rows[0];

  let accId;
  if (!existing) {
    const ins = await db.query(
      `INSERT INTO accreditation_entities (user_id, name, code, balance_amount, balance_payable, balance_receivable, is_primary)
       VALUES ($1, $2, $3, $4, $4, 0, 1) RETURNING id`,
      [userId, 'معتمد رئيسي', 'PRIMARY', netTotal]
    );
    accId = ins.rows[0].id;
  } else {
    accId = existing.id;
    await db.query(
      'UPDATE accreditation_entities SET balance_payable = COALESCE(balance_payable,0) + $1 WHERE id = $2',
      [netTotal, accId]
    );
    await syncNetBalance(db, accId);
  }

  const dupLedger = (await db.query(
    `SELECT id FROM accreditation_ledger WHERE accreditation_id = $1 AND cycle_id = $2 AND entry_type = 'salary' LIMIT 1`,
    [accId, cycleId]
  )).rows[0];
  if (!dupLedger) {
    await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes)
       VALUES ($1, 'salary', $2, 'USD', 'to_us', $3, $4)`,
      [accId, netTotal, cycleId, 'مجموع جدول الوكيل — دورة مالية' + (discountPct > 0 ? ` (بعد خصم ${discountPct}%)` : '')]
    );
  }

  const mainFundId = await getMainFundId(db, userId);
  if (mainFundId) {
    const dupFund = (await db.query(
      `SELECT id FROM fund_ledger WHERE fund_id = $1 AND ref_table = 'accreditation_entities' AND ref_id = $2
       AND type = 'primary_agent_seed' AND notes LIKE $3 LIMIT 1`,
      [mainFundId, accId, `%دورة ${cycleId}%`]
    )).rows[0];
    if (!dupFund) {
      await adjustFundBalance(
        db,
        mainFundId,
        'USD',
        netTotal,
        'primary_agent_seed',
        `مجموع جدول الوكيل — دورة ${cycleId}` + (discountPct > 0 ? ` (بعد خصم ${discountPct}%)` : ''),
        'accreditation_entities',
        accId
      );
      await insertLedgerEntry(db, {
        userId,
        bucket: 'main_cash',
        sourceType: 'agent_table_primary_seed',
        amount: netTotal,
        cycleId,
        refTable: 'accreditation_entities',
        refId: accId,
        notes: `جدول الوكيل — دورة ${cycleId}`,
      });
    }
  }

  /** ربح خصم التحويل يُسجَّل مرة واحدة عبر transfer_discount_profit في rebuildDeferredFromLocalAgentData (بعد إنشاء الدورة) — لا نكرّر هنا */

  return { skipped: false, id: accId, total: netTotal, discountProfit, totalBeforeDiscount };
}

module.exports = {
  ensurePrimaryAccreditationAfterCycleCreate,
  sumAgentSalaryColumn,
  columnLetterToIndex,
};
