/**
 * محرك تدقيق الرواتب — نفس منطق routes/sheet.js payroll-execute (بدون Google).
 */

const {
  normalizeForNumber,
  normalizeUserId,
  columnLetterToIndex,
} = require('./payrollSearchService');

function isHeaderRowUserInfo(row, colC) {
  const c = normalizeForNumber(row[colC]);
  const n = parseFloat(c);
  return c === '' || isNaN(n) || !isFinite(n);
}

function isHeaderRowCycle(row, colIndex) {
  const col = colIndex ?? 0;
  const first = normalizeForNumber(row[col] != null ? row[col] : '');
  if (!first) return true;
  const n = parseFloat(first);
  return isNaN(n) || !isFinite(n);
}

/**
 * @param {object} params
 * @param {any[][]} params.managementRows
 * @param {any[][]} params.agentRows
 * @param {any[][]} params.userInfoRows — صفوف ورقة معلومات المستخدمين (قد يتضمن صف عناوين)
 * @param {object} params.columns
 * @param {string} [params.columns.userInfoUserIdCol='C']
 * @param {string} [params.columns.userInfoTitleCol='D']
 * @param {string} [params.columns.userInfoSalaryCol='L']
 * @param {string} [params.columns.cycleMgmtUserIdCol='A']
 * @param {string} [params.columns.cycleAgentUserIdCol='A']
 * @param {string} [params.columns.cycleAgentSalaryCol='D']
 * @param {number} [params.discountRatePct=0]
 * @param {string} [params.agentColor]
 * @param {string} [params.managementColor]
 */
