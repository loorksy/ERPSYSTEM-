const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { google } = require('googleapis');
const {
  normalizeUserId,
  computeSalaryWithDiscount,
  classifyManualStatus,
  getCycleColumns,
  getCycleCache,
  getUserAuditStatus,
  saveCycleCache,
  saveUserAuditStatus
} = require('../services/payrollSearchService');
const { getMemberDeferredHistory } = require('../services/deferredSalaryService');

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

function hexToRgb(hex) {
  const h = String(hex).replace(/^#/, '');
  if (h.length !== 6) return { red: 1, green: 1, blue: 1 };
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return { red: r, green: g, blue: b };
}

function safeHexColor(input, fallback) {
  if (!input) return fallback;
  let s = String(input).trim();
  if (s[0] === '#') s = s.slice(1);
  if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toLowerCase();
  return fallback;
}

router.get('/cycles', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query('SELECT id, name, created_at FROM financial_cycles WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId])).rows;
    res.json({ success: true, cycles: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الدورات' });
  }
});

router.get('/pending-cycles', requireAuth, async (req, res) => {
  try {
    const userIdRaw = req.query.userId;
    if (!userIdRaw) {
      return res.json({ success: false, message: 'رقم المستخدم مطلوب' });
    }
    const member = normalizeUserId(userIdRaw);
    if (!member) {
      return res.json({ success: false, message: 'رقم المستخدم غير صالح' });
    }

    const db = getDb();
    const cycles = (await db.query('SELECT id, name FROM financial_cycles WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId])).rows;

    const pending = [];
    for (const cycle of cycles) {
      const cache = await getCycleCache(req.session.userId, cycle.id);
      if (!cache) continue;
      const cols = await getCycleColumns(req.session.userId, cycle.id);
      const mgmtIdx = (cols.mgmt_user_id_col || 'A').toUpperCase().charCodeAt(0) - 65;
      const agentIdx = (cols.agent_user_id_col || 'A').toUpperCase().charCodeAt(0) - 65;

      const mgmtRows = (cache.managementData || []).slice(1);
      const agentRows = (cache.agentData || []).slice(1);
      let inMgmt = false;
      let inAgent = false;

    mgmtRows.forEach(row => {
      const id = normalizeUserId(row[mgmtIdx]);
      if (id && id === member) inMgmt = true;
    });
    agentRows.forEach(row => {
      const id = normalizeUserId(row[agentIdx]);
      if (id && id === member) inAgent = true;
    });

      if (!inMgmt && !inAgent) continue;

      const cachedAudit = await getUserAuditStatus(req.session.userId, cycle.id, member);
      const manual = classifyManualStatus({
        inMgmt,
        inAgent,
        mgmtColored: cache.auditedMgmtIds.has(member),
        agentColored: cache.auditedAgentIds.has(member)
      });
      const finalAuditStatus = cachedAudit?.status || manual.status;
      if (!finalAuditStatus || finalAuditStatus === 'غير مدقق') {
        pending.push({
          id: cycle.id,
          name: cycle.name || `دورة #${cycle.id}`
        });
      }
    }

    res.json({ success: true, cycles: pending });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الدورات غير المدققة' });
  }
});

router.get('/cycle-sheets', requireAuth, async (req, res) => {
  try {
    const cycleId = Number(req.query.cycleId);
    if (!cycleId) return res.json({ success: false, message: 'معرّف الدورة مطلوب' });
    const db = getDb();
    const cycle = (await db.query('SELECT management_spreadsheet_id FROM financial_cycles WHERE id = $1 AND user_id = $2', [cycleId, req.session.userId])).rows[0];
    if (!cycle || !cycle.management_spreadsheet_id) {
      return res.json({ success: false, message: 'هذه الدورة غير مرتبطة بجدول إدارة في Google' });
    }

    const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
    if (!config?.token) {
      return res.json({ success: false, message: 'لم يتم تسجيل الدخول بـ Google' });
    }
    const credentials = config.credentials ? JSON.parse(config.credentials) : null;
    const clientId = credentials?.client_id || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = credentials?.client_secret || process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.json({ success: false, message: 'بيانات الاعتماد غير متوفرة' });
    }
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      process.env.GOOGLE_REDIRECT_URI ||
        `${process.env.BASE_URL || 'http://localhost:3000'}/sheets/callback`
    );
    oauth2Client.setCredentials(
      typeof config.token === 'string' ? JSON.parse(config.token) : config.token
    );
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: String(cycle.management_spreadsheet_id).trim()
    });
    const list = (meta.data.sheets || []).map(s => ({
      title: s.properties?.title || '',
      id: s.properties?.sheetId
    }));
    res.json({ success: true, sheets: list });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب أوراق الدورة' });
  }
});

