const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { google } = require('googleapis');
const { syncAgenciesFromManagementTable, fetchDeferredBalanceUsers, calculateCashBoxBalance } = require('../services/agencySyncService');
const { ensurePrimaryAccreditationAfterCycleCreate } = require('../services/accreditationCycleService');
const {
  fetchSheetValuesBatched,
  withSheetsRetry,
  batchUpdateRequestsInChunks,
  sleep,
} = require('../services/googleSheetsReadHelpers');
const { runPayrollAuditCore } = require('../services/payrollAuditEngine');
const { normalizeUserId } = require('../services/payrollSearchService');

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:3000'}/sheets/callback`;

/** بصمة محتوى جدول معلومات المستخدمين (تجنّب إعادة تدقيق بلا تغيير) */
function hashUserInfoRows(rows) {
  if (!rows || !Array.isArray(rows)) return '';
  const normalized = rows.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => (cell == null ? '' : String(cell)))
  );
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** من نطاق Google مثل 'ورقة'!A7:ZZ9 → فهرس الصف الأول بدءًا من 0 */
function parseRangeStartRowIndex0(updatedRange) {
  const s = String(updatedRange || '');
  const m = s.match(/![A-Za-z]+(\d+)/);
  if (!m) return 0;
  return Math.max(0, parseInt(m[1], 10) - 1);
}

function getOAuth2Client(credentials) {
  const clientId = credentials?.client_id || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = credentials?.client_secret || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

/** قراءة ورقة من Google Sheets وإرجاع صفوف */
async function readSheetFromGoogle(spreadsheetId, sheetName, credentials, token) {
  const oauth2Client = getOAuth2Client(credentials);
  if (!oauth2Client) throw new Error('بيانات الاعتماد غير متوفرة');
  oauth2Client.setCredentials(typeof token === 'string' ? JSON.parse(token) : token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const result = await fetchSheetWithFallback(sheets, spreadsheetId, sheetName && String(sheetName).trim() ? String(sheetName).trim() : null);
  return result.values;
}

const uploadsDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 15 * 1024 * 1024 }
});

function parseUploadedFile(filePath, mimetype) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const ext = path.extname(filePath).toLowerCase();
  let rows = [];
  try {
    if (ext === '.csv' || mimetype === 'text/csv') {
      const buf = fs.readFileSync(filePath, 'utf8');
      const lines = buf.split(/\r?\n/).filter(l => l.trim());
      rows = lines.map(line => {
        const out = [];
        let cell = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (c === '"') {
            inQuotes = !inQuotes;
          } else if ((c === ',' && !inQuotes) || c === '\t') {
            out.push(cell.trim());
            cell = '';
          } else {
            cell += c;
          }
        }
        out.push(cell.trim());
        return out;
      });
    } else {
      const wb = XLSX.readFile(filePath, { cellDates: true });
      const firstSheet = wb.SheetNames[0];
      const ws = wb.Sheets[firstSheet];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    }
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
  return rows;
}

/** قائمة جداول المستخدم من Google Drive (مزامنة) */
router.get('/spreadsheets-list', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
    if (!config?.token) {
      return res.json({ success: false, message: 'لم يتم تسجيل الدخول بـ Google. اربط من الإعدادات → Google Sheets.' });
    }
    const credentials = config.credentials ? JSON.parse(config.credentials) : null;
    const oauth2Client = getOAuth2Client(credentials);
    if (!oauth2Client) return res.json({ success: false, message: 'بيانات الاعتماد غير متوفرة' });
    oauth2Client.setCredentials(typeof config.token === 'string' ? JSON.parse(config.token) : config.token);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      pageSize: 200,
      fields: 'files(id, name)',
      orderBy: 'modifiedTime desc'
    });
    const files = (response.data.files || []).map(f => ({ id: f.id, name: f.name || f.id }));
    res.json({ success: true, spreadsheets: files });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب قائمة الجداول' });
  }
});

/** قائمة أوراق جدول معيّن (لاستخدامه عند اختيار جدول الإدارة أو الوكيل) */
router.get('/spreadsheet-sheets', requireAuth, async (req, res) => {
  try {
    const spreadsheetId = req.query.spreadsheetId;
    if (!spreadsheetId) return res.json({ success: false, message: 'معرّف الجدول مطلوب' });
    const db = getDb();
    const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
    if (!config?.token) return res.json({ success: false, message: 'لم يتم تسجيل الدخول بـ Google' });
    const credentials = config.credentials ? JSON.parse(config.credentials) : null;
    const oauth2Client = getOAuth2Client(credentials);
    if (!oauth2Client) return res.json({ success: false, message: 'بيانات الاعتماد غير متوفرة' });
    oauth2Client.setCredentials(typeof config.token === 'string' ? JSON.parse(config.token) : config.token);
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const list = (meta.data.sheets || []).map(s => ({ id: s.properties.sheetId, title: s.properties.title }));
    res.json({ success: true, sheets: list });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الأوراق' });
  }
});

/** قائمة الدورات المالية للمستخدم */
router.get('/cycles', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query(
      'SELECT id, name, created_at, updated_at, management_spreadsheet_id, management_sheet_name, agent_spreadsheet_id, agent_sheet_name, transfer_discount_pct FROM financial_cycles WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.userId]
    )).rows;
    res.json({ success: true, cycles: rows });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