function runPayrollAuditCore({
  managementRows,
  agentRows,
  userInfoRows,
  columns = {},
  discountRatePct = 0,
  agentColor,
  managementColor,
}) {
  const userInfoUserIdCol = columns.userInfoUserIdCol || 'C';
  const userInfoTitleCol = columns.userInfoTitleCol || 'D';
  const userInfoSalaryCol = columns.userInfoSalaryCol || 'L';
  const cycleMgmtUserIdCol = columns.cycleMgmtUserIdCol || 'A';
  const cycleAgentUserIdCol = columns.cycleAgentUserIdCol || 'A';
  const cycleAgentSalaryCol = columns.cycleAgentSalaryCol || 'D';

  const COL_C = columnLetterToIndex(userInfoUserIdCol) ?? 2;
  const COL_D = columnLetterToIndex(userInfoTitleCol) ?? 3;
  const cycleMgmtCol = columnLetterToIndex(cycleMgmtUserIdCol) ?? 0;
  const cycleAgentCol = columnLetterToIndex(cycleAgentUserIdCol) ?? 0;
  const cycleAgentSalaryColIdx = columnLetterToIndex(cycleAgentSalaryCol) ?? 3;

  const allRows = Array.isArray(userInfoRows) ? userInfoRows : [];
  const dataStart = allRows.length > 0 && isHeaderRowUserInfo(allRows[0], COL_C) ? 1 : 0;
  const dataRows = allRows.slice(dataStart);

  const discountMultiplier = Math.max(0, Math.min(1, 1 - Number(discountRatePct || 0) / 100));

  const agentRowsList = Array.isArray(agentRows) ? agentRows : [];
  const agentHeaderRows = agentRowsList.length > 0 && isHeaderRowCycle(agentRowsList[0], cycleAgentCol) ? 1 : 0;
  const agentDataRows = agentRowsList.length > 0 && isHeaderRowCycle(agentRowsList[0], cycleAgentCol)
    ? agentRowsList.slice(1)
    : agentRowsList;
  const agentByUserId = {};
  agentDataRows.forEach((row, idx) => {
    const id = normalizeUserId(row[cycleAgentCol]);
    if (!id) return;
    if (!agentByUserId[id]) agentByUserId[id] = [];
    agentByUserId[id].push({ row, idx, sheetRowIndex: agentHeaderRows + idx });
  });

  const mgmtRowsList = Array.isArray(managementRows) ? managementRows : [];
  const mgmtHeaderRows = mgmtRowsList.length > 0 && isHeaderRowCycle(mgmtRowsList[0], cycleMgmtCol) ? 1 : 0;
  const mgmtDataRows = mgmtRowsList.length > 0 && isHeaderRowCycle(mgmtRowsList[0], cycleMgmtCol)
    ? mgmtRowsList.slice(1)
    : mgmtRowsList;
  const mgmtByUserId = {};
  mgmtDataRows.forEach((row, idx) => {
    const id = normalizeUserId(row[cycleMgmtCol]);
    if (id) mgmtByUserId[id] = { row, sheetRowIndex: mgmtHeaderRows + idx };
  });

  const agentColorVal = agentColor || '#3b82f6';
  const mgmtColorVal = managementColor || '#10b981';

  const results = [];
  const byTitle = {};

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const uid = normalizeUserId(row[COL_C]);
    const title = (row[COL_D] != null ? String(row[COL_D]) : '').trim() || `صف_${i + 1}`;
    const agentMatches = uid ? (agentByUserId[uid] || []) : [];
    const mgmtEntry = uid ? mgmtByUserId[uid] : null;
    const mgmtRow = mgmtEntry ? mgmtEntry.row : null;
    const inAgent = agentMatches.length > 0;
    const inMgmt = !!mgmtRow;

    let type = 'غير موجود';
    let salaryValue = '';
    let statusLabel = '';
    if (inAgent && inMgmt) {
      type = agentMatches.length > 1 ? 'سحب وكالة - راتبيين' : 'سحب وكالة';
      const rawSalaries = agentMatches.map((m) => {
        const v = m.row[cycleAgentSalaryColIdx];
        const n = parseFloat(normalizeForNumber(v != null ? v : ''));
        return isNaN(n) || !isFinite(n) ? 0 : n;
      });
      const sumRaw = rawSalaries.reduce((a, b) => a + b, 0);
      const afterDiscount = Math.round(sumRaw * discountMultiplier * 100) / 100;
      salaryValue = afterDiscount;
      statusLabel = agentMatches.length > 1 ? 'سحب وكيل راتبين' : 'سحب وكيل';
    } else if (inMgmt) {
      type = 'سحب إدارة';
      salaryValue = 0;
      statusLabel = 'سحب ادارة';
    }

    results.push({
      userId: uid,
      title,
      type,
      managementRow: mgmtRow,
      mgmtSheetRowIndex: mgmtEntry ? mgmtEntry.sheetRowIndex : null,
      agentSheetRowIndices: agentMatches.map((m) => m.sheetRowIndex),
      salaryValue,
      statusLabel,
      rowIndex: dataStart + i + 1,
    });

    if ((type.startsWith('سحب وكالة') || type === 'سحب إدارة') && mgmtRow) {
      if (!byTitle[title]) byTitle[title] = [];
      const rowColor = type.startsWith('سحب وكالة') ? agentColorVal : mgmtColorVal;
      byTitle[title].push({
        managementRow: mgmtRow,
        color: rowColor,
        type,
      });
    }
  }

  const summary = {
    total: results.length,
    agent: results.filter((r) => r.type.startsWith('سحب وكالة')).length,
    management: results.filter((r) => r.type === 'سحب إدارة').length,
    notFound: results.filter((r) => r.type === 'غير موجود').length,
  };

  return {
    results,
    byTitle,
    summary,
    dataStart,
    dataRows,
    agentColorVal,
    mgmtColorVal,
    meta: { COL_C, COL_D, COL_L: columnLetterToIndex(userInfoSalaryCol) ?? 11 },
    /** لعينات التشخيص في payroll-execute */
    diagnosticContext: {
      dataRows,
      mgmtDataRows,
      agentDataRows,
      cycleMgmtCol,
      cycleAgentCol,
      COL_C,
      mgmtByUserId,
      agentByUserId,
    },
  };
}

/**
 * أرقام مستخدمين مكررة في عمود المعرف في جدول معلومات المستخدمين (بعد صف العناوين إن وُجد).
 * @returns {{ duplicateIds: string[], duplicateRowNumbers: number[] }}
 */
function findDuplicateUserInfoMemberIds(userInfoRows, userInfoUserIdCol) {
  const COL_C = columnLetterToIndex(userInfoUserIdCol || 'C') ?? 2;
  const allRows = Array.isArray(userInfoRows) ? userInfoRows : [];
  const dataStart = allRows.length > 0 && isHeaderRowUserInfo(allRows[0], COL_C) ? 1 : 0;
  const seen = new Map();
  const duplicateIds = [];
  const duplicateRowNumbers = [];
  for (let i = dataStart; i < allRows.length; i++) {
    const id = normalizeUserId(allRows[i][COL_C]);
    if (!id) continue;
    if (seen.has(id)) {
      duplicateIds.push(id);
      duplicateRowNumbers.push(i + 1);
    } else {
      seen.set(id, i + 1);
    }
  }
  return {
    duplicateIds: [...new Set(duplicateIds)],
    duplicateRowNumbers,
  };
}

module.exports = {
  runPayrollAuditCore,
  isHeaderRowUserInfo,
  isHeaderRowCycle,
  findDuplicateUserInfoMemberIds,
};
