/**
 * قراءة/كتابة Google Sheets مع تخفيف أخطاء 429 (حد الطلبات لكل مستخدم/دقيقة).
 * ملاحظة: قد تُحتسب كل نطاق في batchGet كقراءة منفصلة — لذلك نستخدم دفعات صغيرة + تأخير بينها.
 */

const SHEET_BATCH_ROWS = 5000;
const SHEET_MAX_ROWS = 150000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function envInt(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = parseInt(String(v), 10);
  return !isNaN(n) && n >= 0 ? n : def;
}

/** قراءة وكتابة — نفس منطق إعادة المحاولة */
/** @param {() => Promise<any>} fn */
async function withSheetsRetry(fn, { maxAttempts = 12 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.code || e.response?.status;
      const reason = e.errors?.[0]?.reason;
      const msg = String(e.message || '');
      const is429 = status === 429
        || reason === 'rateLimitExceeded'
        || reason === 'userRateLimitExceeded'
        || /quota exceeded|429/i.test(msg);
      if (is429) {
        const ra = e.response?.headers?.['retry-after'];
        const retryAfterSec = ra != null ? parseInt(String(ra), 10) : NaN;
        const backoffSec = !isNaN(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec
          : Math.min(120, Math.max(5, 4 * (2 ** attempt)));
        const waitMs = backoffSec * 1000 + Math.floor(Math.random() * 500);
        console.warn(`[GoogleSheets] 429 — انتظار ${Math.round(waitMs / 1000)}s ثم إعادة المحاولة (${attempt + 1}/${maxAttempts})`);
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function escapeSheetTitleForRange(title) {
  return String(title).replace(/'/g, "''");
}

function rangeA1ZZ(title, startRow, endRow) {
  return `'${escapeSheetTitleForRange(title)}'!A${startRow}:ZZ${endRow}`;
}

/**
 * جلب صفوف ورقة على دفعات (مع إعادة المحاولة عند 429).
 * @param {number} [startRow=1]
 */
async function fetchSheetValuesBatched(sheets, spreadsheetId, title, startRow = 1) {
  const allRows = [];
  let row = startRow;
  while (row <= SHEET_MAX_ROWS) {
    const endRow = row + SHEET_BATCH_ROWS - 1;
    const res = await withSheetsRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: rangeA1ZZ(title, row, endRow),
      })
    );
    const batch = res.data.values || [];
    if (batch.length === 0) break;
    allRows.push(...batch);
    if (batch.length < SHEET_BATCH_ROWS) break;
    row = endRow + 1;
  }
  return allRows;
}

/**
 * جلب أول 5000 صف من عدة أوراق عبر batchGet على دفعات صغيرة + تأخير بين الدفعات
 * (تخفيف تجاوز Read requests per minute).
 * @returns {Map<string, any[][]>}
 */
async function batchGetSheetsFirstChunk(sheets, spreadsheetId, sheetNames, chunkSize, delayMsBetweenChunks) {
  const map = new Map();
  if (!sheetNames || !sheetNames.length) return map;

  const size = chunkSize != null ? chunkSize : envInt('SHEETS_BATCHGET_CHUNK_SIZE', 10);
  const delayMs = delayMsBetweenChunks != null ? delayMsBetweenChunks : envInt('SHEETS_BATCHGET_CHUNK_DELAY_MS', 2500);

  for (let i = 0; i < sheetNames.length; i += size) {
    const chunk = sheetNames.slice(i, i + size);
    const ranges = chunk.map((name) => rangeA1ZZ(name, 1, SHEET_BATCH_ROWS));
    const res = await withSheetsRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges,
      })
    );
    const vr = res.data.valueRanges || [];
    for (let j = 0; j < chunk.length; j++) {
      const name = chunk[j];
      const vrj = vr[j];
      map.set(name, (vrj && vrj.values) ? vrj.values : []);
    }
    if (i + size < sheetNames.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return map;
}

/**
 * تنفيذ batchUpdate على شكل عدة طلبات صغيرة (تخفيف Write requests per minute عند تلوين صفوف كثيرة).
 */
async function batchUpdateRequestsInChunks(sheets, spreadsheetId, requests, options = {}) {
  const chunkSize = options.chunkSize != null ? options.chunkSize : envInt('SHEETS_BATCHUPDATE_CHUNK_SIZE', 8);
  const delayMs = options.delayMs != null ? options.delayMs : envInt('SHEETS_BATCHUPDATE_CHUNK_DELAY_MS', 1500);
  if (!requests || !requests.length) return;
  for (let i = 0; i < requests.length; i += chunkSize) {
    const chunk = requests.slice(i, i + chunkSize);
    await withSheetsRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: chunk },
      })
    );
    if (i + chunkSize < requests.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }
}

module.exports = {
  withSheetsRetry,
  fetchSheetValuesBatched,
  batchGetSheetsFirstChunk,
  batchUpdateRequestsInChunks,
  escapeSheetTitleForRange,
  SHEET_BATCH_ROWS,
  sleep,
};
