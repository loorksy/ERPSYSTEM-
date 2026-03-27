/**
 * ملف مركزي لكل عضو (member_user_id) + أحداث + تجميعات من المؤجل والتدقيق.
 */

function salaryFromAuditDetails(details) {
  if (!details || typeof details !== 'object') return null;
  if (details.salaryAfterDiscount != null && !Number.isNaN(Number(details.salaryAfterDiscount))) {
    return Math.round(Number(details.salaryAfterDiscount) * 100) / 100;
  }
  if (details.salaryValue != null && !Number.isNaN(Number(details.salaryValue))) {
    return Math.round(Number(details.salaryValue) * 100) / 100;
  }
  if (details.salaryAfter != null && !Number.isNaN(Number(details.salaryAfter))) {
    return Math.round(Number(details.salaryAfter) * 100) / 100;
  }
  return null;
}

async function upsertMemberProfileFromAudit(db, userId, cycleId, memberUserId, status, source, details) {
  const mid = String(memberUserId || '').trim();
  if (!mid || !userId) return;
  const title = details && (details.title || details.name) ? String(details.title || details.name).trim() : null;
  const meta = details && typeof details === 'object' ? { ...details, lastAuditCycleId: cycleId, lastAuditAt: new Date().toISOString() } : { lastAuditCycleId: cycleId };
  const metaStr = JSON.stringify(meta);
  const salaryAmt = salaryFromAuditDetails(details);

  await db.query(
    `INSERT INTO member_profiles (user_id, member_user_id, display_name, last_seen_name, meta_json, updated_at)
     VALUES ($1, $2, COALESCE($3, $4), COALESCE($4, $3), $5, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, member_user_id) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, member_profiles.display_name),
       last_seen_name = COALESCE(EXCLUDED.last_seen_name, member_profiles.last_seen_name),
       meta_json = COALESCE(EXCLUDED.meta_json, member_profiles.meta_json),
       updated_at = CURRENT_TIMESTAMP`,
    [userId, mid, title, title, metaStr]
  );

  if (status === 'مدقق' && salaryAmt != null) {
    await db.query(
      `UPDATE member_profiles SET total_salary_audited_usd = $1, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2 AND member_user_id = $3`,
      [salaryAmt, userId, mid]
    );
  }

  if (status === 'مدقق') {
    await db.query(
      `INSERT INTO member_profile_events (user_id, member_user_id, event_type, amount, cycle_id, notes, status, meta_json)
       VALUES ($1, $2, 'audit_approved', $3, $4, $5, 'done', $6)`,
      [
        userId,
        mid,
        salaryAmt,
        cycleId || null,
        source || 'تدقيق',
        details ? JSON.stringify(details) : null,
      ]
    );
  }
}

