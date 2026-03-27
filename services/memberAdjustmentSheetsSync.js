/**
 * تطبيق إضافة/خصم على عمود الراتب في جدول معلومات المستخدمين (Google Sheet) المرتبط بالدورة.
 */

const crypto = require('crypto');
const { google } = require('googleapis');
const { withSheetsRetry, fetchSheetValuesBatched, escapeSheetTitleForRange } = require('./googleSheetsReadHelpers');
const { normalizeUserId, columnLetterToIndex, normalizeForNumber } = require('./payrollSearchService');
const { isHeaderRowUserInfo } = require('./payrollAuditEngine');

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:3000'}/sheets/callback`;

function hashUserInfoRows(rows) {
  if (!rows || !Array.isArray(rows)) return '';
  const normalized = rows.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => (cell == null ? '' : String(cell)))
  );
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

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

function getOAuth2Client(credentials) {
  const clientId = credentials?.client_id || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = credentials?.client_secret || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

function parseCellNumber(v) {
  const s = normalizeForNumber(v != null ? v : '');
  const n = parseFloat(s);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}

/**
 * @returns {Promise<{ sheetSynced: boolean, sheetMessage: string, sheetRange?: string }>}
 */
async function applyAdjustmentToUserInfoGoogleSheet(db, userId, options) {
  const {
    cycleId: cycleIdOpt,
    memberUserId,
    kind,
    amount,
    userInfoUserIdCol = 'C',
    userInfoSalaryCol = 'L',
  } = options;

  const mid = normalizeUserId(memberUserId);
  const amt = Math.abs(Number(amount));
  if (!mid || !amt) {
    return { sheetSynced: false, sheetMessage: 'رقم مستخدم أو مبلغ غير صالح لتطبيق التعديل على الشيت' };
  }

  let cycleId = cycleIdOpt;
  if (!cycleId) {
    const r = (await db.query(
      `SELECT id FROM financial_cycles WHERE user_id = $1
       AND COALESCE(TRIM(user_info_spreadsheet_id), '') <> ''
       ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST LIMIT 1`,
      [userId]
    )).rows[0];
    cycleId = r?.id;
  }
  if (!cycleId) {
    return {
      sheetSynced: false,
      sheetMessage:
        'حدد رقم الدورة المالية في النموذج، أو اربط «جدول معلومات المستخدمين» بدورة من تدقيق الرواتب ثم أعد المحاولة',
    };
  }

  const cycle = (await db.query(
    `SELECT user_info_spreadsheet_id, user_info_sheet_name FROM financial_cycles WHERE id = $1 AND user_id = $2`,
    [cycleId, userId]
  )).rows[0];
  const ssId = cycle?.user_info_spreadsheet_id ? String(cycle.user_info_spreadsheet_id).trim() : '';
  if (!ssId) {
    return {
      sheetSynced: false,
      sheetMessage: 'هذه الدورة لا تحتوي على معرف جدول معلومات المستخدمين — نفّذ مزامنة الدورة من صفحة تدقيق الرواتب',
    };
  }

  const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
  if (!config?.token) {
    return { sheetSynced: false, sheetMessage: 'اربط Google من الإعدادات → Google Sheets' };
  }

  const credentials = config.credentials ? JSON.parse(config.credentials) : null;
  const oauth2Client = getOAuth2Client(credentials);
  if (!oauth2Client) {
    return { sheetSynced: false, sheetMessage: 'بيانات اعتماد Google غير مكتملة' };
  }
  oauth2Client.setCredentials(typeof config.token === 'string' ? JSON.parse(config.token) : config.token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  let sheetTitle = cycle.user_info_sheet_name ? String(cycle.user_info_sheet_name).trim() : '';
  if (!sheetTitle) {
    const meta = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId: ssId }));
    sheetTitle = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
  }

  const rows = await fetchSheetValuesBatched(sheets, ssId, sheetTitle, 1);
  const uidCol = columnLetterToIndex(userInfoUserIdCol) ?? 2;
  const salCol = columnLetterToIndex(userInfoSalaryCol) ?? 11;

  const dataStart = rows.length > 0 && isHeaderRowUserInfo(rows[0], uidCol) ? 1 : 0;

  let delta = 0;
  const k = String(kind || '').toLowerCase();
  if (k === 'deduct') delta = -amt;
  else delta = amt;

  let found = -1;
  for (let i = dataStart; i < rows.length; i++) {
    if (normalizeUserId(rows[i][uidCol]) === mid) {
      found = i;
      break;
    }
  }
  if (found < 0) {
    return {
      sheetSynced: false,
      sheetMessage: `لم يُعثر على المستخدم ${mid} في عمود ${String(userInfoUserIdCol).toUpperCase()} بجدول معلومات المستخدمين`,
    };
  }

  const row = rows[found];
  while (row.length <= salCol) row.push('');
  const cur = parseCellNumber(row[salCol]);
  const next = Math.round((cur + delta) * 100) / 100;
  const finalVal = Math.max(0, next);
  /** نص عشري صريح يمنع عرض/تخزين الشيت كعدد صحيح (مثال: 90.65 + 10 → 100.65) */
  const cellForApi = String(Number(finalVal.toFixed(2)));

  const sheetRow1 = found + 1;
  const letter = columnIndexToLetter(salCol);
  const esc = escapeSheetTitleForRange(sheetTitle);
  const range = `'${esc}'!${letter}${sheetRow1}`;

  await withSheetsRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: ssId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[cellForApi]] },
    })
  );

  row[salCol] = finalVal;
  const hash = hashUserInfoRows(rows);
  await db.query(
    `UPDATE financial_cycles SET user_info_data = $1, payroll_audit_user_info_hash = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND user_id = $4`,
    [JSON.stringify(rows), hash, cycleId, userId]
  );

  return {
    sheetSynced: true,
    sheetMessage: `Google Sheets: تم تحديث ${letter}${sheetRow1} (${cur} → ${finalVal} USD)`,
    sheetRange: range,
  };
}

module.exports = {
  applyAdjustmentToUserInfoGoogleSheet,
};
