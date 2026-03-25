const { google } = require('googleapis');
const { fetchSheetValuesBatched, withSheetsRetry } = require('./googleSheetsReadHelpers');

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:3000'}/sheets/callback`;

function getOAuth2Client(credentials) {
  const clientId = credentials?.client_id || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = credentials?.client_secret || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

function extractSpreadsheetIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

async function fetchSheetWithFallback(sheets, spreadsheetId, preferredSheetName, excludeSheetTitle) {
  const meta = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId }));
  const sheetList = meta.data.sheets || [];
  const titles = sheetList.map((s) => (s.properties && s.properties.title) || '').filter(Boolean);
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
    } catch (_) { /* try next */ }
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

/**
 * @param {object} db
 * @param {string} spreadsheetId
 * @param {string|null} sheetName
 */
async function fetchSheetRowsUsingStoredGoogleConfig(db, spreadsheetId, sheetName) {
  const config = (await db.query('SELECT token, credentials FROM google_sheets_config WHERE id = 1')).rows[0];
  if (!config?.token) throw new Error('لم يتم ربط Google من إعدادات الجداول');
  const credentials = config.credentials ? JSON.parse(config.credentials) : null;
  const oauth2Client = getOAuth2Client(credentials);
  if (!oauth2Client) throw new Error('بيانات اعتماد Google غير متوفرة');
  oauth2Client.setCredentials(JSON.parse(config.token));
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  return fetchSheetWithFallback(sheets, spreadsheetId, sheetName || null, null);
}

module.exports = {
  extractSpreadsheetIdFromUrl,
  fetchSheetRowsUsingStoredGoogleConfig,
};
