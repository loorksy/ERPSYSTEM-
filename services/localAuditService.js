const {
  getCycleCache,
  getCycleColumns,
  saveUserAuditStatus,
  saveCycleCache,
  normalizeUserId,
  columnLetterToIndex,
} = require('./payrollSearchService');

/**
 * تعليم مستخدم كمدقق من الكاش المحلي فقط — بدون Google.
 * يطابق نتائج مسار التدقيق في أداة البحث (execute-audit-advanced):
 * - نفس أعمدة المستخدم من payroll_cycle_columns مع دعم أعمدة متعددة الحروف (AA…)
 * - التحقق من وجود المستخدم في جدول الإدارة و/أو الوكيل
 * - تحديث auditedAgentIds / auditedMgmtIds في payroll_cycle_cache كما في التدقيق الانتقائي
 */
async function markMemberAuditedLocal(userId, cycleId, memberIdRaw) {
  const member = normalizeUserId(memberIdRaw);
  if (!member) {
    return { success: false, message: 'رقم المستخدم غير صالح' };
  }
  const cache = await getCycleCache(userId, cycleId);
  if (!cache) {
    return {
      success: false,
      message: 'لا توجد بيانات دورة محفوظة محلياً. زامن من قسم Sheet أو انتظر المزامنة.',
    };
  }

  const cols = await getCycleColumns(userId, cycleId);
  const mgmtIdx = columnLetterToIndex(cols.mgmt_user_id_col || 'A') ?? 0;
  const agentIdx = columnLetterToIndex(cols.agent_user_id_col || 'A') ?? 0;

  const mgmtDataRows = (cache.managementData || []).slice(1);
  const agentDataRows = (cache.agentData || []).slice(1);

  let inMgmt = false;
  let inAgent = false;
  mgmtDataRows.forEach((row) => {
    const id = normalizeUserId(row[mgmtIdx]);
    if (id && id === member) inMgmt = true;
  });
  agentDataRows.forEach((row) => {
    const id = normalizeUserId(row[agentIdx]);
    if (id && id === member) inAgent = true;
  });

  if (!inMgmt && !inAgent) {
    return { success: false, message: 'هذا المستخدم غير موجود في بيانات الدورة المختارة' };
  }

  const auditedAgentIds = new Set(cache.auditedAgentIds || []);
  const auditedMgmtIds = new Set(cache.auditedMgmtIds || []);
  if (inAgent) auditedAgentIds.add(member);
  if (inMgmt) auditedMgmtIds.add(member);

  const foundInTargetSheetIds = cache.foundInTargetSheetIds || new Set([member]);

  await saveUserAuditStatus(
    userId,
    cycleId,
    member,
    'مدقق',
    'تدقيق محلي (بدون Google)',
    { via: 'local_audit', at: new Date().toISOString(), inMgmt, inAgent }
  );

  await saveCycleCache(userId, cycleId, {
    managementData: cache.managementData,
    agentData: cache.agentData,
    managementSheetName: cache.managementSheetName,
    agentSheetName: cache.agentSheetName,
    auditedAgentIds,
    auditedMgmtIds,
    foundInTargetSheetIds,
    staleAfter: cache.staleAfter || null,
  });

  return { success: true, message: 'تم تسجيل التدقيق محلياً' };
}

module.exports = {
  markMemberAuditedLocal,
};
