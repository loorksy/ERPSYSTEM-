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
      `INSERT INTO deferred_salary_lines (user_id, cycle_id, member_user_id, extra_id_c, balance_d, salary_before_discount, sheet_source, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, cycle_id, member_user_id) DO UPDATE SET
         extra_id_c = EXCLUDED.extra_id_c,
         balance_d = deferred_salary_lines.balance_d + EXCLUDED.balance_d,
         salary_before_discount = COALESCE(EXCLUDED.salary_before_discount, deferred_salary_lines.salary_before_discount),
         sheet_source = EXCLUDED.sheet_source,
         updated_at = CURRENT_TIMESTAMP`,
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
  /** لا نجمع أسطراً مبنية على جدول الوكيل لدورة لم يبدأ لها تدقيق بعد (تجنّب إظهار إجمالي الرواتب كمؤجل) */
  const row = (await db.query(
    `SELECT COALESCE(SUM(l.balance_d), 0)::float AS t
     FROM deferred_salary_lines l
     WHERE l.user_id = $1
     AND (
       EXISTS (
         SELECT 1 FROM payroll_user_audit_cache p
         WHERE p.user_id = l.user_id AND p.cycle_id = l.cycle_id
       )
       OR l.sheet_source = 'member_adjustment'
     )`,
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

/** إزالة أسطر المؤجل لعدة مستخدمين دفعة واحدة (بعد تدقيق جماعي) */
async function removeDeferredLinesForAuditedUsers(db, userId, cycleId, memberUserIds) {
  if (!memberUserIds || !memberUserIds.length) return;
  const ids = memberUserIds.map((id) => String(id).trim()).filter(Boolean);
  if (!ids.length) return;
  await db.query(
    'DELETE FROM deferred_salary_lines WHERE user_id = $1 AND cycle_id = $2 AND member_user_id = ANY($3::text[])',
    [userId, cycleId, ids]
  );
  try {
    const { syncPrimaryAccreditationWithDeferred } = require('./primaryAccreditationDeferredSync');
    await syncPrimaryAccreditationWithDeferred(db, userId);
  } catch (_) {}
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
  try {
    const { upsertMemberProfileFromAudit } = require('./memberDirectoryService');
    await upsertMemberProfileFromAudit(db, userId, targetCycleId, mid, 'مدقق', 'deferred_merge', {
      mergedFromCycleIds,
      consolidatedTotal: total,
    });
  } catch (_) {}

  try {
    const { syncPrimaryAccreditationWithDeferred } = require('./primaryAccreditationDeferredSync');
    await syncPrimaryAccreditationWithDeferred(db, userId);
  } catch (_) {}

  return {
    success: true,
    consolidatedTotal: total,
    mergedFromCycleIds,
    targetCycleId,
  };
}

/**
 * خصم من أسطر المؤجل الفعلية (FIFO حسب أقدم دورة) بعد خصم من الرصيد في member_profiles.
 */
async function reduceDeferredLinesForMember(db, userId, memberUserId, amountToReduce) {
  let rem = Math.round(Number(amountToReduce) * 100) / 100;
  if (rem <= 0) return;
  const mid = String(memberUserId || '').trim();
  const lines = (
    await db.query(
      `SELECT l.id, l.balance_d
       FROM deferred_salary_lines l
       JOIN financial_cycles c ON c.id = l.cycle_id AND c.user_id = l.user_id
       WHERE l.user_id = $1 AND l.member_user_id = $2 AND l.balance_d > 0.00001
       ORDER BY c.created_at ASC NULLS LAST, l.cycle_id ASC`,
      [userId, mid]
    )
  ).rows;
  for (const line of lines) {
    if (rem <= 0) break;
    const bal = Number(line.balance_d) || 0;
    const take = Math.min(rem, bal);
    const newBal = Math.round((bal - take) * 100) / 100;
    rem = Math.round((rem - take) * 100) / 100;
    if (newBal <= 0.0001) {
      await db.query('DELETE FROM deferred_salary_lines WHERE id = $1', [line.id]);
    } else {
      await db.query(
        'UPDATE deferred_salary_lines SET balance_d = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newBal, line.id]
      );
    }
  }
  try {
    const { syncPrimaryAccreditationWithDeferred } = require('./primaryAccreditationDeferredSync');
    await syncPrimaryAccreditationWithDeferred(db, userId);
  } catch (_) {}
}

/**
 * إضافة إلى المؤجل عبر deferred_salary_lines ثم تُحدَّث اللقطة في member_profiles بالمزامنة.
 */
async function addDeferredAdjustmentToMemberLines(db, userId, memberUserId, amount, cycleIdOpt) {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (amt <= 0) return;
  const mid = String(memberUserId || '').trim();
  let cycleId = cycleIdOpt != null ? parseInt(cycleIdOpt, 10) : null;
  if (!cycleId || Number.isNaN(cycleId)) {
    const r = (await db.query(
      'SELECT id FROM financial_cycles WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    )).rows[0];
    cycleId = r?.id;
  }
  if (!cycleId) {
    throw new Error('لا توجد دورة مالية لربط المؤجل — أنشئ دورة أو اختر الدورة في النموذج');
  }
  await db.query(
    `INSERT INTO deferred_salary_lines (user_id, cycle_id, member_user_id, balance_d, sheet_source, updated_at)
     VALUES ($1, $2, $3, $4, 'member_adjustment', CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, cycle_id, member_user_id) DO UPDATE SET
       balance_d = deferred_salary_lines.balance_d + EXCLUDED.balance_d,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, cycleId, mid, amt]
  );
  try {
    const { syncPrimaryAccreditationWithDeferred } = require('./primaryAccreditationDeferredSync');
    await syncPrimaryAccreditationWithDeferred(db, userId);
  } catch (_) {}
}

module.exports = {
  replaceDeferredLinesForCycle,
  sumDeferredTotalAllCycles,
  removeDeferredLineForAuditedUser,
  removeDeferredLinesForAuditedUsers,
  getMemberDeferredHistory,
  mergeMemberDeferredIntoCycle,
  reduceDeferredLinesForMember,
  addDeferredAdjustmentToMemberLines,
};
