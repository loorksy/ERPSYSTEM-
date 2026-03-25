const { google } = require('googleapis');
const { getDb } = require('../db/database');
const {
  normalizeUserId,
  getCycleCache,
  saveCycleCache,
  getCycleColumns
} = require('./payrollSearchService');
const { syncAgenciesFromManagementTable } = require('./agencySyncService');
const { fetchSheetValuesBatched, withSheetsRetry } = require('./googleSheetsReadHelpers');

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:3000'}/sheets/callback`;

function getOAuth2Client(credentials) {
  const clientId = credentials?.client_id || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = credentials?.client_secret || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

async function fetchSheetWithFallback(sheets, spreadsheetId, preferredSheetName) {
  const meta = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId }));
  const sheetList = meta.data.sheets || [];
  const titles = sheetList.map(s => (s.properties && s.properties.title) || '').filter(Boolean);
  if (!titles.length) return { values: [], sheetTitleUsed: null };
  const preferred = preferredSheetName && String(preferredSheetName).trim();
  const toTry = [];
  if (preferred) toTry.push(preferred);
  for (const t of titles) {
    if (t && !toTry.includes(t)) toTry.push(t);
  }
  if (!toTry.length && titles[0]) toTry.push(titles[0]);
  let best = { values: [], sheetTitleUsed: null };
  for (const title of toTry) {
    try {
      const values = await fetchSheetValuesBatched(sheets, spreadsheetId, title);
      if (values.length > best.values.length) best = { values, sheetTitleUsed: title };
      if (values.length > 0 && preferred && title === preferred) return { values, sheetTitleUsed: title };
    } catch (_) {}
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

async function syncSingleCycle(db, oauth2Client, cycleRow, ttlMinutes) {
  const managementSpreadsheetId = cycleRow.management_spreadsheet_id && String(cycleRow.management_spreadsheet_id).trim();
  const agentSpreadsheetId = cycleRow.agent_spreadsheet_id && String(cycleRow.agent_spreadsheet_id).trim();
  if (!managementSpreadsheetId || !agentSpreadsheetId) return;
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const mgmtResult = await fetchSheetWithFallback(sheets, managementSpreadsheetId, cycleRow.management_sheet_name);
  const agentResult = await fetchSheetWithFallback(sheets, agentSpreadsheetId, cycleRow.agent_sheet_name);
  const managementRows = mgmtResult.values || [];
  const agentRows = agentResult.values || [];

  const cols = await getCycleColumns(cycleRow.user_id, cycleRow.id);
  const mgmtIdx = columnLetterToIndex(cols.mgmt_user_id_col || 'A') ?? 0;
  const agentIdx = columnLetterToIndex(cols.agent_user_id_col || 'A') ?? 0;

  const auditedAgentIds = new Set();
  const auditedMgmtIds = new Set();

  const mgmtDataRows = managementRows.slice(1);
  mgmtDataRows.forEach(row => {
    const id = normalizeUserId(row[mgmtIdx]);
    if (id) auditedMgmtIds.add(id);
  });
  const agentDataRows = agentRows.slice(1);
  agentDataRows.forEach(row => {
    const id = normalizeUserId(row[agentIdx]);
    if (id) auditedAgentIds.add(id);
  });

  const foundInTargetSheetIds = new Set();

  const staleAfter = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  await saveCycleCache(cycleRow.user_id, cycleRow.id, {
    managementData: managementRows,
    agentData: agentRows,
    managementSheetName: mgmtResult.sheetTitleUsed || cycleRow.management_sheet_name || null,
    agentSheetName: agentResult.sheetTitleUsed || cycleRow.agent_sheet_name || null,
    auditedAgentIds,
    auditedMgmtIds,
    foundInTargetSheetIds,
    staleAfter
  });

  try {
    const syncResult = await syncAgenciesFromManagementTable(cycleRow.id, cycleRow.user_id, sheets);
    if (!syncResult.success && syncResult.error) {
      console.warn('[cycleSyncWorker] Agency sync:', syncResult.error);
    }
  } catch (agencyErr) {
    console.warn('[cycleSyncWorker] Agency sync failed:', agencyErr.message);
  }
}

async function runCycleSyncOnce(ttlMinutes = 5) {
  try {
    const db = getDb();
    const config = (await db.query('SELECT token, credentials, sync_enabled FROM google_sheets_config WHERE id = 1')).rows[0];
    if (!config || !config.token || !config.sync_enabled) return;
    const credentials = config.credentials ? JSON.parse(config.credentials) : null;
    const oauth2Client = getOAuth2Client(credentials);
    if (!oauth2Client) return;
    oauth2Client.setCredentials(typeof config.token === 'string' ? JSON.parse(config.token) : config.token);

    const cycles = (await db.query(
      `SELECT id, user_id, management_spreadsheet_id, management_sheet_name,
              agent_spreadsheet_id, agent_sheet_name
         FROM financial_cycles
        WHERE management_spreadsheet_id IS NOT NULL
          AND agent_spreadsheet_id IS NOT NULL`
    )).rows;

    for (const c of cycles) {
      try {
        const existing = await getCycleCache(c.user_id, c.id);
        if (existing && existing.staleAfter && new Date(existing.staleAfter) > new Date()) {
          continue;
        }
        await syncSingleCycle(db, oauth2Client, c, ttlMinutes);
      } catch (e) {
        console.error('[cycleSyncWorker] Failed to sync cycle', c.id, e.message);
      }
    }
  } catch (e) {
    console.error('[cycleSyncWorker] runCycleSyncOnce error:', e.message);
    throw e;
  }
}

function startBackgroundSync(intervalMs, ttlMinutes = 5) {
  const ms = intervalMs != null && intervalMs > 0
    ? intervalMs
    : Number(process.env.CYCLE_SYNC_INTERVAL_MS) || 120000;
  if (ms <= 0 || process.env.DISABLE_BACKGROUND_SYNC === '1') return;
  setInterval(() => {
    runCycleSyncOnce(ttlMinutes).catch(err => {
      console.error('[cycleSyncWorker] runCycleSyncOnce error:', err.message);
    });
  }, ms);
}

module.exports = {
  startBackgroundSync,
  runCycleSyncOnce
};

