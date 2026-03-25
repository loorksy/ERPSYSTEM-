const { getDb } = require('../db/database');

function normalizeForNumber(str) {
  if (str == null) return '';
  let out = String(str).replace(/[\u200B-\u200D\u2060\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim();
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  const western = '0123456789';
  for (let i = 0; i < 10; i++) {
    out = out.replace(new RegExp(arabic[i], 'g'), western[i]).replace(new RegExp(persian[i], 'g'), western[i]);
  }
  return out.replace(/[,،\u066C\s]/g, '');
}

function normalizeUserId(val) {
  const s = normalizeForNumber(val);
  if (!s) return '';
  const num = parseFloat(s);
  if (!isNaN(num) && isFinite(num)) return String(Math.floor(num));
  return s;
}

function parseJsonSafe(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

/** مطابق لـ columnLetterToIndex في routes/search.js — فهرس عمود من حرف (A…Z, AA…) */
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

function classifyManualStatus({ inMgmt, inAgent, mgmtColored, agentColored }) {
  const hasAnyColor = mgmtColored || agentColored;
  if (!inMgmt && !inAgent) {
    return { status: 'غير مدقق', source: null };
  }
  if (!hasAnyColor) {
    return { status: 'غير مدقق', source: null };
  }
  if (agentColored && !mgmtColored) {
    return { status: 'مدقق', source: 'مدقق وكيل يدوي' };
  }
  if (mgmtColored && !agentColored) {
    return { status: 'مدقق', source: 'مدقق ادارة يدوي' };
  }
  return { status: 'مدقق', source: 'مدقق يدوي' };
}

function computeSalaryWithDiscount(rawSalaries, discountRatePct) {
  const nums = (rawSalaries || []).map(v => {
    const n = parseFloat(normalizeForNumber(v));
    return isNaN(n) || !isFinite(n) ? 0 : n;
  });
  const sum = nums.reduce((a, b) => a + b, 0);
  const rate = typeof discountRatePct === 'number' && !isNaN(discountRatePct) ? discountRatePct : 0;
  const multiplier = Math.max(0, Math.min(1, 1 - rate / 100));
  const after = Math.round(sum * multiplier * 100) / 100;
  return { before: sum, after };
}

async function getCycleColumns(userId, cycleId) {
  const db = getDb();
  const row = (await db.query('SELECT mgmt_user_id_col, agent_user_id_col, agent_salary_col FROM payroll_cycle_columns WHERE user_id = $1 AND cycle_id = $2', [userId, cycleId])).rows[0];
  if (row) return row;
  return {
    mgmt_user_id_col: 'A',
    agent_user_id_col: 'A',
    agent_salary_col: 'D'
  };
}

async function saveCycleColumns(userId, cycleId, cols) {
  const db = getDb();
  await db.query(
    `INSERT INTO payroll_cycle_columns (user_id, cycle_id, mgmt_user_id_col, agent_user_id_col, agent_salary_col, updated_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, cycle_id) DO UPDATE SET
       mgmt_user_id_col = excluded.mgmt_user_id_col,
       agent_user_id_col = excluded.agent_user_id_col,
       agent_salary_col = excluded.agent_salary_col,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, cycleId, cols.mgmt_user_id_col || 'A', cols.agent_user_id_col || 'A', cols.agent_salary_col || 'D']
  );
}

async function getCycleCache(userId, cycleId) {
  const db = getDb();
  const row = (await db.query(
    `SELECT management_data, agent_data, management_sheet_name, agent_sheet_name,
            audited_agent_ids, audited_mgmt_ids, found_in_target_sheet_ids,
            synced_at, stale_after
       FROM payroll_cycle_cache
      WHERE user_id = $1 AND cycle_id = $2`,
    [userId, cycleId]
  )).rows[0];
  if (!row) return null;
  return {
    managementData: parseJsonSafe(row.management_data, []),
    agentData: parseJsonSafe(row.agent_data, []),
    managementSheetName: row.management_sheet_name || null,
    agentSheetName: row.agent_sheet_name || null,
    auditedAgentIds: new Set(parseJsonSafe(row.audited_agent_ids, [])),
    auditedMgmtIds: new Set(parseJsonSafe(row.audited_mgmt_ids, [])),
    foundInTargetSheetIds: new Set(parseJsonSafe(row.found_in_target_sheet_ids, [])),
    syncedAt: row.synced_at,
    staleAfter: row.stale_after
  };
}

async function saveCycleCache(userId, cycleId, payload) {
  const db = getDb();
  await db.query(
    `INSERT INTO payroll_cycle_cache (
       user_id, cycle_id,
       management_data, agent_data,
       management_sheet_name, agent_sheet_name,
       audited_agent_ids, audited_mgmt_ids, found_in_target_sheet_ids,
       synced_at, stale_after
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, $10)
     ON CONFLICT(user_id, cycle_id) DO UPDATE SET
       management_data = excluded.management_data,
       agent_data = excluded.agent_data,
       management_sheet_name = excluded.management_sheet_name,
       agent_sheet_name = excluded.agent_sheet_name,
       audited_agent_ids = excluded.audited_agent_ids,
       audited_mgmt_ids = excluded.audited_mgmt_ids,
       found_in_target_sheet_ids = excluded.found_in_target_sheet_ids,
       synced_at = CURRENT_TIMESTAMP,
       stale_after = excluded.stale_after`,
    [
      userId, cycleId,
      JSON.stringify(payload.managementData || []),
      JSON.stringify(payload.agentData || []),
      payload.managementSheetName || null,
      payload.agentSheetName || null,
      JSON.stringify(Array.from(payload.auditedAgentIds || [])),
      JSON.stringify(Array.from(payload.auditedMgmtIds || [])),
      JSON.stringify(Array.from(payload.foundInTargetSheetIds || [])),
      payload.staleAfter || null
    ]
  );
}

async function saveUserAuditStatus(userId, cycleId, memberUserId, status, source, details) {
  const db = getDb();
  await db.query(
    `INSERT INTO payroll_user_audit_cache (user_id, cycle_id, member_user_id, audit_status, audit_source, details_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, cycle_id, member_user_id) DO UPDATE SET
       audit_status = excluded.audit_status,
       audit_source = excluded.audit_source,
       details_json = excluded.details_json,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, cycleId, String(memberUserId), status, source || null, details ? JSON.stringify(details) : null]
  );
}

async function getUserAuditStatus(userId, cycleId, memberUserId) {
  const db = getDb();
  const row = (await db.query(
    `SELECT audit_status, audit_source, details_json
       FROM payroll_user_audit_cache
      WHERE user_id = $1 AND cycle_id = $2 AND member_user_id = $3`,
    [userId, cycleId, String(memberUserId)]
  )).rows[0];
  if (!row) return null;
  return {
    status: row.audit_status || 'غير مدقق',
    source: row.audit_source || null,
    details: parseJsonSafe(row.details_json, null)
  };
}

module.exports = {
  normalizeForNumber,
  normalizeUserId,
  computeSalaryWithDiscount,
  classifyManualStatus,
  columnLetterToIndex,
  getCycleColumns,
  saveCycleColumns,
  getCycleCache,
  saveCycleCache,
  saveUserAuditStatus,
  getUserAuditStatus
};

