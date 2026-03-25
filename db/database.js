/**
 * LorkERP Database Layer - PostgreSQL Only
 * When DATABASE_URL is set: PostgreSQL only, no SQLite fallback.
 * API: getDb().query(sql, params) → { rows, rowCount, lastInsertRowid }
 */
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;

let pgPool = null;

/**
 * Execute a SQL query. Use native PostgreSQL placeholders: $1, $2, $3...
 * @param {string} sql - SQL with $1, $2, $3... placeholders
 * @param {Array} params - Query parameters (order must match placeholders)
 * @returns {{ rows: Array, rowCount: number, lastInsertRowid: number|null }}
 */
async function query(sql, params = []) {
  if (!pgPool) throw new Error('Database not initialized. Call initDatabase() first.');
  let pgSql = sql;
  const isInsert = /^\s*INSERT\s+/i.test(sql.trim()) && !/ON CONFLICT/i.test(pgSql);
  const needsReturning = isInsert && !/RETURNING\s+/i.test(pgSql);
  if (needsReturning) {
    pgSql = pgSql.replace(/;\s*$/, '') + ' RETURNING id';
  }
  try {
    const res = await pgPool.query(pgSql, params);
    const rows = res.rows || [];
    return {
      rows,
      rowCount: res.rowCount ?? 0,
      lastInsertRowid: rows[0]?.id ?? null
    };
  } catch (e) {
    console.error('[DB] PG error:', e.message);
    throw e;
  }
}

function getDb() {
  if (!pgPool) throw new Error('Database not initialized. Call initDatabase() first.');
  return { query };
}

// Remove prepare after full migration - for now we'll replace all usages with query()

async function ensurePgSchema() {
  const schemaPath = path.join(__dirname, 'schema.pg.sql');
  if (!fs.existsSync(schemaPath)) return;
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const raw = sql.split(';').map(s => s.trim()).filter(Boolean);
  const statements = raw.filter(s => !/^--/.test(s) || s.includes('CREATE TABLE'));
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      await pgPool.query(stmt + ';');
    } catch (e) {
      if (!e.message.includes('already exists')) {
        console.error('[DB] Schema error on statement', i + 1, ':', e.message);
        console.error('[DB] Statement preview:', stmt.slice(0, 100).replace(/\s+/g, ' '));
      }
    }
  }
}

/** ترحيل أعمدة لقطات جدول معلومات المستخدمين (تدقيق سيرفر فقط) */
async function ensureFinancialCyclesUserInfoColumns() {
  if (!pgPool) return;
  const stmts = [
    'ALTER TABLE financial_cycles ADD COLUMN IF NOT EXISTS user_info_data TEXT',
    'ALTER TABLE financial_cycles ADD COLUMN IF NOT EXISTS user_info_sheet_name TEXT',
    'ALTER TABLE financial_cycles ADD COLUMN IF NOT EXISTS user_info_spreadsheet_id TEXT',
  ];
  for (const s of stmts) {
    try {
      await pgPool.query(s);
    } catch (e) {
      if (!/already exists|duplicate column/i.test(String(e.message))) {
        console.error('[DB] user_info migration:', e.message);
      }
    }
  }
}

/** جداول تدقيق الرواتب المحلي (ملفات مرفوعة) */
async function ensurePayrollNativeTables() {
  if (!pgPool) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS payroll_native_cycles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS payroll_native_management_workbook (
      cycle_id INTEGER PRIMARY KEY REFERENCES payroll_native_cycles(id) ON DELETE CASCADE,
      sheets_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS payroll_native_agent_workbook (
      cycle_id INTEGER PRIMARY KEY REFERENCES payroll_native_cycles(id) ON DELETE CASCADE,
      sheets_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS payroll_native_userinfo_workbook (
      cycle_id INTEGER PRIMARY KEY REFERENCES payroll_native_cycles(id) ON DELETE CASCADE,
      sheets_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS payroll_native_settings (
      user_id INTEGER NOT NULL,
      native_cycle_id INTEGER NOT NULL,
      mgmt_user_id_col TEXT DEFAULT 'A',
      agent_user_id_col TEXT DEFAULT 'A',
      agent_salary_col TEXT DEFAULT 'D',
      user_info_user_id_col TEXT DEFAULT 'C',
      user_info_title_col TEXT DEFAULT 'D',
      user_info_salary_col TEXT DEFAULT 'L',
      user_info_sheet_index INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, native_cycle_id),
      FOREIGN KEY (native_cycle_id) REFERENCES payroll_native_cycles(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS payroll_native_user_audit (
      user_id INTEGER NOT NULL,
      native_cycle_id INTEGER NOT NULL,
      member_user_id TEXT NOT NULL,
      audit_status TEXT DEFAULT 'غير مدقق',
      audit_source TEXT,
      details_json TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, native_cycle_id, member_user_id),
      FOREIGN KEY (native_cycle_id) REFERENCES payroll_native_cycles(id) ON DELETE CASCADE
    )`,
  ];
  for (const s of stmts) {
    try {
      await pgPool.query(s);
    } catch (e) {
      console.error('[DB] payroll_native migration:', e.message);
    }
  }
}

async function ensureAdminUser() {
  if (!pgPool) return;
  const r = await query('SELECT * FROM users WHERE username = $1', [process.env.ADMIN_USERNAME || 'admin']);
  const user = r.rows[0];
  if (!user || !user.username) {
    const hashedPassword = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    await query('INSERT INTO users (username, password, display_name, role) VALUES ($1, $2, $3, $4)',
      [process.env.ADMIN_USERNAME || 'admin', hashedPassword, 'مدير النظام', 'admin']);
  }
}

async function initDatabase() {
  if (DATABASE_URL && DATABASE_URL.startsWith('postgres')) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    await pgPool.query('SELECT 1');
    console.log('[LorkERP] Using PostgreSQL');
    await ensurePgSchema();
    await ensureFinancialCyclesUserInfoColumns();
    await ensurePayrollNativeTables();
    await ensureAdminUser();
    return getDb();
  }

  throw new Error('DATABASE_URL (PostgreSQL) is required. Set DATABASE_URL=postgresql://... in environment.');
}

/**
 * تنفيذ عدة أوامر في معاملة واحدة (BEGIN / COMMIT / ROLLBACK).
 * @param {(client: import('pg').PoolClient) => Promise<void>} callback
 */
async function runTransaction(callback) {
  if (!pgPool) throw new Error('Database not initialized.');
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await callback(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { getDb, initDatabase, query, runTransaction, usePostgres: () => !!pgPool };
