/**
 * قراءة Google Sheets مع تخفيف أخطاء 429 (حد الطلبات لكل مستخدم/دقيقة).
 */

const SHEET_BATCH_ROWS = 5000;
const SHEET_MAX_ROWS = 150000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {() => Promise<any>} fn */
async function withSheetsRetry(fn, { maxAttempts = 8 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.code || e.response?.status;
      const reason = e.errors?.[0]?.reason;
      const is429 = status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
      if (is429) {
        const ra = e.response?.headers?.['retry-after'];
        const retryAfterSec = ra != null ? parseInt(String(ra), 10) : NaN;
        const backoffSec = !isNaN(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec
          : Math.min(90, 3 * (2 ** attempt));
        const waitMs = backoffSec * 1000 + Math.floor(Math.random() * 400);
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
 * جلب أول 5000 صف من عدة أوراق في طلب(ات) batchGet — يقلّل طلبات القراءة من N إلى ~ceil(N/chunkSize).
 * @returns {Map<string, any[][]>}
 */
async function batchGetSheetsFirstChunk(sheets, spreadsheetId, sheetNames, chunkSize = 35) {
  const map = new Map();
  if (!sheetNames || !sheetNames.length) return map;

  for (let i = 0; i < sheetNames.length; i += chunkSize) {
    const chunk = sheetNames.slice(i, i + chunkSize);
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
  }
  return map;
}

module.exports = {
  withSheetsRetry,
  fetchSheetValuesBatched,
  batchGetSheetsFirstChunk,
  escapeSheetTitleForRange,
  SHEET_BATCH_ROWS,
};
