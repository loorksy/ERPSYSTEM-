/**
 * أرصدة مؤجلة لكل (مستخدم النظام، دورة، رقم مستخدم وكيل):
 * تُحفظ عبر الدورات ولا تُحذف عند إنشاء دورة جديدة؛ تُحدَّث فقط عند إعادة بناء/مزامنة تلك الدورة.
 */

const { getDb } = require('../db/database');

/**
 * @param {object} db
 * @param {number} userId مالك البيانات (جلسة)
 * @param {number} cycleId
 * @param {Array<{ member_user_id: string, extra_id_c?: string, balance_d: number, salary_before_discount?: number, sheet_source?: string }>} lineRows
 */
async function replaceDeferredLinesForCycle(db, userId, cycleId, lineRows) {
  await db.query(
    'DELETE FROM deferred_salary_lines WHERE user_id = $1 AND cycle_id = $2',
    [userId, cycleId]
  );
  for (const r of lineRows) {
    await db.query(
      `INSERT INTO deferred_salary_lines (user_id, cycle_id, member_user_id, extra_id_c, balance_d, salary_before_discount, sheet_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        cycleId,
        String(r.member_user_id),
        r.extra_id_c != null ? String(r.extra_id_c) : null,
        r.balance_d,
        r.salary_before_discount != null && !isNaN(r.salary_before_discount) ? r.salary_before_discount : null,
        r.sheet_source != null ? String(r.sheet_source) : null,
      ]
    );
  }
}

async function sumDeferredTotalAllCycles(db, userId) {
  const row = (await db.query(
    `SELECT COALESCE(SUM(balance_d), 0)::float AS t FROM deferred_salary_lines WHERE user_id = $1`,
    [userId]
  )).rows[0];
  return row?.t ?? 0;
}

/** عند تدقيق مستخدم في دورة: إزالة سطر المؤجل لتلك الدورة فقط */
async function removeDeferredLineForAuditedUser(db, userId, cycleId, memberUserId) {
  await db.query(
    'DELETE FROM deferred_salary_lines WHERE user_id = $1 AND cycle_id = $2 AND member_user_id = $3',
    [userId, cycleId, String(memberUserId)]
  );
}

async function getMemberDeferredHistory(db, userId, memberUserId) {
  return (await db.query(
    `SELECT l.id, l.cycle_id, l.balance_d, l.salary_before_discount, l.extra_id_c, l.sheet_source, l.updated_at,
            c.name AS cycle_name, c.created_at AS cycle_created_at
     FROM deferred_salary_lines l
     JOIN financial_cycles c ON c.id = l.cycle_id AND c.user_id = l.user_id
     WHERE l.user_id = $1 AND l.member_user_id = $2
     ORDER BY c.created_at ASC NULLS LAST, l.cycle_id ASC`,
    [userId, String(memberUserId)]
  )).rows;
}

/**
 * دمج كل أرصدة المؤجل لرقم مستخدم (عبر كل الدورات) في دورة مالية واحدة — بعد التدقيق المحاسبي.
 */
async function mergeMemberDeferredIntoCycle(db, userId, memberUserId, targetCycleId) {
  const mid = String(memberUserId).trim();
  const rows = (await db.query(
    `SELECT cycle_id, balance_d FROM deferred_salary_lines WHERE user_id = $1 AND member_user_id = $2`,
    [userId, mid]
  )).rows;
  if (!rows.length) {
    return { success: false, message: 'لا توجد أرصدة مؤجلة لهذا المستخدم في أي دورة' };
  }
  const cycleOk = (await db.query(
    'SELECT id FROM financial_cycles WHERE id = $1 AND user_id = $2',
    [targetCycleId, userId]
  )).rows[0];
  if (!cycleOk) {
    return { success: false, message: 'الدورة المستهدفة غير موجودة' };
  }
  const total = Math.round(rows.reduce((s, r) => s + (parseFloat(r.balance_d) || 0), 0) * 100) / 100;
  const mergedFromCycleIds = rows.map((r) => r.cycle_id);

  /** إزالة كل الأسطر المؤجلة؛ الدمج يُسجَّل كتدقيق في الدورة المستهدفة دون إبقاء رصيد مؤجل */
  await db.query('DELETE FROM deferred_salary_lines WHERE user_id = $1 AND member_user_id = $2', [userId, mid]);

  await db.query(
    `INSERT INTO payroll_user_audit_cache (user_id, cycle_id, member_user_id, audit_status, audit_source, details_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, cycle_id, member_user_id) DO UPDATE SET
       audit_status = excluded.audit_status,
       audit_source = excluded.audit_source,
       details_json = excluded.details_json,
       updated_at = CURRENT_TIMESTAMP`,
    [
      userId,
      targetCycleId,
      mid,
      'مدقق',
      'deferred_merge',
      JSON.stringify({ mergedFromCycleIds, consolidatedTotal: total }),
    ]
  );

  return {
    success: true,
    consolidatedTotal: total,
    mergedFromCycleIds,
    targetCycleId,
  };
}

module.exports = {
  replaceDeferredLinesForCycle,
  sumDeferredTotalAllCycles,
  removeDeferredLineForAuditedUser,
  getMemberDeferredHistory,
  mergeMemberDeferredIntoCycle,
};
