/**
 * تدقيق الرواتب المحلي — دورات مرفوعة (إدارة / وكيل / معلومات المستخدمين)، تدقيق على السيرفر، تصدير إلى Google.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { google } = require('googleapis');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { runPayrollAuditCore } = require('../services/payrollAuditEngine');
const { normalizeUserId } = require('../services/payrollSearchService');
const { withSheetsRetry } = require('../services/googleSheetsReadHelpers');

const router = express.Router();

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:3000'}/sheets/callback`;
const EXPORT_SUFFIX = ' LorkERP';

const uploadsDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 25 * 1024 * 1024 },
});

function getOAuth2Client(credentials) {
  const clientId = credentials?.client_id || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = credentials?.client_secret || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

function emptyWorkbook() {
  return { sheets: [{ name: 'ورقة1', rows: [['']] }] };
}

function parseExcelFileToWorkbook(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheets = wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false }),
  }));
  return { sheets: sheets.length ? sheets : emptyWorkbook().sheets };
}

function parseWorkbookJson(text) {
  try {
    const w = JSON.parse(text);
    if (w && Array.isArray(w.sheets) && w.sheets.length) return w;
  } catch (_) {}
  return emptyWorkbook();
}

function flattenWorkbookRows(workbook) {
  const sheets = workbook?.sheets || [];
  const rows = [];
  for (const s of sheets) {
    for (const r of s.rows || []) rows.push(r);
  }
  return rows;
}

function getUserInfoRowsFromWorkbook(workbook, sheetIndex) {
  const sheets = workbook?.sheets || [];
  if (!sheets.length) return [];
  const idx = Math.min(Math.max(0, parseInt(String(sheetIndex), 10) || 0), sheets.length - 1);
  return sheets[idx].rows || [];
}

function escapeSheetTitleForRange(title) {
  return String(title).replace(/'/g, "''");
}

function sheetExportTitle(originalName) {
  const base = String(originalName || 'ورقة').trim();
  const suf = EXPORT_SUFFIX.trim();
  const withSuffix = base.endsWith(suf) ? base : `${base}${EXPORT_SUFFIX}`;
  return withSuffix.slice(0, 100);
}

async function getGoogleSheetsApi() {
  const db = getDb();
  const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
  if (!config?.token) throw new Error('لم يتم ربط حساب Google من الإعدادات');
  const credentials = config.credentials ? JSON.parse(config.credentials) : null;
  const oauth2Client = getOAuth2Client(credentials);
  if (!oauth2Client) throw new Error('بيانات اعتماد Google غير مكتملة');
  oauth2Client.setCredentials(typeof config.token === 'string' ? JSON.parse(config.token) : config.token);
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

async function exportWorkbookToGoogleSheets(sheetsApi, spreadsheetTitle, workbook) {
  const sheets = workbook?.sheets || [];
  if (!sheets.length) throw new Error('لا توجد أوراق للتصدير');

  const exportSheets = sheets.map((s) => ({
    rows: Array.isArray(s.rows) ? s.rows : [],
    exportTitle: sheetExportTitle(s.name),
  }));

  const createRes = await withSheetsRetry(() =>
    sheetsApi.spreadsheets.create({
      requestBody: {
        properties: { title: String(spreadsheetTitle).slice(0, 100) },
        sheets: exportSheets.map((s) => ({
          properties: { title: s.exportTitle },
        })),
      },
    })
  );

  const spreadsheetId = createRes.data.spreadsheetId;
  const meta = await withSheetsRetry(() => sheetsApi.spreadsheets.get({ spreadsheetId }));
  const titles = (meta.data.sheets || []).map((sh) => sh.properties.title);

  const data = [];
  for (let i = 0; i < exportSheets.length; i++) {
    const title = titles[i] || exportSheets[i].exportTitle;
    const range = `'${escapeSheetTitleForRange(title)}'!A1`;
    data.push({ range, values: exportSheets[i].rows.length ? exportSheets[i].rows : [['']] });
  }

  await withSheetsRetry(() =>
    sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data,
      },
    })
  );

  return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` };
}

async function upsertNativeSettings(userId, nativeCycleId, cols) {
  const db = getDb();
  await db.query(
    `INSERT INTO payroll_native_settings (
       user_id, native_cycle_id,
       mgmt_user_id_col, agent_user_id_col, agent_salary_col,
       user_info_user_id_col, user_info_title_col, user_info_salary_col,
       user_info_sheet_index, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, native_cycle_id) DO UPDATE SET
       mgmt_user_id_col = excluded.mgmt_user_id_col,
       agent_user_id_col = excluded.agent_user_id_col,
       agent_salary_col = excluded.agent_salary_col,
       user_info_user_id_col = excluded.user_info_user_id_col,
       user_info_title_col = excluded.user_info_title_col,
       user_info_salary_col = excluded.user_info_salary_col,
       user_info_sheet_index = excluded.user_info_sheet_index,
       updated_at = CURRENT_TIMESTAMP`,
    [
      userId,
      nativeCycleId,
      cols.mgmt_user_id_col || 'A',
      cols.agent_user_id_col || 'A',
      cols.agent_salary_col || 'D',
      cols.user_info_user_id_col || 'C',
      cols.user_info_title_col || 'D',
      cols.user_info_salary_col || 'L',
      Number(cols.user_info_sheet_index) || 0,
    ]
  );
}

async function loadCycleOr404(userId, id) {
  const db = getDb();
  const cycle = (
    await db.query('SELECT id, name, created_at, updated_at FROM payroll_native_cycles WHERE id = $1 AND user_id = $2', [id, userId])
  ).rows[0];
  return cycle || null;
}

router.get('/cycles', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (
      await db.query(
        `SELECT id, name, created_at, updated_at FROM payroll_native_cycles
         WHERE user_id = $1 ORDER BY updated_at DESC`,
        [req.session.userId]
      )
    ).rows;
    res.json({ success: true, cycles: rows });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

router.get('/cycles/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = getDb();
    const cycle = (
      await db.query('SELECT id, name, created_at, updated_at FROM payroll_native_cycles WHERE id = $1 AND user_id = $2', [
        id,
        req.session.userId,
      ])
    ).rows[0];
    if (!cycle) return res.json({ success: false, message: 'الدورة غير موجودة' });

    const mgmt = (
      await db.query('SELECT sheets_json FROM payroll_native_management_workbook WHERE cycle_id = $1', [id])
    ).rows[0];
    const ag = (await db.query('SELECT sheets_json FROM payroll_native_agent_workbook WHERE cycle_id = $1', [id])).rows[0];
    const ui = (await db.query('SELECT sheets_json FROM payroll_native_userinfo_workbook WHERE cycle_id = $1', [id])).rows[0];
    const settings = (
      await db.query(
        `SELECT mgmt_user_id_col, agent_user_id_col, agent_salary_col,
                user_info_user_id_col, user_info_title_col, user_info_salary_col, user_info_sheet_index
           FROM payroll_native_settings WHERE user_id = $1 AND native_cycle_id = $2`,
        [req.session.userId, id]
      )
    ).rows[0];

    res.json({
      success: true,
      cycle,
      management: mgmt ? parseWorkbookJson(mgmt.sheets_json) : emptyWorkbook(),
      agent: ag ? parseWorkbookJson(ag.sheets_json) : emptyWorkbook(),
      userInfo: ui ? parseWorkbookJson(ui.sheets_json) : emptyWorkbook(),
      settings: settings || {
        mgmt_user_id_col: 'A',
        agent_user_id_col: 'A',
        agent_salary_col: 'D',
        user_info_user_id_col: 'C',
        user_info_title_col: 'D',
        user_info_salary_col: 'L',
        user_info_sheet_index: 0,
      },
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

router.post('/cycles', requireAuth, upload.fields([{ name: 'management' }, { name: 'agent' }, { name: 'userInfo' }]), async (req, res) => {
  try {
    const name = (req.body.name && String(req.body.name).trim()) || `دورة ${new Date().toISOString().slice(0, 10)}`;
    const db = getDb();

    let managementWb = emptyWorkbook();
    let agentWb = emptyWorkbook();
    let userInfoWb = emptyWorkbook();

    const files = req.files || {};
    if (files.management?.[0]) {
      managementWb = parseExcelFileToWorkbook(files.management[0].path);
      try {
        fs.unlinkSync(files.management[0].path);
      } catch (_) {}
    }
    if (files.agent?.[0]) {
      agentWb = parseExcelFileToWorkbook(files.agent[0].path);
      try {
        fs.unlinkSync(files.agent[0].path);
      } catch (_) {}
    }
    if (files.userInfo?.[0]) {
      userInfoWb = parseExcelFileToWorkbook(files.userInfo[0].path);
      try {
        fs.unlinkSync(files.userInfo[0].path);
      } catch (_) {}
    }

    const ins = await db.query(
      'INSERT INTO payroll_native_cycles (user_id, name, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING id',
      [req.session.userId, name]
    );
    const cycleId = ins.rows[0].id;

    await db.query(
      'INSERT INTO payroll_native_management_workbook (cycle_id, sheets_json) VALUES ($1, $2)',
      [cycleId, JSON.stringify(managementWb)]
    );
    await db.query('INSERT INTO payroll_native_agent_workbook (cycle_id, sheets_json) VALUES ($1, $2)', [cycleId, JSON.stringify(agentWb)]);
    await db.query('INSERT INTO payroll_native_userinfo_workbook (cycle_id, sheets_json) VALUES ($1, $2)', [
      cycleId,
      JSON.stringify(userInfoWb),
    ]);

    await upsertNativeSettings(req.session.userId, cycleId, {});

    res.json({ success: true, cycleId, message: 'تم إنشاء الدورة' });
  } catch (e) {
    console.error('[payroll-native] create', e);
    res.json({ success: false, message: e.message || 'فشل الإنشاء' });
  }
});

router.put('/cycles/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const name = req.body.name != null ? String(req.body.name).trim() : '';
    if (!name) return res.json({ success: false, message: 'اسم الدورة مطلوب' });
    const db = getDb();
    const r = await db.query(
      'UPDATE payroll_native_cycles SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3 RETURNING id',
      [name, id, req.session.userId]
    );
    if (!r.rows.length) return res.json({ success: false, message: 'الدورة غير موجودة' });
    res.json({ success: true, message: 'تم حفظ الاسم' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

router.put('/cycles/:id/workbooks', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await loadCycleOr404(req.session.userId, id))) return res.json({ success: false, message: 'الدورة غير موجودة' });

    const { management, agent, userInfo, settings } = req.body || {};
    const db = getDb();

    if (management && typeof management === 'object') {
      await db.query('UPDATE payroll_native_management_workbook SET sheets_json = $1 WHERE cycle_id = $2', [
        JSON.stringify(management),
        id,
      ]);
    }
    if (agent && typeof agent === 'object') {
      await db.query('UPDATE payroll_native_agent_workbook SET sheets_json = $1 WHERE cycle_id = $2', [JSON.stringify(agent), id]);
    }
    if (userInfo && typeof userInfo === 'object') {
      await db.query('UPDATE payroll_native_userinfo_workbook SET sheets_json = $1 WHERE cycle_id = $2', [JSON.stringify(userInfo), id]);
    }
    if (settings && typeof settings === 'object') {
      await upsertNativeSettings(req.session.userId, id, settings);
    }

    await db.query('UPDATE payroll_native_cycles SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
    res.json({ success: true, message: 'تم الحفظ' });
  } catch (e) {
    console.error('[payroll-native] workbooks', e);
    res.json({ success: false, message: e.message || 'فشل الحفظ' });
  }
});

router.delete('/cycles/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = getDb();
    const r = await db.query('DELETE FROM payroll_native_cycles WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.session.userId]);
    if (!r.rows.length) return res.json({ success: false, message: 'الدورة غير موجودة' });
    res.json({ success: true, message: 'تم حذف الدورة' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

/** استبدال ملف إدارة أو وكيل أو معلومات مستخدمين من Excel */
router.post('/cycles/:id/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await loadCycleOr404(req.session.userId, id))) return res.json({ success: false, message: 'الدورة غير موجودة' });
    const kind = String(req.body.kind || '').trim();
    if (!['management', 'agent', 'userInfo'].includes(kind)) {
      return res.json({ success: false, message: 'نوع الملف غير صالح (management / agent / userInfo)' });
    }
    if (!req.file?.path) return res.json({ success: false, message: 'لم يُرفع ملف' });

    const wb = parseExcelFileToWorkbook(req.file.path);
    try {
      fs.unlinkSync(req.file.path);
    } catch (_) {}

    const db = getDb();
    const table =
      kind === 'management'
        ? 'payroll_native_management_workbook'
        : kind === 'agent'
          ? 'payroll_native_agent_workbook'
          : 'payroll_native_userinfo_workbook';
    await db.query(`UPDATE ${table} SET sheets_json = $1 WHERE cycle_id = $2`, [JSON.stringify(wb), id]);
    await db.query('UPDATE payroll_native_cycles SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

    res.json({ success: true, message: 'تم استبدال الجدول', workbook: wb });
  } catch (e) {
    console.error('[payroll-native] upload', e);
    res.json({ success: false, message: e.message || 'فشل الرفع' });
  }
});

