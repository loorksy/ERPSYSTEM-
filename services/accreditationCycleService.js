const { getDb } = require('../db/database');
const { getCycleColumns } = require('./payrollSearchService');
const { parseDecimal } = require('../utils/numbers');
const { adjustFundBalance, getMainFundId } = require('./fundService');
const { insertLedgerEntry } = require('./ledgerService');

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
 * عند إنشاء أول دورة مالية: إنشاء معتمد رئيسي وإدراج مجموع جدول الوكيل.
 */
async function ensurePrimaryAccreditationAfterCycleCreate(db, userId, cycleId, agentDataJson) {
  const cnt = (await db.query('SELECT COUNT(*)::int AS c FROM financial_cycles WHERE user_id = $1', [userId])).rows[0].c;
  if (cnt !== 1) return { skipped: true, reason: 'not_first_cycle' };

  const existing = (await db.query(
    'SELECT id FROM accreditation_entities WHERE user_id = $1 AND is_primary = 1 LIMIT 1',
    [userId]
  )).rows[0];
  if (existing) return { skipped: true, reason: 'primary_exists', id: existing.id };

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
  const total = sumAgentSalaryColumn(agentData, cols.agent_salary_col);
  if (total <= 0) {
    const r = await db.query(
      `INSERT INTO accreditation_entities (user_id, name, code, balance_amount, is_primary)
       VALUES ($1, $2, $3, 0, 1) RETURNING id`,
      [userId, 'معتمد رئيسي', 'PRIMARY']
    );
    return { skipped: false, id: r.rows[0].id, total: 0 };
  }

  const ins = await db.query(
    `INSERT INTO accreditation_entities (user_id, name, code, balance_amount, is_primary)
     VALUES ($1, $2, $3, $4, 1) RETURNING id`,
    [userId, 'معتمد رئيسي', 'PRIMARY', total]
  );
  const accId = ins.rows[0].id;

  await db.query(
    `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes)
     VALUES ($1, 'salary', $2, 'USD', 'to_us', $3, $4)`,
    [accId, total, cycleId, 'رصيد افتتاحي — مجموع جدول الوكيل (أول دورة)']
  );

  const mainFundId = await getMainFundId(db, userId);
  if (mainFundId) {
    await adjustFundBalance(
      db,
      mainFundId,
      'USD',
      total,
      'primary_agent_seed',
      'مجموع جدول الوكيل — أول دورة',
      'accreditation_entities',
      accId
    );
    await insertLedgerEntry(db, {
      userId,
      bucket: 'main_cash',
      sourceType: 'agent_table_primary_seed',
      amount: total,
      cycleId,
      refTable: 'accreditation_entities',
      refId: accId,
      notes: 'أول دورة — جدول الوكيل',
    });
  }

  return { skipped: false, id: accId, total };
}

module.exports = {
  ensurePrimaryAccreditationAfterCycleCreate,
  sumAgentSalaryColumn,
  columnLetterToIndex,
};