async function refreshMemberDeferredSnapshot(db, userId, memberUserId) {
  const mid = String(memberUserId || '').trim();
  const row = (await db.query(
    `SELECT COALESCE(SUM(balance_d), 0)::float AS t FROM deferred_salary_lines WHERE user_id = $1 AND member_user_id = $2`,
    [userId, mid]
  )).rows[0];
  const total = row?.t ?? 0;
  await db.query(
    `INSERT INTO member_profiles (user_id, member_user_id, deferred_balance_usd, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, member_user_id) DO UPDATE SET
       deferred_balance_usd = EXCLUDED.deferred_balance_usd,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, mid, total]
  );
}

async function listMemberProfiles(db, userId, { q = '', page = 1, pageSize = 50 } = {}) {
  const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
  const p = Math.max(1, parseInt(page, 10) || 1);
  const offset = (p - 1) * ps;
  const qTrim = String(q || '').trim();
  const term = `%${qTrim}%`;

  const baseCte = `
    WITH all_ids AS (
      SELECT DISTINCT member_user_id FROM payroll_user_audit_cache WHERE user_id = $1
      UNION
      SELECT DISTINCT member_user_id FROM deferred_salary_lines WHERE user_id = $1
      UNION
      SELECT DISTINCT acu.member_user_id FROM agency_cycle_users acu
      INNER JOIN financial_cycles fc ON fc.id = acu.cycle_id AND fc.user_id = $1
      UNION
      SELECT DISTINCT member_user_id FROM member_profiles WHERE user_id = $1
    ),
    agg AS (
      SELECT
        m.member_user_id,
        mp.id,
        mp.display_name,
        mp.last_seen_name,
        mp.total_salary_audited_usd,
        mp.debt_to_company_usd,
        mp.updated_at AS profile_updated,
        (SELECT COALESCE(SUM(dsl.balance_d), 0)::float FROM deferred_salary_lines dsl
          WHERE dsl.user_id = $1 AND dsl.member_user_id = m.member_user_id) AS deferred_sum,
        (SELECT MAX(p.updated_at) FROM payroll_user_audit_cache p
          WHERE p.user_id = $1 AND p.member_user_id = m.member_user_id) AS last_audit_at
      FROM all_ids m
      LEFT JOIN member_profiles mp ON mp.user_id = $1 AND mp.member_user_id = m.member_user_id
    )
  `;

  const searchCond = qTrim === ''
    ? 'TRUE'
    : '(member_user_id ILIKE $2 OR COALESCE(display_name, \'\') ILIKE $2 OR COALESCE(last_seen_name, \'\') ILIKE $2)';

  const countParams = qTrim === '' ? [userId] : [userId, term];
  const countRow = (await db.query(
    `${baseCte} SELECT COUNT(*)::int AS c FROM agg WHERE ${searchCond}`,
    countParams
  )).rows[0];
  const total = countRow?.c ?? 0;

  const listParams = qTrim === '' ? [userId, ps, offset] : [userId, term, ps, offset];
  const rows = (await db.query(
    `${baseCte}
     SELECT
       COALESCE(id, 0) AS id,
       member_user_id,
       display_name,
       last_seen_name,
       total_salary_audited_usd,
       deferred_sum AS deferred_balance_usd,
       debt_to_company_usd,
       GREATEST(
         COALESCE(profile_updated, 'epoch'::timestamp),
         COALESCE(last_audit_at, 'epoch'::timestamp)
       ) AS updated_at
     FROM agg
     WHERE ${searchCond}
     ORDER BY updated_at DESC NULLS LAST, member_user_id ASC
     LIMIT $${qTrim === '' ? 2 : 3} OFFSET $${qTrim === '' ? 3 : 4}`,
    listParams
  )).rows;
  return { rows, total, page: p, pageSize: ps };
}

async function getMemberProfileRow(db, userId, memberUserId) {
  const mid = String(memberUserId || '').trim();
  return (await db.query(
    `SELECT * FROM member_profiles WHERE user_id = $1 AND member_user_id = $2`,
    [userId, mid]
  )).rows[0] || null;
}

function parseJsonSafe(s, fallback = null) {
  if (s == null || s === '') return fallback;
  try {
    return typeof s === 'string' ? JSON.parse(s) : s;
  } catch (_) {
    return fallback;
  }
}

async function getMemberDetail(db, userId, memberUserId) {
  const { getMemberDeferredHistory } = require('./deferredSalaryService');
  const mid = String(memberUserId || '').trim();
  await refreshMemberDeferredSnapshot(db, userId, mid);
  const profile = await getMemberProfileRow(db, userId, mid);
  const deferredHistory = await getMemberDeferredHistory(db, userId, mid);
  const auditRows = (await db.query(
    `SELECT p.cycle_id, p.audit_status, p.audit_source, p.details_json, p.updated_at,
            c.name AS cycle_name
     FROM payroll_user_audit_cache p
     LEFT JOIN financial_cycles c ON c.id = p.cycle_id AND c.user_id = p.user_id
     WHERE p.user_id = $1 AND p.member_user_id = $2
     ORDER BY p.updated_at DESC NULLS LAST
     LIMIT 50`,
    [userId, mid]
  )).rows;
  const auditRowsEnriched = auditRows.map((r) => {
    const d = parseJsonSafe(r.details_json, {});
    const sal = salaryFromAuditDetails(d);
    return {
      ...r,
      salary_audited_usd: sal,
      salary_before_usd:
        d.salaryBefore != null
          ? Number(d.salaryBefore)
          : d.salaryBeforeDiscount != null
            ? Number(d.salaryBeforeDiscount)
            : null,
    };
  });

  if (profile && auditRowsEnriched.length) {
    const latestSal = auditRowsEnriched.find((r) => r.salary_audited_usd != null)?.salary_audited_usd;
    const cur = Number(profile.total_salary_audited_usd || 0);
    if (latestSal != null && !Number.isNaN(latestSal) && cur === 0) {
      await db.query(
        `UPDATE member_profiles SET total_salary_audited_usd = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND member_user_id = $3`,
        [latestSal, userId, mid]
      );
      profile.total_salary_audited_usd = latestSal;
    }
  }
  const events = (await db.query(
    `SELECT id, event_type, amount, cycle_id, notes, status, meta_json, created_at
     FROM member_profile_events
     WHERE user_id = $1 AND member_user_id = $2
     ORDER BY created_at DESC
     LIMIT 100`,
    [userId, mid]
  )).rows;
  const adjustments = (await db.query(
    `SELECT id, kind, amount, status, notes, cycle_id, created_at, processed_at
     FROM member_adjustments
     WHERE user_id = $1 AND member_user_id = $2
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId, mid]
  )).rows;
  const shippingTransactions = (await db.query(
    `SELECT id, type, item_type, quantity, total, profit_amount, payment_method, status, created_at
     FROM shipping_transactions
     WHERE buyer_type = 'user' AND buyer_user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [mid]
  )).rows;
  return { profile, deferredHistory, auditRows: auditRowsEnriched, events, adjustments, shippingTransactions };
}

module.exports = {
  salaryFromAuditDetails,
  upsertMemberProfileFromAudit,
  refreshMemberDeferredSnapshot,
  listMemberProfiles,
  getMemberProfileRow,
  getMemberDetail,
};
