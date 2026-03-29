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
    'ALTER TABLE financial_cycles ADD COLUMN IF NOT EXISTS payroll_audit_user_info_hash TEXT',
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

/** جدول المؤجل متعدد الدورات + ترحيل من deferred_balance_users القديم */
async function ensureFundsExcludeDashboardColumn() {
  if (!pgPool) return;
  try {
    await pgPool.query('ALTER TABLE funds ADD COLUMN IF NOT EXISTS exclude_from_dashboard INTEGER DEFAULT 0');
  } catch (e) {
    if (!/already exists|duplicate column/i.test(String(e.message))) {
      console.warn('[DB] funds.exclude_from_dashboard:', e.message);
    }
  }
}

/** فصل رصيد «علينا» عن «لنا» للمعتمدين + ترحيل من balance_amount */
async function ensureAccreditationBalanceBuckets() {
  if (!pgPool) return;
  try {
    await pgPool.query('ALTER TABLE accreditation_entities ADD COLUMN IF NOT EXISTS balance_payable REAL DEFAULT 0');
    await pgPool.query('ALTER TABLE accreditation_entities ADD COLUMN IF NOT EXISTS balance_receivable REAL DEFAULT 0');
    const r = await pgPool.query(
      `SELECT COUNT(*)::int AS c FROM accreditation_entities
       WHERE COALESCE(balance_payable,0) = 0 AND COALESCE(balance_receivable,0) = 0
         AND COALESCE(balance_amount,0) <> 0`
    );
    if (r.rows[0].c > 0) {
      await pgPool.query(
        `UPDATE accreditation_entities SET
          balance_payable = GREATEST(COALESCE(balance_amount,0), 0),
          balance_receivable = GREATEST(-COALESCE(balance_amount,0), 0)
         WHERE COALESCE(balance_payable,0) = 0 AND COALESCE(balance_receivable,0) = 0 AND COALESCE(balance_amount,0) <> 0`
      );
    }
  } catch (e) {
    console.warn('[DB] accreditation balance buckets:', e.message);
  }
}

async function ensureMemberDirectoryTables() {
  if (!pgPool) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS member_profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      member_user_id TEXT NOT NULL,
      display_name TEXT,
      last_seen_name TEXT,
      total_salary_audited_usd REAL DEFAULT 0,
      deferred_balance_usd REAL DEFAULT 0,
      debt_to_company_usd REAL DEFAULT 0,
      meta_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, member_user_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_member_profiles_uid ON member_profiles(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_member_profiles_member ON member_profiles(user_id, member_user_id)',
    `CREATE TABLE IF NOT EXISTS member_profile_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      member_user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      amount REAL,
      cycle_id INTEGER,
      notes TEXT,
      status TEXT DEFAULT 'done',
      meta_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_member_profile_events_member ON member_profile_events(user_id, member_user_id)',
    'CREATE INDEX IF NOT EXISTS idx_member_profile_events_created ON member_profile_events(user_id, created_at DESC)',
    `CREATE TABLE IF NOT EXISTS member_adjustments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      member_user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      cycle_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP,
      CONSTRAINT member_adjustments_kind_chk CHECK (kind IN ('deduct', 'add', 'reward'))
    )`,
  ];
  for (const s of stmts) {
    try {
      await pgPool.query(s);
    } catch (e) {
      if (!/already exists/i.test(String(e.message))) {
        console.warn('[DB] member directory:', e.message);
      }
    }
  }
}

async function ensureDeferredSalaryLinesTable() {
  if (!pgPool) return;
  await pgPool.query(`CREATE TABLE IF NOT EXISTS deferred_salary_lines (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    cycle_id INTEGER NOT NULL,
    member_user_id TEXT NOT NULL,
    extra_id_c TEXT,
    balance_d REAL NOT NULL DEFAULT 0,
    salary_before_discount REAL,
    sheet_source TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, cycle_id, member_user_id)
  )`);
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_deferred_salary_lines_uid ON deferred_salary_lines(user_id)');
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_deferred_salary_lines_member ON deferred_salary_lines(user_id, member_user_id)');
  try {
    await pgPool.query(`
      INSERT INTO deferred_salary_lines (user_id, cycle_id, member_user_id, extra_id_c, balance_d, sheet_source)
      SELECT fc.user_id, dbu.cycle_id, dbu.member_user_id, dbu.extra_id_c, dbu.balance_d, dbu.sheet_source
      FROM deferred_balance_users dbu
      INNER JOIN financial_cycles fc ON fc.id = dbu.cycle_id
      ON CONFLICT (user_id, cycle_id, member_user_id) DO NOTHING
    `);
  } catch (e) {
    if (!/duplicate key|violates unique constraint/i.test(String(e.message))) {
      console.warn('[DB] deferred_salary_lines backfill:', e.message);
    }
  }
}

async function ensureUserSimpleFinancialTermsColumn() {
  if (!pgPool) return;
  try {
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS use_simple_financial_terms BOOLEAN DEFAULT FALSE');
  } catch (e) {
    if (!/already exists|duplicate column/i.test(String(e.message))) {
      console.warn('[DB] users.use_simple_financial_terms:', e.message);
    }
  }
}

/** مزامنة المؤجل مع المعتمد الرئيسي + جلسة إغلاق التدقيق */
async function ensurePayrollDeferredSyncAndAuditSessionColumns() {
  if (!pgPool) return;
  try {
    await pgPool.query('ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS last_deferred_offset_applied REAL DEFAULT 0');
    await pgPool.query('ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS deferred_sync_baseline_done INTEGER DEFAULT 0');
    await pgPool.query('ALTER TABLE financial_cycles ADD COLUMN IF NOT EXISTS payroll_audit_closed_at TIMESTAMP NULL');
  } catch (e) {
    if (!/already exists|duplicate column/i.test(String(e.message))) {
      console.warn('[DB] payroll deferred sync / audit session:', e.message);
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
    await ensureFundsExcludeDashboardColumn();
    await ensureAccreditationBalanceBuckets();
    await ensureDeferredSalaryLinesTable();
    await ensurePayrollDeferredSyncAndAuditSessionColumns();
    await ensureMemberDirectoryTables();
    await ensureUserSimpleFinancialTermsColumn();
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
