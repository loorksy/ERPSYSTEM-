const { getDb } = require('../db/database');
const { parseDecimal } = require('../utils/numbers');
const { normalizeUserId } = require('./payrollSearchService');
const { insertLedgerEntry } = require('./ledgerService');
const { replaceDeferredLinesForCycle } = require('./deferredSalaryService');
const { computeSalaryWithDiscount, getCycleColumns } = require('./payrollSearchService');
const { getMainFundId, adjustFundBalance } = require('./fundService');

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

function isHeaderRow(row, colIdx) {
  if (!row || colIdx == null) return true;
  const val = row[colIdx] != null ? String(row[colIdx]).trim() : '';
  if (!val) return true;
  const normalized = normalizeUserId(val);
  if (!normalized) return true;
  const n = parseFloat(normalized);
  return isNaN(n) || !isFinite(n);
}

/**
 * نفس منطق agencySyncService.calculateCashBoxBalance للصفوف المحلية (ورقة الإدارة الأولى)
 */
async function computeManagementSheetTotalsFromRows(rows) {
  const db = getDb();
  const COL_W = columnLetterToIndex('W') ?? 22;
  const COL_Y = columnLetterToIndex('Y') ?? 24;
  const COL_Z = columnLetterToIndex('Z') ?? 25;

  const headerRows = rows.length > 0 && isHeaderRow(rows[0], 0) ? 1 : 0;
  const dataRows = rows.slice(headerRows);

  const userLinks = (await db.query('SELECT member_user_id, sub_agency_id FROM user_agency_link')).rows;
  const userToAgency = {};
  userLinks.forEach(r => { userToAgency[r.member_user_id] = r.sub_agency_id; });

  let sourceFirstSheetW = 0;
  let sourceYZ = 0;

  for (const row of dataRows) {
    const memberUserId = normalizeUserId(row[0]);
    const wNum = parseDecimal(row[COL_W]);
    const agencyId = memberUserId ? userToAgency[memberUserId] : null;
    if (agencyId) {
      const agency = (await db.query('SELECT company_percent, commission_percent FROM shipping_sub_agencies WHERE id = $1', [agencyId])).rows[0];
      const cp = (agency?.company_percent != null && !isNaN(agency.company_percent))
        ? agency.company_percent
        : (100 - (agency?.commission_percent || 0));
      sourceFirstSheetW += wNum * (cp / 100);
    } else {
      sourceFirstSheetW += wNum;
    }
    sourceYZ += parseDecimal(row[COL_Y]) + parseDecimal(row[COL_Z]);
  }

  return { sourceFirstSheetW, sourceYZ };
}

function parseRows(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val;
  try {
    const j = typeof val === 'string' ? JSON.parse(val) : val;
    return Array.isArray(j) ? j : [];
  } catch (_) {
    return [];
  }
}

async function getLocalCycleTables(db, userId, cycleId) {
  const cache = (await db.query(
    `SELECT management_data, agent_data FROM payroll_cycle_cache WHERE user_id = $1 AND cycle_id = $2`,
    [userId, cycleId]
  )).rows[0];
  if (cache && cache.management_data) {
    return {
      managementData: parseRows(cache.management_data),
      agentData: parseRows(cache.agent_data),
    };
  }
  const c = (await db.query(
    'SELECT management_data, agent_data FROM financial_cycles WHERE id = $1 AND user_id = $2',
    [cycleId, userId]
  )).rows[0];
  if (!c) return null;
  return {
    managementData: parseRows(c.management_data),
    agentData: parseRows(c.agent_data),
  };
}

/**
 * تسجيل أرباح التدقيق في صافي الربح — قيدان منفصلان (Y+Z) و (W)، مرة واحدة لكل دورة.
 * القيد القديم audit_cycle_profits يُعتبر مكتملاً ولا يُكرَّر.
 */