/** جلب دورة واحدة (للتعديل) */
router.get('/cycles/:id', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const row = (await db.query(
      'SELECT id, name, management_spreadsheet_id, management_sheet_name, agent_spreadsheet_id, agent_sheet_name, transfer_discount_pct, created_at, updated_at FROM financial_cycles WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    )).rows[0];
    if (!row) return res.json({ success: false, message: 'الدورة غير موجودة' });
    res.json({ success: true, cycle: row });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

/** تحديث دورة مالية */
router.put('/cycles/:id', requireAuth, async (req, res) => {
  try {
    const cycleId = req.params.id;
    const {
      name,
      managementData,
      agentData,
      managementSpreadsheetId,
      managementSheetName,
      agentSpreadsheetId,
      agentSheetName,
      transferDiscountPct
    } = req.body;
    if (!req.session?.userId) {
      return res.status(401).json({ success: false, message: 'انتهت الجلسة. سجّل دخولك مجدداً.' });
    }
    const db = getDb();
    const existing = (await db.query('SELECT id FROM financial_cycles WHERE id = $1 AND user_id = $2', [cycleId, req.session.userId])).rows[0];
    if (!existing) return res.json({ success: false, message: 'الدورة غير موجودة' });

    const mgmtSs = managementSpreadsheetId ? String(managementSpreadsheetId).trim() : null;
    const mgmtSn = managementSheetName ? String(managementSheetName).trim() : null;
    const agentSs = agentSpreadsheetId ? String(agentSpreadsheetId).trim() : null;
    const agentSn = agentSheetName ? String(agentSheetName).trim() : null;

    let managementJson = managementData != null ? JSON.stringify(managementData) : null;
    let agentJson = agentData != null ? JSON.stringify(agentData) : null;

    if (mgmtSs && agentSs && (!managementJson || !agentJson)) {
      const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
      if (config?.token) {
        const credentials = config.credentials ? JSON.parse(config.credentials) : null;
        const managementRows = await readSheetFromGoogle(mgmtSs, mgmtSn, credentials, config.token);
        const agentRows = await readSheetFromGoogle(agentSs, agentSn, credentials, config.token);
        managementJson = managementRows ? JSON.stringify(managementRows) : null;
        agentJson = agentRows ? JSON.stringify(agentRows) : null;
      }
    }

    const updates = [];
    const params = [];
    let idx = 1;
    if (name != null) {
      updates.push(`name = $${idx++}`);
      params.push(String(name).trim());
    }
    if (managementJson != null) {
      updates.push(`management_data = $${idx++}`);
      params.push(managementJson);
    }
    if (agentJson != null) {
      updates.push(`agent_data = $${idx++}`);
      params.push(agentJson);
    }
    if (managementSpreadsheetId !== undefined) {
      updates.push(`management_spreadsheet_id = $${idx++}`);
      params.push(mgmtSs);
    }
    if (managementSheetName !== undefined) {
      updates.push(`management_sheet_name = $${idx++}`);
      params.push(mgmtSn);
    }
    if (agentSpreadsheetId !== undefined) {
      updates.push(`agent_spreadsheet_id = $${idx++}`);
      params.push(agentSs);
    }
    if (agentSheetName !== undefined) {
      updates.push(`agent_sheet_name = $${idx++}`);
      params.push(agentSn);
    }
    if (transferDiscountPct !== undefined && transferDiscountPct !== null) {
      const tdp = !isNaN(parseFloat(transferDiscountPct))
        ? Math.max(0, Math.min(100, parseFloat(transferDiscountPct)))
        : 0;
      updates.push(`transfer_discount_pct = $${idx++}`);
      params.push(tdp);
    }
    if (updates.length === 0) return res.json({ success: false, message: 'لا توجد بيانات للتحديث' });
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(cycleId, req.session.userId);
    await db.query(
      `UPDATE financial_cycles SET ${updates.join(', ')} WHERE id = $${idx} AND user_id = $${idx + 1}`,
      params
    );
    res.json({ success: true, message: 'تم تحديث الدورة' });
  } catch (e) {
    console.error('[LorkERP] Cycle update error:', e.message);
    res.json({ success: false, message: e.message || 'فشل تحديث الدورة' });
  }
});

/** حذف دورة مالية */
router.delete('/cycles/:id', requireAuth, async (req, res) => {
  try {
    const cycleId = req.params.id;
    const db = getDb();
    const r = await db.query('DELETE FROM financial_cycles WHERE id = $1 AND user_id = $2 RETURNING id', [cycleId, req.session.userId]);
    if (!r.rows || r.rows.length === 0) return res.json({ success: false, message: 'الدورة غير موجودة' });
    res.json({ success: true, message: 'تم حذف الدورة' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الحذف' });
  }
});

/** بنية دورة مالية (عدد الأعمدة + مراجع Google لملء قوائم الأعمدة من الأوراق الفعلية) */
router.get('/cycles/:id/structure', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const row = (await db.query(
      'SELECT id, name, management_data, agent_data, management_spreadsheet_id, management_sheet_name, agent_spreadsheet_id, agent_sheet_name FROM financial_cycles WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    )).rows[0];
    if (!row) return res.json({ success: false, message: 'الدورة غير موجودة' });
    const mgmt = row.management_data ? JSON.parse(row.management_data) : [];
    const agent = row.agent_data ? JSON.parse(row.agent_data) : [];
    const managementColumns = Math.max(26, mgmt[0] ? mgmt[0].length : 26);
    const agentColumns = Math.max(26, agent[0] ? agent[0].length : 26);
    res.json({
      success: true,
      managementColumns,
      agentColumns,
      managementSpreadsheetId: row.management_spreadsheet_id ? String(row.management_spreadsheet_id).trim() : null,
      managementSheetName: row.management_sheet_name ? String(row.management_sheet_name).trim() : null,
      agentSpreadsheetId: row.agent_spreadsheet_id ? String(row.agent_spreadsheet_id).trim() : null,
      agentSheetName: row.agent_sheet_name ? String(row.agent_sheet_name).trim() : null
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

/** جلب بيانات ورقة من جدول Google مع استبدال ورقة بديلة إن فشل الاسم أو كانت فارغة.
 *  excludeSheetTitle: إن وُجد (نفس الملف للوكيل بعد الإدارة) نستبعد هذه الورقة من المحاولة. */
async function fetchSheetWithFallback(sheets, spreadsheetId, preferredSheetName, excludeSheetTitle) {
  const meta = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId }));
  const sheetList = meta.data.sheets || [];
  const titles = sheetList.map(s => (s.properties && s.properties.title) || '').filter(Boolean);
  if (!titles.length) return { values: [], sheetTitleUsed: null };

  const preferred = preferredSheetName && String(preferredSheetName).trim();
  const exclude = excludeSheetTitle && String(excludeSheetTitle).trim();
  const toTry = [];
  if (preferred && preferred !== exclude) toTry.push(preferred);
  for (const t of titles) {
    if (t && t !== exclude && !toTry.includes(t)) toTry.push(t);
  }
  if (!toTry.length && titles[0]) toTry.push(titles[0]);

  let best = { values: [], sheetTitleUsed: null };
  for (const title of toTry) {
    try {
      const values = await fetchSheetValuesBatched(sheets, spreadsheetId, title);
      if (values.length > best.values.length) best = { values, sheetTitleUsed: title };
      if (values.length > 0 && preferred && title === preferred) return { values, sheetTitleUsed: title };
    } catch (_) { /* جرب الورقة التالية */ }
  }
  if (best.values.length > 0) return best;
  if (toTry[0]) {
    try {
      const values = await fetchSheetValuesBatched(sheets, spreadsheetId, toTry[0]);
      return { values, sheetTitleUsed: toTry[0] };
    } catch (_) {}
  }
  return { values: [], sheetTitleUsed: toTry[0] || null };
}

/** مزامنة جداول الدورة المالية من Google (جلب أحدث بيانات الإدارة والوكيل) */
router.post('/cycles/:id/sync', requireAuth, async (req, res) => {
  try {
    const cycleId = req.params.id;
    const db = getDb();
    const { userInfoSpreadsheetId, userInfoSheetName } = req.body || {};
    const cycle = (await db.query(
      'SELECT id, name, management_spreadsheet_id, management_sheet_name, agent_spreadsheet_id, agent_sheet_name FROM financial_cycles WHERE id = $1 AND user_id = $2',
      [cycleId, req.session.userId]
    )).rows[0];
    if (!cycle) return res.json({ success: false, message: 'الدورة غير موجودة' });

    const mgmtSsId = cycle.management_spreadsheet_id ? String(cycle.management_spreadsheet_id).trim() : null;
    const agentSsId = cycle.agent_spreadsheet_id ? String(cycle.agent_spreadsheet_id).trim() : null;
    if (!mgmtSsId || !agentSsId) {
      return res.json({
        success: false,
        message: 'هذه الدورة غير مرتبطة بجداول Google. أنشئ دورة جديدة من قسم Sheet باستخدام «استيراد من Google» ثم احفظها لتفعيل المزامنة.'
      });
    }

    const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
    if (!config?.token) return res.json({ success: false, message: 'لم يتم تسجيل الدخول بـ Google' });
    const credentials = config.credentials ? JSON.parse(config.credentials) : null;
    const oauth2Client = getOAuth2Client(credentials);
    if (!oauth2Client) return res.json({ success: false, message: 'بيانات الاعتماد غير متوفرة' });
    oauth2Client.setCredentials(JSON.parse(config.token));
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    const mgmtSheetName = cycle.management_sheet_name ? String(cycle.management_sheet_name).trim() : null;
    const agentSheetName = cycle.agent_sheet_name ? String(cycle.agent_sheet_name).trim() : null;

    const mgmtResult = await fetchSheetWithFallback(sheets, mgmtSsId, mgmtSheetName, null);
    const agentResult = await fetchSheetWithFallback(sheets, agentSsId, agentSheetName, mgmtSsId === agentSsId ? mgmtResult.sheetTitleUsed : null);

    const managementRows = mgmtResult.values;
    const agentRows = agentResult.values;

    let userInfoSynced = false;
    let userInfoRowsCount = 0;
    let userInfoSheetUsed = null;
    const uiSsRaw = userInfoSpreadsheetId != null ? String(userInfoSpreadsheetId).trim() : '';
    if (uiSsRaw) {
      const uiSheetPref = userInfoSheetName != null ? String(userInfoSheetName).trim() : '';
      const uiResult = await fetchSheetWithFallback(sheets, uiSsRaw, uiSheetPref || null, null);
      const userInfoRows = uiResult.values || [];
      userInfoRowsCount = userInfoRows.length;
      userInfoSheetUsed = uiResult.sheetTitleUsed || uiSheetPref || null;
      await db.query(
        `UPDATE financial_cycles SET management_data = $1, agent_data = $2, management_sheet_name = $3, agent_sheet_name = $4,
         user_info_data = $5, user_info_spreadsheet_id = $6, user_info_sheet_name = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8 AND user_id = $9`,
        [
          JSON.stringify(managementRows),
          JSON.stringify(agentRows),
          mgmtResult.sheetTitleUsed || mgmtSheetName,
          agentResult.sheetTitleUsed || agentSheetName,
          JSON.stringify(userInfoRows),
          uiSsRaw,
          userInfoSheetUsed,
          cycleId,
          req.session.userId,
        ]
      );
      userInfoSynced = true;
    } else {
      await db.query(
        'UPDATE financial_cycles SET management_data = $1, agent_data = $2, management_sheet_name = $3, agent_sheet_name = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 AND user_id = $6',
        [JSON.stringify(managementRows), JSON.stringify(agentRows), mgmtResult.sheetTitleUsed || mgmtSheetName, agentResult.sheetTitleUsed || agentSheetName, cycleId, req.session.userId]
      );
    }

    let detail = 'الإدارة: ' + managementRows.length + ' صف';
    if (mgmtResult.sheetTitleUsed) detail += " (ورقة \"" + mgmtResult.sheetTitleUsed + "\")";
    detail += '، الوكيل: ' + agentRows.length + ' صف';
    if (agentResult.sheetTitleUsed) detail += " (ورقة \"" + agentResult.sheetTitleUsed + "\")";
    if (userInfoSynced) {
      detail += '، معلومات المستخدمين: ' + userInfoRowsCount + ' صف';
      if (userInfoSheetUsed) detail += " (ورقة \"" + userInfoSheetUsed + "\")";
    }

    res.json({
      success: true,
      message: userInfoSynced
        ? 'تمت مزامنة جداول الدورة ومعلومات المستخدمين من Google (قراءة فقط)'
        : 'تمت مزامنة جداول الدورة من Google',
      managementRows: managementRows.length,
      agentRows: agentRows.length,
      managementSheetUsed: mgmtResult.sheetTitleUsed,
      agentSheetUsed: agentResult.sheetTitleUsed,
      userInfoSynced,
      userInfoRows: userInfoRowsCount,
      userInfoSheetUsed,
      detail,
    });
  } catch (e) {
    console.error('Cycle sync error', e);
    res.json({ success: false, message: e.message || 'فشلت مزامنة الدورة من Google' });
  }
});

/** أعمدة ورقة في جدول Google (أحرف الأعمدة + صف العناوين إن وُجد) لمزامنة قوائم اختيار الأعمدة */
router.get('/spreadsheet-columns', requireAuth, async (req, res) => {
  try {
    const { spreadsheetId, sheetName } = req.query;
    if (!spreadsheetId) return res.json({ success: false, message: 'معرّف الجدول مطلوب' });
    const db = getDb();
    const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
    if (!config?.token) return res.json({ success: false, message: 'لم يتم تسجيل الدخول بـ Google' });
    const credentials = config.credentials ? JSON.parse(config.credentials) : null;
    const oauth2Client = getOAuth2Client(credentials);
    if (!oauth2Client) return res.json({ success: false, message: 'بيانات الاعتماد غير متوفرة' });
    oauth2Client.setCredentials(typeof config.token === 'string' ? JSON.parse(config.token) : config.token);
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetsList = meta.data.sheets || [];
    const firstSheet = sheetsList[0];
    const title = (sheetName && String(sheetName).trim()) ? String(sheetName).trim() : (firstSheet ? firstSheet.properties.title : 'Sheet1');
    const data = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${title}'!A1:ZZ1`
    });
    const headerRow = (data.data.values && data.data.values[0]) ? data.data.values[0] : [];
    const maxCol = Math.max(26, headerRow.length);
    const columns = [];
    for (let i = 0; i < maxCol; i++) {
      columns.push({ letter: columnIndexToLetter(i), index: i, header: headerRow[i] != null ? String(headerRow[i]).trim() : '' });
    }
    res.json({ success: true, columns, sheetTitle: title });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الأعمدة' });
  }
});

function columnIndexToLetter(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

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

/** إنشاء دورة مالية (اسم + بيانات الإدارة + الوكيل + مراجع Google إن وُجدت) */
router.post('/cycles', requireAuth, async (req, res) => {
  try {
    const {
      name,
      managementData,
      agentData,
      managementSpreadsheetId,
      managementSheetName,
      agentSpreadsheetId,
      agentSheetName,
      transferDiscountPct
    } = req.body;
    if (!req.session?.userId) {
      return res.status(401).json({ success: false, message: 'انتهت الجلسة. سجّل دخولك مجدداً.' });
    }
    if (!name || !String(name).trim()) {
      return res.json({ success: false, message: 'أدخل اسم الدورة' });
    }
    const db = getDb();
    const mgmtSs = managementSpreadsheetId ? String(managementSpreadsheetId).trim() : null;
    const mgmtSn = managementSheetName ? String(managementSheetName).trim() : null;
    const agentSs = agentSpreadsheetId ? String(agentSpreadsheetId).trim() : null;
    const agentSn = agentSheetName ? String(agentSheetName).trim() : null;

    let managementJson = managementData != null ? JSON.stringify(managementData) : null;
    let agentJson = agentData != null ? JSON.stringify(agentData) : null;

    if (mgmtSs && agentSs && (!managementJson || !agentJson)) {
      const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
      if (config?.token) {
        const credentials = config.credentials ? JSON.parse(config.credentials) : null;
        const managementRows = await readSheetFromGoogle(mgmtSs, mgmtSn, credentials, config.token);
        const agentRows = await readSheetFromGoogle(agentSs, agentSn, credentials, config.token);
        managementJson = managementRows ? JSON.stringify(managementRows) : null;
        agentJson = agentRows ? JSON.stringify(agentRows) : null;
      }
    }

    const tdp = transferDiscountPct != null && !isNaN(parseFloat(transferDiscountPct))
      ? Math.max(0, Math.min(100, parseFloat(transferDiscountPct)))
      : 0;
    const result = await db.query(
      `INSERT INTO financial_cycles (user_id, name, management_data, agent_data,
       management_spreadsheet_id, management_sheet_name, agent_spreadsheet_id, agent_sheet_name, transfer_discount_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [req.session.userId, String(name).trim(), managementJson, agentJson, mgmtSs, mgmtSn, agentSs, agentSn, tdp]
    );
    const id = result.lastInsertRowid != null ? result.lastInsertRowid : null;
    console.log('[LorkERP] Cycle saved:', { id, name: String(name).trim(), userId: req.session.userId });
    if (id) {
      try {
        await ensurePrimaryAccreditationAfterCycleCreate(db, req.session.userId, id, agentJson);
      } catch (e) {
        console.error('[LorkERP] Primary accreditation hook:', e.message);
      }
    }
    res.json({ success: true, id, message: 'تم حفظ الدورة المالية' });
  } catch (e) {
    console.error('[LorkERP] Cycle save error:', e.message);
    res.json({ success: false, message: e.message || 'فشل حفظ الدورة' });
  }
});

/** استيراد من Google: جدول الإدارة + جدول الوكيل */
router.post('/import-google', requireAuth, async (req, res) => {
  try {
    const { managementSpreadsheetId, managementSheetName, agentSpreadsheetId, agentSheetName } = req.body;
    const db = getDb();
    const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
    if (!config?.token) {
      return res.json({ success: false, message: 'لم يتم تسجيل الدخول بـ Google. اربط من الإعدادات → Google Sheets.' });
    }
    const credentials = config.credentials ? JSON.parse(config.credentials) : null;
    if (!managementSpreadsheetId || !agentSpreadsheetId) {
      return res.json({ success: false, message: 'أدخل معرّف جدول الإدارة ومعرّف جدول الوكيل' });
    }
    const managementRows = await readSheetFromGoogle(
      managementSpreadsheetId.trim(),
      managementSheetName,
      credentials,
      config.token
    );
    const agentRows = await readSheetFromGoogle(
      agentSpreadsheetId.trim(),
      agentSheetName,
      credentials,
      config.token
    );
    res.json({
      success: true,
      managementRows,
      agentRows
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الاستيراد من Google' });
  }
});

/** رفع ملفين يدوياً (إدارة + وكيل) — Excel أو CSV */
router.post('/upload', requireAuth, (req, res) => {
  const uploadTwo = upload.fields([
    { name: 'managementFile', maxCount: 1 },
    { name: 'agentFile', maxCount: 1 }
  ]);
  uploadTwo(req, res, (err) => {
    if (err) {
      return res.json({ success: false, message: err.message || 'خطأ في رفع الملفات' });
    }
    try {
      const managementFile = req.files && req.files.managementFile && req.files.managementFile[0];
      const agentFile = req.files && req.files.agentFile && req.files.agentFile[0];
      if (!managementFile || !agentFile) {
        return res.json({ success: false, message: 'ارفع ملف الإدارة وملف الوكيل معاً' });
      }
      const managementRows = parseUploadedFile(managementFile.path, managementFile.mimetype);
      const agentRows = parseUploadedFile(agentFile.path, agentFile.mimetype);
      res.json({ success: true, managementRows, agentRows });
    } catch (e) {
      res.json({ success: false, message: e.message || 'فشل قراءة الملفات' });
    }
  });
});

/** تحويل لون hex إلى RGB (0–1) لـ Google Sheets */
function hexToRgb(hex) {
  const h = String(hex).replace(/^#/, '');
  if (h.length !== 6) return { red: 1, green: 1, blue: 1 };
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return { red: r, green: g, blue: b };
}

/** اسم ورقة آمن (Google يمنع : * ? / \) */
function safeSheetTitle(title) {
  return String(title || 'Sheet').replace(/[:*?/\\]/g, '_').slice(0, 100) || 'Sheet';
}

/** استخراج sheetId من metadata حسب اسم الورقة (أو أول ورقة إن لم يُذكر الاسم). إن وُجد اسم ولم يُطابق أي ورقة يُرجع null. */
function getSheetIdByTitle(meta, title) {
  if (!meta?.data?.sheets?.length) return null;
  if (title && String(title).trim()) {
    const t = String(title).trim();
    const s = meta.data.sheets.find(sh => (sh.properties?.title || '') === t);
    return s ? s.properties.sheetId : null;
  }
  return meta.data.sheets[0].properties.sheetId;
}

/** جلب إعدادات التدقيق */
router.get('/payroll-settings', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const row = (await db.query('SELECT discount_rate, agent_color, management_color FROM payroll_settings WHERE user_id = $1', [req.session.userId])).rows[0];
    res.json({
      success: true,
      discountRate: row ? row.discount_rate : 0,
      agentColor: row ? (row.agent_color || '#8b5cf6') : '#8b5cf6',
      managementColor: row ? (row.management_color || '#facc15') : '#facc15'
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

/** حفظ إعدادات التدقيق */
router.post('/payroll-settings', requireAuth, async (req, res) => {
  try {
    const { discountRate, agentColor, managementColor } = req.body;
    const db = getDb();
    await db.query(`
      INSERT INTO payroll_settings (user_id, discount_rate, agent_color, management_color, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET discount_rate = $5, agent_color = $6, management_color = $7, updated_at = CURRENT_TIMESTAMP
    `, [
      req.session.userId,
      Number(discountRate) || 0,
      String(agentColor || '#8b5cf6').slice(0, 20),
      String(managementColor || '#facc15').slice(0, 20),
      Number(discountRate) || 0,
      String(agentColor || '#8b5cf6').slice(0, 20),
      String(managementColor || '#facc15').slice(0, 20)
    ]);
    res.json({ success: true, message: 'تم حفظ إعدادات التدقيق' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

/**
 * تدقيق الرواتب بالكامل على السيرفر فقط — يتطلب لقطات محفوظة (مزامنة الدورة مع معلومات المستخدمين).
 * لا يستدعي Google Sheets للكتابة أو القراءة.
 */
router.post('/payroll-audit-local', requireAuth, async (req, res) => {
  try {
    const {
      cycleId,
      discountRate: bodyDiscountRate,
      agentColor,
      managementColor,
      userInfoUserIdCol,
      userInfoTitleCol,
      userInfoSalaryCol,
      cycleMgmtUserIdCol,
      cycleAgentUserIdCol,
      cycleAgentSalaryCol,
      forcePayrollReaudit,
    } = req.body;
    if (!cycleId) {
      return res.json({ success: false, message: 'اختر الدورة المالية' });
    }
    const db = getDb();
    const payrollSettingsRow = (await db.query('SELECT discount_rate FROM payroll_settings WHERE user_id = $1', [req.session.userId])).rows[0];
    const discountRatePct = Number(bodyDiscountRate) ?? Number(payrollSettingsRow?.discount_rate) ?? 0;

    const cycle = (await db.query(
      `SELECT name, management_data, agent_data, user_info_data,
              management_spreadsheet_id, agent_spreadsheet_id,
              management_sheet_name, agent_sheet_name, payroll_audit_user_info_hash
         FROM financial_cycles WHERE id = $1 AND user_id = $2`,
      [cycleId, req.session.userId]
    )).rows[0];
    if (!cycle) return res.json({ success: false, message: 'الدورة المالية غير موجودة' });

    const mgmtSsId = cycle.management_spreadsheet_id ? String(cycle.management_spreadsheet_id).trim() : null;
    const agentSsId = cycle.agent_spreadsheet_id ? String(cycle.agent_spreadsheet_id).trim() : null;
    if (!mgmtSsId || !agentSsId) {
      return res.json({
        success: false,
        message: 'الدورة غير مرتبطة بجداول الإدارة والوكيل. اربطها من قسم Sheet ثم زامن.',
      });
    }

    let managementRows = [];
    let agentRows = [];
    let userInfoRows = [];
    try {
      managementRows = cycle.management_data ? JSON.parse(cycle.management_data) : [];
      agentRows = cycle.agent_data ? JSON.parse(cycle.agent_data) : [];
      userInfoRows = cycle.user_info_data ? JSON.parse(cycle.user_info_data) : [];
    } catch (parseErr) {
      return res.json({ success: false, message: 'بيانات الدورة تالفة. أعد المزامنة من Google.' });
    }

    if (!Array.isArray(userInfoRows) || userInfoRows.length === 0) {
      return res.json({
        success: false,
        message: 'لا توجد لقطة لجدول معلومات المستخدمين. من تدقيق الرواتب اضغط «مزامنة للتدقيق» بعد اختيار جدول معلومات المستخدمين.',
      });
    }
    if (!Array.isArray(managementRows) || !Array.isArray(agentRows) || (managementRows.length === 0 && agentRows.length === 0)) {
      return res.json({
        success: false,
        message: 'بيانات الإدارة أو الوكيل فارغة. زامن الدورة من Google أولاً.',
      });
    }

    const userInfoHash = hashUserInfoRows(userInfoRows);
    if (cycle.payroll_audit_user_info_hash && cycle.payroll_audit_user_info_hash === userInfoHash && !forcePayrollReaudit) {
      return res.json({
        success: false,
        code: 'USER_INFO_UNCHANGED',
        message: 'لم يتغيّر جدول معلومات المستخدمين (اللقطة المحفوظة) من آخر تدقيق. حدّث اللقطة أو أرسل forcePayrollReaudit: true.',
      });
    }

    /** إعداد اتصال Google للمزامنة الجانبية */
    let localSheets = null;
    try {
      const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
      if (config?.token) {
        const credentials = config.credentials ? JSON.parse(config.credentials) : null;
        const lOAuth = getOAuth2Client(credentials);
        if (lOAuth) {
          lOAuth.setCredentials(typeof config.token === 'string' ? JSON.parse(config.token) : config.token);
          localSheets = google.sheets({ version: 'v4', auth: lOAuth });
        }
      }
    } catch (_) {}

    /** مزامنة الوكالات الفرعية من جدول الإدارة */
    let agencySync = null;
    if (mgmtSsId && localSheets) {
      try {
        const syncResult = await syncAgenciesFromManagementTable(cycleId, req.session.userId, localSheets);
        agencySync = { success: syncResult.success, usersCount: syncResult.usersCount ?? 0, agenciesCount: syncResult.agenciesCount ?? 0, error: syncResult.error };
      } catch (agencySyncErr) {
        console.error('[payroll-audit-local][AgencySync]', agencySyncErr.message);
        agencySync = { success: false, error: agencySyncErr.message };
      }
    }

    /** تحديث رصيد المؤجل من جدول الوكيل */
    if (agentSsId && localSheets) {
      try {
        await fetchDeferredBalanceUsers(cycleId, req.session.userId, localSheets);
      } catch (deferredErr) {
        console.error('[payroll-audit-local][Deferred]', deferredErr.message);
      }
    }

    /** حساب رصيد الصندوق */
    if (mgmtSsId && localSheets) {
      try {
        await calculateCashBoxBalance(cycleId, req.session.userId, localSheets);
      } catch (cashErr) {
        console.error('[payroll-audit-local][CashBox]', cashErr.message);
      }
    }

    const auditOut = runPayrollAuditCore({
      managementRows,
      agentRows,
      userInfoRows,
      columns: {
        userInfoUserIdCol,
        userInfoTitleCol,
        userInfoSalaryCol,
        cycleMgmtUserIdCol,
        cycleAgentUserIdCol,
        cycleAgentSalaryCol,
      },
      discountRatePct,
      agentColor,
      managementColor,
    });
    const {
      results,
      summary,
      dataRows,
      diagnosticContext,
    } = auditOut;
    const { COL_C } = auditOut.meta;
    const cycleMgmtCol = diagnosticContext.cycleMgmtCol;
    const cycleAgentCol = diagnosticContext.cycleAgentCol;
    const mgmtDataRows = diagnosticContext.mgmtDataRows;
    const agentDataRows = diagnosticContext.agentDataRows;
    const mgmtByUserId = diagnosticContext.mgmtByUserId;
    const agentByUserId = diagnosticContext.agentByUserId;

    const appliedCount = summary.agent + summary.management;
    let message = 'تم تنفيذ التدقيق محلياً (بدون كتابة على Google)';
    if (summary.total === 0) {
      message = 'لم تُقرأ أي صفوف من لقطة معلومات المستخدمين.';
    } else if (appliedCount === 0) {
      message = 'لم يُطابق أي صف. تحقق من الأعمدة أو أعد المزامنة.';
    }

    let sampleUserIds = [];
    let sampleMgmtIds = [];
    let sampleAgentIds = [];
    let diagnostic = null;
    if (appliedCount === 0 && summary.total > 0) {
      const seen = new Set();
      for (const r of dataRows) {
        const id = normalizeUserId(r[COL_C]);
        if (id && !seen.has(id)) { seen.add(id); sampleUserIds.push(id); if (sampleUserIds.length >= 12) break; }
      }
      seen.clear();
      for (const row of mgmtDataRows) {
        const id = normalizeUserId(row[cycleMgmtCol]);
        if (id && !seen.has(id)) { seen.add(id); sampleMgmtIds.push(id); if (sampleMgmtIds.length >= 12) break; }
      }
      seen.clear();
      for (const row of agentDataRows) {
        const id = normalizeUserId(row[cycleAgentCol]);
        if (id && !seen.has(id)) { seen.add(id); sampleAgentIds.push(id); if (sampleAgentIds.length >= 12) break; }
      }
      const mgmtUnique = Object.keys(mgmtByUserId).length;
      const agentUnique = Object.keys(agentByUserId).length;
      const sampleCheck = sampleUserIds.slice(0, 5).map(uid => ({
        userId: uid,
        inMgmt: !!mgmtByUserId[uid],
        inAgent: !!agentByUserId[uid],
      }));
      diagnostic = {
        managementUniqueCount: mgmtUnique,
        agentUniqueCount: agentUnique,
        userInfoUniqueCount: [...new Set(results.map(r => r.userId).filter(Boolean))].length,
        sampleCheck,
      };
    }

    const cycleMgmtSheetName = cycle.management_sheet_name ? String(cycle.management_sheet_name).trim() : null;
    const cycleAgentSheetName = cycle.agent_sheet_name ? String(cycle.agent_sheet_name).trim() : null;

    try {
      const { saveCycleCache, saveUserAuditStatus } = require('../services/payrollSearchService');
      const auditedAgentIdsSet = new Set();
      const auditedMgmtIdsSet = new Set();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.type.startsWith('سحب وكالة') && r.userId) auditedAgentIdsSet.add(r.userId);
        if (r.type === 'سحب إدارة' && r.userId) auditedMgmtIdsSet.add(r.userId);
        if (r.userId && (r.type.startsWith('سحب وكالة') || r.type === 'سحب إدارة')) {
          const src = r.type.startsWith('سحب وكالة') ? 'تدقيق وكيل من النظام' : 'تدقيق ادارة من النظام';
          await saveUserAuditStatus(req.session.userId, cycleId, r.userId, 'مدقق', src, {
            type: r.type,
            title: r.title,
            localOnly: true,
          });
        }
      }
      await saveCycleCache(req.session.userId, cycleId, {
        managementData: managementRows,
        agentData: agentRows,
        managementSheetName: cycleMgmtSheetName,
        agentSheetName: cycleAgentSheetName,
        auditedAgentIds: auditedAgentIdsSet,
        auditedMgmtIds: auditedMgmtIdsSet,
        foundInTargetSheetIds: new Set(),
        staleAfter: null,
      });
    } catch (cacheErr) {
      console.error('[payroll-audit-local] failed to update search cache', cacheErr.message);
    }

    try {
      await db.query(
        'UPDATE financial_cycles SET payroll_audit_user_info_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3',
        [userInfoHash, cycleId, req.session.userId]
      );
    } catch (hashErr) {
      console.error('[payroll-audit-local] failed to save user info hash', hashErr.message);
    }

    res.json({
      success: true,
      message,
      summary,
      localOnly: true,
      applied: appliedCount > 0,
      agencySync,
      results: results.map(r => ({ userId: r.userId, title: r.title, type: r.type })),
      sampleUserIds: sampleUserIds.length ? sampleUserIds : undefined,
      sampleMgmtIds: sampleMgmtIds.length ? sampleMgmtIds : undefined,
      sampleAgentIds: sampleAgentIds.length ? sampleAgentIds : undefined,
      diagnostic,
    });
  } catch (e) {
    console.error('payroll-audit-local error', e);
    res.json({ success: false, message: e.message || 'فشل التدقيق المحلي' });
  }
});

/** تنفيذ تدقيق الرواتب */
router.post('/payroll-execute', requireAuth, async (req, res) => {
  try {
    const {
      cycleId,
      spreadsheetId,
      discountRate: bodyDiscountRate,
      agentColor,
      managementColor,
      userInfoSheetName,
      userInfoUserIdCol,
      userInfoTitleCol,
      userInfoSalaryCol,
      userInfoStatusCol,
      cycleMgmtUserIdCol,
      cycleAgentUserIdCol,
      cycleAgentSalaryCol,
      forcePayrollReaudit,
    } = req.body;
    if (!cycleId || !spreadsheetId) {
      return res.json({ success: false, message: 'اختر الدورة المالية وجدول البيانات' });
    }
    const db = getDb();
    const payrollSettingsRow = (await db.query('SELECT discount_rate FROM payroll_settings WHERE user_id = $1', [req.session.userId])).rows[0];
    const discountRatePct = Number(bodyDiscountRate) ?? Number(payrollSettingsRow?.discount_rate) ?? 0;

    const cycle = (await db.query(
      'SELECT name, management_data, agent_data, payroll_audit_user_info_hash, management_spreadsheet_id, management_sheet_name, agent_spreadsheet_id, agent_sheet_name FROM financial_cycles WHERE id = $1 AND user_id = $2',
      [cycleId, req.session.userId]
    )).rows[0];
    if (!cycle) return res.json({ success: false, message: 'الدورة المالية غير موجودة' });

    let managementRows = cycle.management_data ? JSON.parse(cycle.management_data) : [];
    let agentRows = cycle.agent_data ? JSON.parse(cycle.agent_data) : [];
    const mgmtSsId = cycle.management_spreadsheet_id ? String(cycle.management_spreadsheet_id).trim() : null;
    const mgmtSheetName = cycle.management_sheet_name ? String(cycle.management_sheet_name).trim() : null;
    const agentSsId = cycle.agent_spreadsheet_id ? String(cycle.agent_spreadsheet_id).trim() : null;
    const agentSheetNameCycle = cycle.agent_sheet_name ? String(cycle.agent_sheet_name).trim() : null;

    const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
    if (!config?.token) return res.json({ success: false, message: 'لم يتم تسجيل الدخول بـ Google' });
    const credentials = config.credentials ? JSON.parse(config.credentials) : null;
    const oauth2Client = getOAuth2Client(credentials);
    if (!oauth2Client) return res.json({ success: false, message: 'بيانات الاعتماد غير متوفرة' });
    oauth2Client.setCredentials(JSON.parse(config.token));
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    let cycleSynced = false;
    /** مزامنة جداول الدورة من Google إن كانت الدورة مرتبطة بجداول في حساب المستخدم */
    if (mgmtSsId && agentSsId) {
      try {
        const mgmtResult = await fetchSheetWithFallback(sheets, mgmtSsId, mgmtSheetName, null);
        const agentResult = await fetchSheetWithFallback(sheets, agentSsId, agentSheetNameCycle, mgmtSsId === agentSsId ? mgmtResult.sheetTitleUsed : null);
        managementRows = mgmtResult.values;
        agentRows = agentResult.values;
        await db.query(
          'UPDATE financial_cycles SET management_data = $1, agent_data = $2, management_sheet_name = $3, agent_sheet_name = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 AND user_id = $6',
          [JSON.stringify(managementRows), JSON.stringify(agentRows), mgmtResult.sheetTitleUsed || mgmtSheetName, agentResult.sheetTitleUsed || agentSheetNameCycle, cycleId, req.session.userId]
        );
        cycleSynced = true;
      } catch (syncErr) {
        console.error('Cycle sync from Google failed', syncErr);
        /* نتابع بالبيانات المحفوظة إن فشلت المزامنة */
      }
    }

    /** قراءة جدول معلومات المستخدمين أولاً — منع إعادة تدقيق بلا تغيير فيه */
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const firstSheet = meta.data.sheets && meta.data.sheets[0];
    const mainSheetTitle = (userInfoSheetName && String(userInfoSheetName).trim()) ? String(userInfoSheetName).trim() : (firstSheet ? firstSheet.properties.title : 'Sheet1');
    const mainSheetId = firstSheet ? firstSheet.properties.sheetId : 0;
    const mainData = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${mainSheetTitle}'!A:ZZ`
    });
    const allRows = (mainData.data.values || []);
    const userInfoHash = hashUserInfoRows(allRows);
    if (cycle.payroll_audit_user_info_hash && cycle.payroll_audit_user_info_hash === userInfoHash && !forcePayrollReaudit) {
      return res.json({
        success: false,
        code: 'USER_INFO_UNCHANGED',
        message: 'لم يتغيّر جدول معلومات المستخدمين من آخر تدقيق ناجح. عدّل الجدول ثم أعد المحاولة، أو أرسل forcePayrollReaudit: true لإجبار التنفيذ.',
        spreadsheetUrl: meta.data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      });
    }

    /** مزامنة الوكالات الفرعية من جدول الإدارة (خطوة إضافية - لا تعطل التدقيق) */
    let agencySync = null;
    if (mgmtSsId) {
      try {
        const syncResult = await syncAgenciesFromManagementTable(cycleId, req.session.userId, sheets);
        agencySync = { success: syncResult.success, usersCount: syncResult.usersCount ?? 0, agenciesCount: syncResult.agenciesCount ?? 0, error: syncResult.error };
        if (!syncResult.success && syncResult.error) {
          console.error('[AgencySync]', syncResult.error);
        }
      } catch (agencySyncErr) {
        console.error('[AgencySync] Failed', agencySyncErr);
        agencySync = { success: false, error: agencySyncErr.message };
      }
    }

    /** تحديث رصيد المؤجل من جدول الوكيل (لا تعطل التدقيق) */
    if (agentSsId) {
      try {
        await fetchDeferredBalanceUsers(cycleId, req.session.userId, sheets);
      } catch (deferredErr) {
        console.error('[DeferredBalance] Failed', deferredErr);
      }
    }

    /** حساب رصيد الصندوق (لا تعطل التدقيق) */
    if (mgmtSsId) {
      try {
        await calculateCashBoxBalance(cycleId, req.session.userId, sheets);
      } catch (cashErr) {
        console.error('[CashBox] Failed', cashErr);
      }
    }

    const auditOut = runPayrollAuditCore({
      managementRows,
      agentRows,
      userInfoRows: allRows,
      columns: {
        userInfoUserIdCol,
        userInfoTitleCol,
        userInfoSalaryCol,
        cycleMgmtUserIdCol,
        cycleAgentUserIdCol,
        cycleAgentSalaryCol,
      },
      discountRatePct,
      agentColor,
      managementColor,
    });
    const {
      results,
      byTitle,
      summary,
      dataStart,
      dataRows,
      agentColorVal,
      mgmtColorVal,
      diagnosticContext,
    } = auditOut;
    const { COL_C, COL_L } = auditOut.meta;
    const cycleMgmtCol = diagnosticContext.cycleMgmtCol;
    const cycleAgentCol = diagnosticContext.cycleAgentCol;
    const mgmtDataRows = diagnosticContext.mgmtDataRows;
    const agentDataRows = diagnosticContext.agentDataRows;
    const mgmtByUserId = diagnosticContext.mgmtByUserId;
    const agentByUserId = diagnosticContext.agentByUserId;

    let cycleMgmtSsId = mgmtSsId;
    let cycleAgentSsId = agentSsId;
    let cycleMgmtSheetName = mgmtSheetName;
    let cycleAgentSheetName = agentSheetNameCycle;

    /** التأكد من وجود جدول الإدارة (لصق الصفوف فيه لاحقاً) */
    if (!cycleMgmtSsId || !cycleAgentSsId) {
      const cycleName = (cycle.name || 'دورة').trim();
      const dateStr = new Date().toISOString().slice(0, 10);
      const createRes = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: `دورة ${cycleName} - ${dateStr}` },
          sheets: [
            { properties: { title: 'الإدارة' } },
            { properties: { title: 'الوكيل' } }
          ]
        }
      });
      const newSpreadsheetId = createRes.data.spreadsheetId;
      if (!newSpreadsheetId) throw new Error('فشل إنشاء جدول الدورة في Google');
      await sheets.spreadsheets.values.update({
        spreadsheetId: newSpreadsheetId,
        range: "'الإدارة'!A1",
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: managementRows }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: newSpreadsheetId,
        range: "'الوكيل'!A1",
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: agentRows }
      });
      await db.query(
        `UPDATE financial_cycles SET management_spreadsheet_id = $1, management_sheet_name = 'الإدارة',
         agent_spreadsheet_id = $2, agent_sheet_name = 'الوكيل' WHERE id = $3 AND user_id = $4`,
        [newSpreadsheetId, newSpreadsheetId, cycleId, req.session.userId]
      );
      cycleMgmtSsId = newSpreadsheetId;
      cycleAgentSsId = newSpreadsheetId;
      cycleMgmtSheetName = 'الإدارة';
      cycleAgentSheetName = agentSheetNameCycle;
    }

    const titleToSheetName = {};
    const usedNames = new Set();
    for (const title of Object.keys(byTitle)) {
      let st = safeSheetTitle(title);
      while (usedNames.has(st)) st = st + '_' + usedNames.size;
      usedNames.add(st);
      titleToSheetName[title] = st;
    }
    const sheetNamesOrdered = Object.values(titleToSheetName);
    const sheetIdByName = {};
    /** أوراق موجودة مسبقاً في ملف الإدارة (لصق إلحاقي إن وُجدت) */
    let existingMgmtSheetTitles = [];
    if (cycleMgmtSsId && sheetNamesOrdered.length > 0) {
      try {
        const metaMgmtForSheets = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId: cycleMgmtSsId }));
        existingMgmtSheetTitles = (metaMgmtForSheets.data.sheets || []).map(s => (s.properties?.title || ''));
        const existingLower = new Set(existingMgmtSheetTitles.map(t => String(t).toLowerCase()));
        sheetNamesOrdered.forEach(st => {
          const found = metaMgmtForSheets.data.sheets?.find(sh => (sh.properties?.title || '') === st);
          if (found?.properties?.sheetId != null) sheetIdByName[st] = found.properties.sheetId;
        });
        // إزالة الأسماء التي تتكرر فقط باختلاف حالة الأحرف
        const uniqueByLower = [];
        const seenLower = new Set();
        for (const name of sheetNamesOrdered) {
          const lower = String(name).toLowerCase();
          if (seenLower.has(lower)) continue;
          seenLower.add(lower);
          uniqueByLower.push(name);
        }
        // استبدال القائمة المنظَّفة
        while (sheetNamesOrdered.length) sheetNamesOrdered.pop();
        uniqueByLower.forEach(n => sheetNamesOrdered.push(n));
      } catch (err) {
        throw new Error('لا يمكن الوصول إلى جدول الإدارة (الدورة). تأكد أن الدورة مرتبطة بجدول في حساب Google المرتبط بالتطبيق: ' + (err.message || ''));
      }
    }
    const existingLowerSet = new Set(existingMgmtSheetTitles.map(t => String(t).toLowerCase()));
    const toCreate = [];
    const toCreateLower = new Set();
    sheetNamesOrdered.forEach(st => {
      const lower = String(st).toLowerCase();
      if (existingLowerSet.has(lower)) return;
      if (toCreateLower.has(lower)) return;
      toCreateLower.add(lower);
      toCreate.push(st);
    });
    const addSheetRequests = toCreate.map(st => ({
      addSheet: { properties: { title: st } }
    }));
    /** إنشاء أوراق الهدف داخل ملف الإدارة فقط للتي لا وجود لها (اسم الورقة من عمود D) */
    if (addSheetRequests.length > 0 && cycleMgmtSsId) {
      const batchRes = await withSheetsRetry(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId: cycleMgmtSsId,
        requestBody: { requests: addSheetRequests }
      }));
      const replies = batchRes.data.replies || [];
      replies.forEach((rep, idx) => {
        if (rep.addSheet && rep.addSheet.properties) {
          sheetIdByName[toCreate[idx]] = rep.addSheet.properties.sheetId;
        }
      });
    }

    const payrollSheetDelayMs = parseInt(process.env.SHEETS_PAYROLL_SHEET_DELAY_MS || '1200', 10) || 1200;
    let payrollSheetIter = 0;

    /** نسخ الصفوف ولصقها في أوراق جدول الإدارة (حسب اسم الورقة من عمود D) مع التلوين — مع حماية من التكرار: لا نلصق صفاً سبق تدقيقه أو لُصق يدوياً */
    for (const title of Object.keys(byTitle)) {
      if (payrollSheetIter > 0 && payrollSheetDelayMs > 0) await sleep(payrollSheetDelayMs);
      payrollSheetIter += 1;

      const sheetName = titleToSheetName[title];
      const items = byTitle[title];
      if (items.length === 0 || !cycleMgmtSsId) continue;
      const sheetExisted = existingMgmtSheetTitles.includes(sheetName);

      /** أرقام المستخدمين الموجودة مسبقاً في الورقة (من تشغيل سابق أو لصق يدوي) — نتجاهلهم ولا نلصقهم مرة ثانية */
      let existingInSheetIds = new Set();
      if (sheetExisted) {
        try {
          const curr = await withSheetsRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId: cycleMgmtSsId,
            range: `'${sheetName}'!A:ZZ`
          }));
          const sheetRows = curr.data.values || [];
          sheetRows.forEach((row, idx) => {
            if (idx === 0 && row && isHeaderRow(row, cycleMgmtCol)) return; /* صف عناوين */
            const cell = row[cycleMgmtCol];
            const id = normalizeUserId(cell);
            if (id) existingInSheetIds.add(id);
          });
        } catch (_) {}
      }

      /** نلصق فقط الصفوف التي رقم المستخدم فيها غير موجود في الورقة بعد */
      const itemsToPaste = items.filter(it => {
        const id = normalizeUserId(it.managementRow[cycleMgmtCol]);
        return id && !existingInSheetIds.has(id);
      });
      if (itemsToPaste.length === 0) continue;

      const values = itemsToPaste.map(it => it.managementRow);
      let appendResponse = null;
      try {
        if (sheetExisted) {
          /** ورقة موجودة: إلحاق الصفوف الجديدة فقط في نهاية الورقة */
          appendResponse = await withSheetsRetry(() => sheets.spreadsheets.values.append({
            spreadsheetId: cycleMgmtSsId,
            range: `'${sheetName}'!A:ZZ`,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values }
          }));
        } else {
          await withSheetsRetry(() => sheets.spreadsheets.values.update({
            spreadsheetId: cycleMgmtSsId,
            range: `'${sheetName}'!A1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
          }));
        }
      } catch (pasteErr) {
        throw new Error('فشل نسخ الصفوف إلى ورقة «' + sheetName + '» في جدول الإدارة: ' + (pasteErr.message || ''));
      }
    }

    /* عمود الراتب وعمود الحالة المحاذي في جدول معلومات المستخدمين (مثلاً L و M) */
    const salaryColLetter = (userInfoSalaryCol && String(userInfoSalaryCol).trim()) ? String(userInfoSalaryCol).trim().toUpperCase() : 'L';
    const salaryColIdx = columnLetterToIndex(salaryColLetter) ?? 11;
    const statusColLetter = (userInfoStatusCol && String(userInfoStatusCol).trim())
      ? String(userInfoStatusCol).trim().toUpperCase()
      : columnIndexToLetter(salaryColIdx + 1);
    const minRow = dataStart + 1;
    const maxRow = dataStart + dataRows.length;
    const byRowSalary = {};
    const byRowStatus = {};
    results.forEach(r => {
      if (r.type.startsWith('سحب وكالة') || r.type === 'سحب إدارة') {
        byRowSalary[r.rowIndex] = r.salaryValue === '' ? '' : r.salaryValue; /* سحب إدارة = 0 */
        byRowStatus[r.rowIndex] = r.statusLabel || ''; /* سحب وكيل / سحب وكيل راتبين / سحب ادارة */
      } else if (r.type === 'غير موجود') {
        byRowSalary[r.rowIndex] = 0;
        byRowStatus[r.rowIndex] = 'غير موجود';
      }
    });
    const salaryValues = [];
    const statusValues = [];
    for (let r = minRow; r <= maxRow; r++) {
      salaryValues.push([byRowSalary[r] !== undefined ? byRowSalary[r] : '']);
      statusValues.push([byRowStatus[r] !== undefined ? byRowStatus[r] : '']);
    }
    if (salaryValues.length > 0) {
      await withSheetsRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${mainSheetTitle}'!${salaryColLetter}${minRow}:${salaryColLetter}${maxRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: salaryValues }
      }));
    }
    if (statusValues.length > 0) {
      await withSheetsRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${mainSheetTitle}'!${statusColLetter}${minRow}:${statusColLetter}${maxRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: statusValues }
      }));
    }

    /** تطبيق التلوين على جداول الدورة في Google (ورقة الإدارة وورقة الوكيل) — فهارس الصفوف 0-based في الـ API */
    const mgmtColorByRow = {};
    const agentColorByRow = {};
    for (const r of results) {
      if (r.type.startsWith('سحب وكالة') && r.mgmtSheetRowIndex != null) {
        mgmtColorByRow[r.mgmtSheetRowIndex] = agentColorVal;
      } else if (r.type === 'سحب إدارة' && r.mgmtSheetRowIndex != null) {
        mgmtColorByRow[r.mgmtSheetRowIndex] = mgmtColorVal;
      }
      if (r.type.startsWith('سحب وكالة') && r.agentSheetRowIndices?.length) {
        for (const rowIdx of r.agentSheetRowIndices) {
          agentColorByRow[rowIdx] = agentColorVal;
        }
      }
    }

    /** تلوين الصفوف الأصلية في ورقة الإدارة الرئيسية (مثلاً «الإدارة») */
    if (cycleMgmtSsId && Object.keys(mgmtColorByRow).length > 0) {
      const metaMgmt = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId: cycleMgmtSsId }));
      const mgmtSheetId = getSheetIdByTitle(metaMgmt, cycleMgmtSheetName);
      if (mgmtSheetId != null) {
        const mgmtReqs = Object.entries(mgmtColorByRow).map(([rowIdx, color]) => ({
          repeatCell: {
            range: {
              sheetId: mgmtSheetId,
              startRowIndex: Number(rowIdx),
              endRowIndex: Number(rowIdx) + 1,
              startColumnIndex: 0,
              endColumnIndex: 200
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: hexToRgb(color)
              }
            },
            fields: 'userEnteredFormat.backgroundColor'
          }
        }));
        await batchUpdateRequestsInChunks(sheets, cycleMgmtSsId, mgmtReqs);
      }
    }

    if (cycleAgentSsId) {
      const metaAgent = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId: cycleAgentSsId }));
      const agentSheetId = getSheetIdByTitle(metaAgent, cycleAgentSheetName);
      const agentReqs = Object.entries(agentColorByRow).map(([rowIdx, color]) => ({
        repeatCell: {
          range: {
            sheetId: agentSheetId,
            startRowIndex: Number(rowIdx),
            endRowIndex: Number(rowIdx) + 1,
            startColumnIndex: 0,
            endColumnIndex: 200
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: hexToRgb(color)
            }
          },
          fields: 'userEnteredFormat.backgroundColor'
        }
      }));
      if (agentReqs.length > 0 && agentSheetId != null) {
        await batchUpdateRequestsInChunks(sheets, cycleAgentSsId, agentReqs);
      }
    }

    const appliedCount = summary.agent + summary.management;
    let message = 'تم تنفيذ التدقيق';
    if (summary.total === 0) {
      message = 'لم تُقرأ أي صفوف من جدول معلومات المستخدمين. تحقق من أن الورقة الأولى تحتوي بيانات وأن عمود C (رقم المستخدم) و D (اسم الورقة) مملوءان.';
    } else if (appliedCount === 0) {
      message = 'لم يُطابق أي صف (0 سحب وكالة، 0 سحب إدارة). يُقارن رقم المستخدم من عمود معلومات المستخدمين مع عمودي الإدارة والوكيل. تحقق من تطابق الأرقام أو من اختيار الأعمدة الصحيحة (انظر العينة أدناه).';
    }

    /** عند عدم وجود تطابق: إرجاع عينة من الأرقام + إحصائيات تشخيصية */
    let sampleUserIds = [];
    let sampleMgmtIds = [];
    let sampleAgentIds = [];
    let diagnostic = null;
    if (appliedCount === 0 && summary.total > 0) {
      const seen = new Set();
      for (const r of dataRows) {
        const id = normalizeUserId(r[COL_C]);
        if (id && !seen.has(id)) { seen.add(id); sampleUserIds.push(id); if (sampleUserIds.length >= 12) break; }
      }
      seen.clear();
      for (const row of mgmtDataRows) {
        const id = normalizeUserId(row[cycleMgmtCol]);
        if (id && !seen.has(id)) { seen.add(id); sampleMgmtIds.push(id); if (sampleMgmtIds.length >= 12) break; }
      }
      seen.clear();
      for (const row of agentDataRows) {
        const id = normalizeUserId(row[cycleAgentCol]);
        if (id && !seen.has(id)) { seen.add(id); sampleAgentIds.push(id); if (sampleAgentIds.length >= 12) break; }
      }
      const mgmtUnique = Object.keys(mgmtByUserId).length;
      const agentUnique = Object.keys(agentByUserId).length;
      const sampleCheck = sampleUserIds.slice(0, 5).map(uid => ({
        userId: uid,
        inMgmt: !!mgmtByUserId[uid],
        inAgent: !!agentByUserId[uid]
      }));
      diagnostic = {
        managementUniqueCount: mgmtUnique,
        agentUniqueCount: agentUnique,
        userInfoUniqueCount: [...new Set(results.map(r => r.userId).filter(Boolean))].length,
        sampleCheck
      };
    }

    const spreadsheetUrl = meta.data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

    try {
      const { saveCycleCache, saveUserAuditStatus } = require('../services/payrollSearchService');
      const auditedAgentIdsSet = new Set();
      const auditedMgmtIdsSet = new Set();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.type.startsWith('سحب وكالة') && r.userId) auditedAgentIdsSet.add(r.userId);
        if (r.type === 'سحب إدارة' && r.userId) auditedMgmtIdsSet.add(r.userId);
        if (r.userId && (r.type.startsWith('سحب وكالة') || r.type === 'سحب إدارة')) {
          const src = r.type.startsWith('سحب وكالة') ? 'تدقيق وكيل من النظام' : 'تدقيق ادارة من النظام';
          await saveUserAuditStatus(req.session.userId, cycleId, r.userId, 'مدقق', src, { type: r.type, title: r.title });
        }
      }
      await saveCycleCache(req.session.userId, cycleId, {
        managementData: managementRows,
        agentData: agentRows,
        managementSheetName: cycleMgmtSheetName,
        agentSheetName: cycleAgentSheetName,
        auditedAgentIds: auditedAgentIdsSet,
        auditedMgmtIds: auditedMgmtIdsSet,
        foundInTargetSheetIds: new Set(),
        staleAfter: null
      });
    } catch (cacheErr) {
      console.error('[payroll-execute] failed to update search cache', cacheErr.message);
    }
    try {
      await db.query(
        'UPDATE financial_cycles SET payroll_audit_user_info_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3',
        [userInfoHash, cycleId, req.session.userId]
      );
    } catch (hashErr) {
      console.error('[payroll-execute] failed to save user info hash', hashErr.message);
    }
    res.json({
      success: true,
      message,
      summary,
      spreadsheetUrl,
      applied: appliedCount > 0,
      cycleSynced,
      agencySync,
      results: results.map(r => ({ userId: r.userId, title: r.title, type: r.type })),
      sampleUserIds: sampleUserIds.length ? sampleUserIds : undefined,
      sampleMgmtIds: sampleMgmtIds.length ? sampleMgmtIds : undefined,
      sampleAgentIds: sampleAgentIds.length ? sampleAgentIds : undefined,
      diagnostic
    });
  } catch (e) {
    console.error('payroll-execute error', e);
    res.json({ success: false, message: e.message || 'فشل تنفيذ التدقيق' });
  }
});

module.exports = router;