router.post('/cycles/:id/audit', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cycle = await loadCycleOr404(req.session.userId, id);
    if (!cycle) return res.json({ success: false, message: 'الدورة غير موجودة' });

    const db = getDb();
    const mgmt = (
      await db.query('SELECT sheets_json FROM payroll_native_management_workbook WHERE cycle_id = $1', [id])
    ).rows[0];
    const ag = (await db.query('SELECT sheets_json FROM payroll_native_agent_workbook WHERE cycle_id = $1', [id])).rows[0];
    const ui = (await db.query('SELECT sheets_json FROM payroll_native_userinfo_workbook WHERE cycle_id = $1', [id])).rows[0];
    let settings = (
      await db.query(
        `SELECT mgmt_user_id_col, agent_user_id_col, agent_salary_col,
                user_info_user_id_col, user_info_title_col, user_info_salary_col, user_info_sheet_index
           FROM payroll_native_settings WHERE user_id = $1 AND native_cycle_id = $2`,
        [req.session.userId, id]
      )
    ).rows[0];
    if (!settings) settings = {};

    const body = req.body || {};
    const discountRatePct =
      body.discountRate != null ? Number(body.discountRate) : (await db.query('SELECT discount_rate FROM payroll_settings WHERE user_id = $1', [req.session.userId])).rows[0]?.discount_rate ?? 0;
    const agentColor =
      body.agentColor || (await db.query('SELECT agent_color FROM payroll_settings WHERE user_id = $1', [req.session.userId])).rows[0]?.agent_color || '#3b82f6';
    const managementColor =
      body.managementColor ||
      (await db.query('SELECT management_color FROM payroll_settings WHERE user_id = $1', [req.session.userId])).rows[0]?.management_color ||
      '#10b981';

    const cols = {
      userInfoUserIdCol: body.userInfoUserIdCol || settings.user_info_user_id_col || 'C',
      userInfoTitleCol: body.userInfoTitleCol || settings.user_info_title_col || 'D',
      userInfoSalaryCol: body.userInfoSalaryCol || settings.user_info_salary_col || 'L',
      cycleMgmtUserIdCol: body.cycleMgmtUserIdCol || settings.mgmt_user_id_col || 'A',
      cycleAgentUserIdCol: body.cycleAgentUserIdCol || settings.agent_user_id_col || 'A',
      cycleAgentSalaryCol: body.cycleAgentSalaryCol || settings.agent_salary_col || 'D',
    };
    const userInfoSheetIndex = body.userInfoSheetIndex != null ? Number(body.userInfoSheetIndex) : settings.user_info_sheet_index ?? 0;

    const managementWb = mgmt ? parseWorkbookJson(mgmt.sheets_json) : emptyWorkbook();
    const agentWb = ag ? parseWorkbookJson(ag.sheets_json) : emptyWorkbook();
    const userInfoWb = ui ? parseWorkbookJson(ui.sheets_json) : emptyWorkbook();

    const managementRows = flattenWorkbookRows(managementWb);
    const agentRows = flattenWorkbookRows(agentWb);
    const userInfoRows = getUserInfoRowsFromWorkbook(userInfoWb, userInfoSheetIndex);

    if (!userInfoRows.length) {
      return res.json({ success: false, message: 'ورقة معلومات المستخدمين فارغة. أضف بيانات أو اختر ورقة أخرى في الإعدادات.' });
    }
    if (!managementRows.length && !agentRows.length) {
      return res.json({ success: false, message: 'جداول الإدارة والوكيل فارغة.' });
    }

    const auditOut = runPayrollAuditCore({
      managementRows,
      agentRows,
      userInfoRows,
      columns: cols,
      discountRatePct,
      agentColor,
      managementColor,
    });

    const { results, summary, dataRows, diagnosticContext, agentColorVal, mgmtColorVal } = auditOut;
    const { COL_C } = auditOut.meta;
    const cycleMgmtCol = diagnosticContext.cycleMgmtCol;
    const cycleAgentCol = diagnosticContext.cycleAgentCol;
    const mgmtDataRows = diagnosticContext.mgmtDataRows;
    const agentDataRows = diagnosticContext.agentDataRows;
    const mgmtByUserId = diagnosticContext.mgmtByUserId;
    const agentByUserId = diagnosticContext.agentByUserId;

    const appliedCount = summary.agent + summary.management;
    let message = 'تم التدقيق داخل النظام';
    if (summary.total === 0) message = 'لم تُقرأ صفوف من معلومات المستخدمين.';
    else if (appliedCount === 0) message = 'لم يُطابق أي صف. راجع أعمدة التدقيق.';

    let sampleUserIds = [];
    let sampleMgmtIds = [];
    let sampleAgentIds = [];
    let diagnostic = null;
    if (appliedCount === 0 && summary.total > 0) {
      const seen = new Set();
      for (const r of dataRows) {
        const uid = normalizeUserId(r[COL_C]);
        if (uid && !seen.has(uid)) {
          seen.add(uid);
          sampleUserIds.push(uid);
          if (sampleUserIds.length >= 12) break;
        }
      }
      seen.clear();
      for (const row of mgmtDataRows) {
        const uid = normalizeUserId(row[cycleMgmtCol]);
        if (uid && !seen.has(uid)) {
          seen.add(uid);
          sampleMgmtIds.push(uid);
          if (sampleMgmtIds.length >= 12) break;
        }
      }
      seen.clear();
      for (const row of agentDataRows) {
        const uid = normalizeUserId(row[cycleAgentCol]);
        if (uid && !seen.has(uid)) {
          seen.add(uid);
          sampleAgentIds.push(uid);
          if (sampleAgentIds.length >= 12) break;
        }
      }
      const mgmtUnique = Object.keys(mgmtByUserId).length;
      const agentUnique = Object.keys(agentByUserId).length;
      const sampleCheck = sampleUserIds.slice(0, 5).map((uid) => ({
        userId: uid,
        inMgmt: !!mgmtByUserId[uid],
        inAgent: !!agentByUserId[uid],
      }));
      diagnostic = {
        managementUniqueCount: mgmtUnique,
        agentUniqueCount: agentUnique,
        userInfoUniqueCount: [...new Set(results.map((r) => r.userId).filter(Boolean))].length,
        sampleCheck,
      };
    }

    await db.query('DELETE FROM payroll_native_user_audit WHERE user_id = $1 AND native_cycle_id = $2', [req.session.userId, id]);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.userId && (r.type.startsWith('سحب وكالة') || r.type === 'سحب إدارة')) {
        const src = r.type.startsWith('سحب وكالة') ? 'تدقيق وكيل (محلي)' : 'تدقيق إدارة (محلي)';
        const colorHint = r.type.startsWith('سحب وكالة') ? agentColorVal : mgmtColorVal;
        await db.query(
          `INSERT INTO payroll_native_user_audit (user_id, native_cycle_id, member_user_id, audit_status, audit_source, details_json, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
          [
            req.session.userId,
            id,
            String(r.userId),
            'مدقق',
            src,
            JSON.stringify({
              type: r.type,
              title: r.title,
              color: colorHint,
              nativeWorkbench: true,
            }),
          ]
        );
      }
    }

    await db.query('UPDATE payroll_native_cycles SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

    const resultsForClient = results.map((r) => ({
      userId: r.userId,
      title: r.title,
      type: r.type,
      rowIndex: r.rowIndex,
      color:
        r.type.startsWith('سحب وكالة') ? agentColorVal : r.type === 'سحب إدارة' ? mgmtColorVal : null,
    }));

    res.json({
      success: true,
      message,
      summary,
      applied: appliedCount > 0,
      localOnly: true,
      nativeWorkbench: true,
      agentColorVal,
      mgmtColorVal,
      results: resultsForClient,
      sampleUserIds: sampleUserIds.length ? sampleUserIds : undefined,
      sampleMgmtIds: sampleMgmtIds.length ? sampleMgmtIds : undefined,
      sampleAgentIds: sampleAgentIds.length ? sampleAgentIds : undefined,
      diagnostic,
    });
  } catch (e) {
    console.error('[payroll-native] audit', e);
    res.json({ success: false, message: e.message || 'فشل التدقيق' });
  }
});

router.post('/cycles/:id/export/:kind', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cycle = await loadCycleOr404(req.session.userId, id);
    if (!cycle) return res.json({ success: false, message: 'الدورة غير موجودة' });
    const kind = String(req.params.kind || '').trim();
    if (!['management', 'agent', 'userInfo'].includes(kind)) {
      return res.json({ success: false, message: 'نوع التصدير غير صالح' });
    }

    const db = getDb();
    let workbook;
    let titlePrefix;
    if (kind === 'management') {
      const row = (await db.query('SELECT sheets_json FROM payroll_native_management_workbook WHERE cycle_id = $1', [id])).rows[0];
      workbook = row ? parseWorkbookJson(row.sheets_json) : emptyWorkbook();
      titlePrefix = `${cycle.name} — إدارة`;
    } else if (kind === 'agent') {
      const row = (await db.query('SELECT sheets_json FROM payroll_native_agent_workbook WHERE cycle_id = $1', [id])).rows[0];
      workbook = row ? parseWorkbookJson(row.sheets_json) : emptyWorkbook();
      titlePrefix = `${cycle.name} — وكيل`;
    } else {
      const row = (await db.query('SELECT sheets_json FROM payroll_native_userinfo_workbook WHERE cycle_id = $1', [id])).rows[0];
      workbook = row ? parseWorkbookJson(row.sheets_json) : emptyWorkbook();
      titlePrefix = `${cycle.name} — معلومات المستخدمين`;
    }

    const sheetsApi = await getGoogleSheetsApi();
    const out = await exportWorkbookToGoogleSheets(sheetsApi, `${titlePrefix} LorkERP`.slice(0, 100), workbook);
    res.json({ success: true, spreadsheetId: out.spreadsheetId, url: out.url, message: 'تم إنشاء الجدول في Google Drive' });
  } catch (e) {
    console.error('[payroll-native] export', e);
    res.json({ success: false, message: e.message || 'فشل التصدير' });
  }
});

module.exports = router;