async function applyCycleAuditProfitsToLedger(userId, cycleId) {
  const db = getDb();
  const legacy = (await db.query(
    `SELECT id FROM ledger_entries WHERE user_id = $1 AND cycle_id = $2 AND source_type = $3 LIMIT 1`,
    [userId, cycleId, 'audit_cycle_profits']
  )).rows[0];
  if (legacy) {
    return { success: false, message: 'تم تسجيل أرباح هذه الدورة مسبقاً', already: true };
  }

  const rowYz = (await db.query(
    `SELECT id FROM ledger_entries WHERE user_id = $1 AND cycle_id = $2 AND source_type = $3 LIMIT 1`,
    [userId, cycleId, 'audit_management_yz']
  )).rows[0];
  const rowW = (await db.query(
    `SELECT id FROM ledger_entries WHERE user_id = $1 AND cycle_id = $2 AND source_type = $3 LIMIT 1`,
    [userId, cycleId, 'audit_management_w']
  )).rows[0];
  if (rowYz && rowW) {
    return { success: false, message: 'تم تسجيل أرباح هذه الدورة مسبقاً', already: true };
  }

  const tables = await getLocalCycleTables(db, userId, cycleId);
  if (!tables || !tables.managementData || tables.managementData.length < 2) {
    return { success: false, message: 'لا توجد بيانات إدارة محفوظة للدورة. زامن الدورة أو حمّل الملفات.' };
  }

  const { sourceFirstSheetW, sourceYZ } = await computeManagementSheetTotalsFromRows(tables.managementData);
  const combined = sourceFirstSheetW + sourceYZ;

  if (!rowYz && sourceYZ !== 0) {
    await insertLedgerEntry(db, {
      userId,
      bucket: 'net_profit',
      sourceType: 'audit_management_yz',
      amount: sourceYZ,
      cycleId,
      notes: 'أرباح الإدارة: أعمدة Y+Z',
      meta: { sourceYZ },
    });
  }
  if (!rowW && sourceFirstSheetW !== 0) {
    await insertLedgerEntry(db, {
      userId,
      bucket: 'net_profit',
      sourceType: 'audit_management_w',
      amount: sourceFirstSheetW,
      cycleId,
      notes: 'أرباح الإدارة: عمود W (مع تقسيم وكالات فرعية)',
      meta: { sourceFirstSheetW },
    });
  }

  const mainFundId = await getMainFundId(db, userId);
  if (mainFundId && combined !== 0) {
    const dupFundCredit = (await db.query(
      `SELECT id FROM fund_ledger WHERE fund_id = $1 AND type = 'audit_profit_credit' AND notes LIKE $2 LIMIT 1`,
      [mainFundId, `%دورة ${cycleId}%`]
    )).rows[0];
    if (!dupFundCredit) {
      await adjustFundBalance(db, mainFundId, 'USD', combined, 'audit_profit_credit',
        `أرباح التدقيق (W+Y+Z) — دورة ${cycleId}`, 'financial_cycles', cycleId);
    }
  }

  return { success: true, sourceYZ, sourceFirstSheetW, combined };
}

/**
 * إعادة بناء رصيد المؤجل من جدول الوكيل المحفوظ مع خصم نسبة التحويل.
 */
async function rebuildDeferredFromLocalAgentData(userId, cycleId) {
  const db = getDb();
  const cycle = (await db.query(
    'SELECT transfer_discount_pct, agent_data FROM financial_cycles WHERE id = $1 AND user_id = $2',
    [cycleId, userId]
  )).rows[0];
  if (!cycle) return { success: false, message: 'الدورة غير موجودة' };

  let agentRows = [];
  const tables = await getLocalCycleTables(db, userId, cycleId);
  if (tables && tables.agentData) agentRows = tables.agentData;

  const cols = await getCycleColumns(userId, cycleId);
  const agentIdx = columnLetterToIndex(cols.agent_user_id_col || 'A') ?? 0;
  const agentSalaryIdx = columnLetterToIndex(cols.agent_salary_col || 'D') ?? 3;
  const discountPct = cycle.transfer_discount_pct != null && !isNaN(cycle.transfer_discount_pct)
    ? Number(cycle.transfer_discount_pct)
    : 0;

  const audited = (await db.query(
    'SELECT member_user_id FROM payroll_user_audit_cache WHERE cycle_id = $1 AND user_id = $2 AND audit_status = $3',
    [cycleId, userId, 'مدقق']
  )).rows;
  const auditedSet = new Set((audited || []).map(r => String(r.member_user_id)));

  const dataRows = agentRows.slice(1);
  let totalDeferred = 0;
  const users = [];
  const lineRows = [];
  let transferDiscountProfit = 0;

  for (const row of dataRows) {
    const uid = normalizeUserId(row[agentIdx]);
    if (!uid) continue;
    const { before, after } = computeSalaryWithDiscount([row[agentSalaryIdx]], discountPct);
    transferDiscountProfit += Math.round((before - after) * 100) / 100;
  }

  for (const row of dataRows) {
    const memberUserId = normalizeUserId(row[agentIdx]);
    if (!memberUserId || auditedSet.has(memberUserId)) continue;

    const { before, after } = computeSalaryWithDiscount([row[agentSalaryIdx]], discountPct);
    const balanceAfter = Math.round(after * 100) / 100;
    if (balanceAfter === 0) continue;

    totalDeferred += balanceAfter;
    users.push({ member_user_id: memberUserId, balance_d: balanceAfter });
    lineRows.push({
      member_user_id: memberUserId,
      extra_id_c: (row[2] != null ? String(row[2]) : '').trim(),
      balance_d: balanceAfter,
      salary_before_discount: Math.round(before * 100) / 100,
      sheet_source: 'local_agent_data',
    });
  }

  await replaceDeferredLinesForCycle(db, userId, cycleId, lineRows);

  if (transferDiscountProfit > 0) {
    const dup = (await db.query(
      `SELECT id FROM ledger_entries WHERE user_id = $1 AND cycle_id = $2 AND source_type = 'transfer_discount_profit' LIMIT 1`,
      [userId, cycleId]
    )).rows[0];
    if (!dup) {
      await insertLedgerEntry(db, {
        userId,
        bucket: 'net_profit',
        sourceType: 'transfer_discount_profit',
        amount: transferDiscountProfit,
        cycleId,
        notes: 'ربح نسبة خصم التحويل (جدول الوكيل)',
      });
    }
  }

  return { success: true, deferredBalance: totalDeferred, users, transferDiscountProfit };
}

module.exports = {
  computeManagementSheetTotalsFromRows,
  getLocalCycleTables,
  applyCycleAuditProfitsToLedger,
  rebuildDeferredFromLocalAgentData,
  columnLetterToIndex,
};