router.get('/user-across-cycles', requireAuth, async (req, res) => {
  try {
    const userIdRaw = req.query.userId;
    const discountRate = req.query.discountRate != null ? Number(req.query.discountRate) : null;
    if (!userIdRaw) {
      return res.json({ success: false, message: 'رقم المستخدم مطلوب' });
    }
    const queryId = normalizeUserId(userIdRaw);
    if (!queryId) {
      return res.json({ success: false, message: 'رقم المستخدم غير صالح' });
    }

    const db = getDb();
    const cycles = (await db.query('SELECT id, name FROM financial_cycles WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId])).rows;

    const results = [];
    let globalName = '';

    for (const cycle of cycles) {
      const cache = await getCycleCache(req.session.userId, cycle.id);
      if (!cache) continue;

      const cols = await getCycleColumns(req.session.userId, cycle.id);
      const mgmtColIdx = (cols.mgmt_user_id_col || 'A').toUpperCase().charCodeAt(0) - 65;
      const agentUserColIdx = (cols.agent_user_id_col || 'A').toUpperCase().charCodeAt(0) - 65;
      const agentSalaryColIdx = (cols.agent_salary_col || 'D').toUpperCase().charCodeAt(0) - 65;

      const mgmtRows = cache.managementData || [];
      const agentRows = cache.agentData || [];

      let inMgmt = false;
      let inAgent = false;
      const agentSalaryCells = [];
      let name = '';

      const mgmtDataRows = mgmtRows.slice(1);
      mgmtDataRows.forEach(row => {
        const id = normalizeUserId(row[mgmtColIdx]);
        if (id && id === queryId) {
          inMgmt = true;
          if (!name && row[1]) name = String(row[1]);
        }
      });

      const agentDataRows = agentRows.slice(1);
      agentDataRows.forEach(row => {
        const id = normalizeUserId(row[agentUserColIdx]);
        if (id && id === queryId) {
          inAgent = true;
          if (!name && row[1]) name = String(row[1]);
          agentSalaryCells.push(row[agentSalaryColIdx]);
        }
      });

      if (!inMgmt && !inAgent) return;
      if (!globalName && name) globalName = name;

      const salaryInfo = computeSalaryWithDiscount(agentSalaryCells, discountRate || 0);

      let logicalStatus = 'غير موجود';
      if (inAgent && inMgmt) logicalStatus = agentSalaryCells.length > 1 ? 'سحب وكيل راتبين' : 'سحب وكيل';
      else if (inMgmt) logicalStatus = 'سحب ادارة';

      const cycleAuditedAgentIds = cache.auditedAgentIds || new Set();
      const cycleAuditedMgmtIds = cache.auditedMgmtIds || new Set();

      const agentColored = Array.from(cycleAuditedAgentIds).some(function(id) {
        return id && id === queryId;
      });
      const mgmtColored = Array.from(cycleAuditedMgmtIds).some(function(id) {
        return id && id === queryId;
      });

      const manual = classifyManualStatus({
        inMgmt,
        inAgent,
        mgmtColored: mgmtColored,
        agentColored: agentColored
      });

      const cachedAudit = await getUserAuditStatus(req.session.userId, cycle.id, queryId);
      const finalAuditStatus = cachedAudit?.status || manual.status;
      const finalAuditSource = cachedAudit?.source || manual.source;

      results.push({
        cycleId: cycle.id,
        cycleName: cycle.name || `دورة #${cycle.id}`,
        logicalStatus,
        salaryBeforeDiscount: salaryInfo.before,
        salaryAfterDiscount: salaryInfo.after,
        auditStatus: finalAuditStatus,
        auditSource: finalAuditSource
      });
    }

    if (!results.length) {
      return res.json({
        success: false,
        message: 'رقم المستخدم غير موجود في أي دورة مالية حالية'
      });
    }

    res.json({
      success: true,
      userId: queryId,
      name: globalName || null,
      cycles: results
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل البحث عبر كل الدورات' });
  }
});

router.get('/search-user', requireAuth, async (req, res) => {
  try {
    const userIdRaw = req.query.userId;
    const cycleId = Number(req.query.cycleId);
    const discountRate = req.query.discountRate != null ? Number(req.query.discountRate) : null;
    if (!userIdRaw || !cycleId) {
      return res.json({ success: false, message: 'رقم المستخدم والدورة مطلوبان' });
    }
    const queryId = normalizeUserId(userIdRaw);
    if (!queryId) {
      return res.json({ success: false, message: 'رقم المستخدم غير صالح' });
    }

    const db = getDb();
    const cycle = (await db.query('SELECT id, user_id, name FROM financial_cycles WHERE id = $1 AND user_id = $2', [cycleId, req.session.userId])).rows[0];
    if (!cycle) {
      return res.json({ success: false, message: 'الدورة غير موجودة' });
    }

    const cycleCache = await getCycleCache(req.session.userId, cycleId);
    if (!cycleCache) {
      return res.json({ success: false, message: 'لم يتم مزامنة الدورة بعد. انتظر المزامنة الخلفية أو نفّذ التدقيق من قسم الرواتب.' });
    }

    const cols = await getCycleColumns(req.session.userId, cycleId);
    const mgmtColIdx = (cols.mgmt_user_id_col || 'A').toUpperCase().charCodeAt(0) - 65;
    const agentUserColIdx = (cols.agent_user_id_col || 'A').toUpperCase().charCodeAt(0) - 65;
    const agentSalaryColIdx = (cols.agent_salary_col || 'D').toUpperCase().charCodeAt(0) - 65;

    const mgmtRows = cycleCache.managementData || [];
    const agentRows = cycleCache.agentData || [];

    let inMgmt = false;
    let inAgent = false;
    const agentSalaryCells = [];
    let name = '';
    let canonicalId = null;

    const mgmtDataRows = mgmtRows.slice(1);
    mgmtDataRows.forEach(row => {
      const id = normalizeUserId(row[mgmtColIdx]);
      if (id && id === queryId) {
        inMgmt = true;
        if (!canonicalId) canonicalId = id;
        if (!name && row[1]) name = String(row[1]);
      }
    });

    const agentDataRows = agentRows.slice(1);
    agentDataRows.forEach(row => {
      const id = normalizeUserId(row[agentUserColIdx]);
      if (id && id === queryId) {
        inAgent = true;
        if (!canonicalId) canonicalId = id;
        if (!name && row[1]) name = String(row[1]);
        agentSalaryCells.push(row[agentSalaryColIdx]);
      }
    });

    const salaryInfo = computeSalaryWithDiscount(agentSalaryCells, discountRate || 0);

    let logicalStatus = 'غير موجود';
    if (inAgent && inMgmt) logicalStatus = agentSalaryCells.length > 1 ? 'سحب وكيل راتبين' : 'سحب وكيل';
    else if (inMgmt) logicalStatus = 'سحب ادارة';

    const cycleAuditedAgentIds = cycleCache.auditedAgentIds || new Set();
    const cycleAuditedMgmtIds = cycleCache.auditedMgmtIds || new Set();

    const agentColored = Array.from(cycleAuditedAgentIds).some(function(id) {
      return id && id.indexOf(queryId) !== -1;
    });
    const mgmtColored = Array.from(cycleAuditedMgmtIds).some(function(id) {
      return id && id.indexOf(queryId) !== -1;
    });

    const manual = classifyManualStatus({
      inMgmt,
      inAgent,
      mgmtColored: mgmtColored,
      agentColored: agentColored
    });

    const cachedAudit = canonicalId
      ? await getUserAuditStatus(req.session.userId, cycleId, canonicalId)
      : null;

    const finalAuditStatus = cachedAudit?.status || manual.status;
    const finalAuditSource = cachedAudit?.source || manual.source;

    res.json({
      success: true,
      cycleId,
      memberId: canonicalId || queryId,
      name: name || null,
      salaryBeforeDiscount: salaryInfo.before,
      salaryAfterDiscount: salaryInfo.after,
      logicalStatus,
      auditStatus: finalAuditStatus,
      auditSource: finalAuditSource,
      manualFromColors: manual
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل البحث عن المستخدم' });
  }
});

router.post('/execute-audit', requireAuth, async (req, res) => {
  try {
    const { cycleId, memberId } = req.body || {};
    const cycleIdNum = Number(cycleId);
    const member = normalizeUserId(memberId);
    if (!cycleIdNum || !member) {
      return res.json({ success: false, message: 'معرّف الدورة ورقم المستخدم مطلوبان' });
    }

    const db = getDb();
    const cycle = (await db.query('SELECT id, user_id FROM financial_cycles WHERE id = $1 AND user_id = $2', [cycleIdNum, req.session.userId])).rows[0];
    if (!cycle) {
      return res.json({ success: false, message: 'الدورة غير موجودة' });
    }

    const cache = await getCycleCache(req.session.userId, cycleIdNum);
    let auditedAgentIds = cache?.auditedAgentIds || new Set();
    let auditedMgmtIds = cache?.auditedMgmtIds || new Set();

    auditedAgentIds.add(member);
    auditedMgmtIds.add(member);

    await saveUserAuditStatus(
      req.session.userId,
      cycleIdNum,
      member,
      'مدقق',
      'مدقق من صفحة البحث',
      { via: 'search', at: new Date().toISOString() }
    );

    if (cache) {
      await saveCycleCache(req.session.userId, cycleIdNum, {
        managementData: cache.managementData,
        agentData: cache.agentData,
        managementSheetName: cache.managementSheetName,
        agentSheetName: cache.agentSheetName,
        auditedAgentIds,
        auditedMgmtIds,
        foundInTargetSheetIds: cache.foundInTargetSheetIds || new Set(),
        staleAfter: cache.staleAfter || null
      });
    }

    return res.json({
      success: true,
      message: 'تم تعليم المستخدم كمدقق في هذه الدورة. أعد البحث للتأكد من تحديث الحالة.'
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل تنفيذ التدقيق من صفحة البحث' });
  }
});

router.post('/execute-audit-advanced', requireAuth, async (req, res) => {
  try {
    const {
      targetCycleId,
      memberId,
      targetSheetTitle,
      createIfMissing,
      discountRate,
      agentColor,
      managementColor
    } = req.body || {};

    const cycleIdNum = Number(targetCycleId);
    const member = normalizeUserId(memberId);
    if (!cycleIdNum || !member) {
      return res.json({ success: false, message: 'اختر الدورة وأدخل رقم المستخدم أولاً' });
    }
    const db = getDb();
    const cycle = (await db.query(
      `SELECT id, user_id, name,
              management_spreadsheet_id, management_sheet_name,
              agent_spreadsheet_id, agent_sheet_name
         FROM financial_cycles
        WHERE id = $1 AND user_id = $2`,
      [cycleIdNum, req.session.userId]
    )).rows[0];
    if (!cycle || !cycle.management_spreadsheet_id) {
      return res.json({
        success: false,
        message: 'هذه الدورة غير مرتبطة بجدول إدارة في Google. استخدم قسم Sheet لإنشاء دورة مرتبطة.'
      });
    }

    const cache = await getCycleCache(req.session.userId, cycleIdNum);
    if (!cache) {
      return res.json({
        success: false,
        message: 'لم يتم مزامنة هذه الدورة بعد. انتظر المزامنة الخلفية أو نفّذ مزامنة من قسم Sheet.'
      });
    }

    const cols = await getCycleColumns(req.session.userId, cycleIdNum);
    const mgmtIdx = (cols.mgmt_user_id_col || 'A').toUpperCase().charCodeAt(0) - 65;
    const agentIdx = (cols.agent_user_id_col || 'A').toUpperCase().charCodeAt(0) - 65;
    const agentSalaryIdx = columnLetterToIndex(cols.agent_salary_col || 'D') ?? 3;

    const mgmtRows = cache.managementData || [];
    const agentRows = cache.agentData || [];

    const mgmtDataRows = mgmtRows.slice(1);
    const agentDataRows = agentRows.slice(1);

    let mgmtRow = null;
    const agentMatches = [];

    mgmtDataRows.forEach(row => {
      const id = normalizeUserId(row[mgmtIdx]);
      if (id && id === member && !mgmtRow) {
        mgmtRow = row;
      }
    });
    agentDataRows.forEach(row => {
      const id = normalizeUserId(row[agentIdx]);
      if (id && id === member) {
        agentMatches.push(row);
      }
    });

    const inMgmt = !!mgmtRow;
    const inAgent = agentMatches.length > 0;
    if (!inMgmt && !inAgent) {
      return res.json({
        success: false,
        message: 'هذا المستخدم غير موجود في بيانات الدورة المختارة'
      });
    }

    const salaries = agentMatches.map(r => r[agentSalaryIdx]);
    const salaryInfo = computeSalaryWithDiscount(salaries, Number(discountRate) || 0);

    let statusLabel = 'غير موجود';
    if (inAgent && inMgmt) {
      statusLabel = agentMatches.length > 1 ? 'سحب وكيل راتبين' : 'سحب وكيل';
    } else if (inMgmt) {
      statusLabel = 'سحب ادارة';
    }

    const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
    if (!config?.token) {
      return res.json({ success: false, message: 'لم يتم تسجيل الدخول بـ Google' });
    }
    const credentials = config.credentials ? JSON.parse(config.credentials) : null;
    const clientId = credentials?.client_id || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = credentials?.client_secret || process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.json({ success: false, message: 'بيانات الاعتماد غير متوفرة' });
    }
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      process.env.GOOGLE_REDIRECT_URI ||
        `${process.env.BASE_URL || 'http://localhost:3000'}/sheets/callback`
    );
    oauth2Client.setCredentials(
      typeof config.token === 'string' ? JSON.parse(config.token) : config.token
    );
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    const spreadsheetId = String(cycle.management_spreadsheet_id).trim();
    const targetTitle = String(targetSheetTitle || '').trim();
    if (!targetTitle) {
      return res.json({ success: false, message: 'أدخل اسم الورقة الهدف في جدول الإدارة' });
    }

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheets = meta.data.sheets || [];
    let foundSheet = existingSheets.find(
      s => (s.properties?.title || '') === targetTitle
    );

    if (!foundSheet && !createIfMissing) {
      return res.json({
        success: false,
        message: 'اسم الورقة غير موجود واخترت عدم إنشائها. فعّل خيار الإنشاء أو اختر ورقة أخرى.'
      });
    }

    if (!foundSheet && createIfMissing) {
      const addRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: targetTitle }
              }
            }
          ]
        }
      });
      const replies = addRes.data.replies || [];
      const added = replies[0]?.addSheet?.properties;
      if (!added) {
        return res.json({ success: false, message: 'فشل إنشاء الورقة الجديدة في جدول الإدارة' });
      }
      foundSheet = { properties: added };
    }

    const rangeAll = `'${targetTitle}'!A:ZZ`;
    const current = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: rangeAll
    });
    const existingRows = current.data.values || [];
    const existingIds = new Set();
    existingRows.forEach((row, idx) => {
      if (idx === 0) return;
      const id = normalizeUserId(row[mgmtIdx]);
      if (id) existingIds.add(id);
    });

    const rowsToAppend = [];
    if (mgmtRow) {
      const id = normalizeUserId(mgmtRow[mgmtIdx]);
      if (id && !existingIds.has(id)) {
        rowsToAppend.push(mgmtRow);
      }
    }
    if (!rowsToAppend.length) {
      return res.json({
        success: true,
        message: 'المستخدم موجود مسبقاً في الورقة الهدف. لا حاجة لتكرار الصف.'
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: rangeAll,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rowsToAppend }
    });

    try {
      const after = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: rangeAll
      });
      const totalRows = (after.data.values || []).length;
      const startRowIndex = Math.max(1, totalRows - rowsToAppend.length);
      const sheetId = foundSheet.properties?.sheetId;
      if (sheetId != null) {
        const baseAgent = safeHexColor(agentColor, '#8b5cf6');
        const baseMgmt = safeHexColor(managementColor, '#facc15');
        const color =
          statusLabel === 'سحب ادارة' ? hexToRgb(baseMgmt) : hexToRgb(baseAgent);
        const requests = [];
        for (let i = 0; i < rowsToAppend.length; i++) {
          requests.push({
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: startRowIndex + i,
                endRowIndex: startRowIndex + i + 1,
                startColumnIndex: 0,
                endColumnIndex: 200
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: color
                }
              },
              fields: 'userEnteredFormat.backgroundColor'
            }
          });
        }
        if (requests.length) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests }
          });
        }
      }
    } catch (_) {}

    // تلوين الصفوف الأصلية للمستخدم في أوراق الإدارة والوكيل للدورة نفسها
    try {
      const baseAgent = safeHexColor(agentColor, '#8b5cf6');
      const baseMgmt = safeHexColor(managementColor, '#facc15');
      const mgmtSheetName =
        (cache.managementSheetName && String(cache.managementSheetName).trim()) ||
        (cycle.management_sheet_name && String(cycle.management_sheet_name).trim()) ||
        null;
      const agentSheetName =
        (cache.agentSheetName && String(cache.agentSheetName).trim()) ||
        (cycle.agent_sheet_name && String(cycle.agent_sheet_name).trim()) ||
        null;

      // ورقة الإدارة الأصلية
      if (cycle.management_spreadsheet_id && mgmtSheetName && inMgmt) {
        const mgmtMeta = await sheets.spreadsheets.get({
          spreadsheetId: String(cycle.management_spreadsheet_id).trim()
        });
        const mgmtSheets = mgmtMeta.data.sheets || [];
        const mgmtSheet = mgmtSheets.find(
          s => (s.properties?.title || '') === mgmtSheetName
        );
        if (mgmtSheet && mgmtSheet.properties?.sheetId != null) {
          const mgmtData = await sheets.spreadsheets.values.get({
            spreadsheetId: String(cycle.management_spreadsheet_id).trim(),
            range: `'${mgmtSheetName}'!A:ZZ`
          });
          const rows = mgmtData.data.values || [];
          // منطق التلوين مطابق لأداة تدقيق الرواتب:
          // سحب وكيل / سحب وكيل راتبين → لون وكيل، سحب إدارة فقط → لون إدارة
          const mgmtColorRgb = hexToRgb(
            statusLabel && statusLabel.indexOf('سحب وكيل') === 0 ? baseAgent : baseMgmt
          );
          const requests = [];
          rows.forEach((row, idx) => {
            if (idx === 0) return;
            const id = normalizeUserId(row[mgmtIdx]);
            if (id && id.indexOf(member) !== -1) {
              requests.push({
                repeatCell: {
                  range: {
                    sheetId: mgmtSheet.properties.sheetId,
                    startRowIndex: idx,
                    endRowIndex: idx + 1,
                    startColumnIndex: 0,
                    endColumnIndex: 200
                  },
                  cell: {
                    userEnteredFormat: {
                      backgroundColor: mgmtColorRgb
                    }
                  },
                  fields: 'userEnteredFormat.backgroundColor'
                }
              });
            }
          });
          if (requests.length) {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: String(cycle.management_spreadsheet_id).trim(),
              requestBody: { requests }
            });
          }
        }
      }

      // ورقة الوكيل الأصلية (قد تكون في نفس ملف الإدارة أو ملف مستقل)
      const agentSpreadsheetId =
        cycle.agent_spreadsheet_id || cycle.management_spreadsheet_id;
      if (agentSpreadsheetId && agentSheetName && inAgent) {
        const agentMeta = await sheets.spreadsheets.get({
          spreadsheetId: String(agentSpreadsheetId).trim()
        });
        const agentSheets = agentMeta.data.sheets || [];
        const agentSheet = agentSheets.find(
          s => (s.properties?.title || '') === agentSheetName
        );
        if (agentSheet && agentSheet.properties?.sheetId != null) {
          const agentData = await sheets.spreadsheets.values.get({
            spreadsheetId: String(agentSpreadsheetId).trim(),
            range: `'${agentSheetName}'!A:ZZ`
          });
          const rowsA = agentData.data.values || [];
          const agentColorRgb = hexToRgb(baseAgent);
          const requestsA = [];
          rowsA.forEach((row, idx) => {
            if (idx === 0) return;
            const id = normalizeUserId(row[agentIdx]);
            if (id && id.indexOf(member) !== -1) {
              requestsA.push({
                repeatCell: {
                  range: {
                    sheetId: agentSheet.properties.sheetId,
                    startRowIndex: idx,
                    endRowIndex: idx + 1,
                    startColumnIndex: 0,
                    endColumnIndex: 200
                  },
                  cell: {
                    userEnteredFormat: {
                      backgroundColor: agentColorRgb
                    }
                  },
                  fields: 'userEnteredFormat.backgroundColor'
                }
              });
            }
          });
          if (requestsA.length) {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: String(agentSpreadsheetId).trim(),
              requestBody: { requests: requestsA }
            });
          }
        }
      }
    } catch (colorErr) {
      console.error('[search execute-audit-advanced] coloring original rows failed', colorErr.message);
    }

    const auditedAgentIds = cache.auditedAgentIds || new Set();
    const auditedMgmtIds = cache.auditedMgmtIds || new Set();
    if (inAgent) auditedAgentIds.add(member);
    if (inMgmt) auditedMgmtIds.add(member);

    await saveUserAuditStatus(
      req.session.userId,
      cycleIdNum,
      member,
      'مدقق',
      'تدقيق من أداة البحث',
      {
        statusLabel,
        targetSheetTitle: targetTitle,
        salaryBefore: salaryInfo.before,
        salaryAfter: salaryInfo.after
      }
    );

    await saveCycleCache(req.session.userId, cycleIdNum, {
      managementData: cache.managementData,
      agentData: cache.agentData,
      managementSheetName: cache.managementSheetName,
      agentSheetName: cache.agentSheetName,
      auditedAgentIds,
      auditedMgmtIds,
      foundInTargetSheetIds: cache.foundInTargetSheetIds || new Set([member]),
      staleAfter: cache.staleAfter || null
    });

    res.json({
      success: true,
      message: 'تم تنفيذ التدقيق الانتقائي في جدول الإدارة وتحديث حالة البحث',
      statusLabel,
      salaryBefore: salaryInfo.before,
      salaryAfter: salaryInfo.after
    });
  } catch (e) {
    res.json({
      success: false,
      message: e.message || 'فشل تنفيذ التدقيق الانتقائي من أداة البحث'
    });
  }
});

/** سجل رواتب المؤجل لرقم مستخدم (جميع الدورات) */
router.get('/member-deferred-history', requireAuth, async (req, res) => {
  try {
    const memberUserId = req.query.memberUserId || req.query.member_user_id;
    if (!memberUserId || !String(memberUserId).trim()) {
      return res.json({ success: false, message: 'رقم المستخدم مطلوب', lines: [] });
    }
    const db = getDb();
    const lines = await getMemberDeferredHistory(db, req.session.userId, memberUserId);
    const total = lines.reduce((s, r) => s + (parseFloat(r.balance_d) || 0), 0);
    res.json({
      success: true,
      lines,
      totalDeferred: Math.round(total * 100) / 100,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', lines: [] });
  }
});

module.exports = router;