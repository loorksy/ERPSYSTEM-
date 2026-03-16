const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'lorkerp.db');

let innerDb = null;

function saveDb() {
  if (!innerDb) return;
  try {
    const data = innerDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    console.error('[DB] Save error:', err.message);
  }
}

function wrapStmt(sql) {
  return {
    run(...params) {
      const stmt = innerDb.prepare(sql);
      try {
        if (params.length) stmt.bind(params);
        stmt.step();
        stmt.free();
        const idStmt = innerDb.prepare('SELECT last_insert_rowid() as id');
        idStmt.step();
        const id = idStmt.get()[0];
        idStmt.free();
        saveDb();
        return { lastInsertRowid: id };
      } catch (e) {
        try { stmt.free(); } catch (_) {}
        throw e;
      }
    },
    get(...params) {
      const stmt = innerDb.prepare(sql);
      try {
        if (params.length) stmt.bind(params);
        const hasRow = stmt.step();
        const row = hasRow ? stmt.getAsObject() : undefined;
        stmt.free();
        return row;
      } catch (e) {
        try { stmt.free(); } catch (_) {}
        throw e;
      }
    },
    all(...params) {
      const stmt = innerDb.prepare(sql);
      try {
        if (params.length) stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      } catch (e) {
        try { stmt.free(); } catch (_) {}
        throw e;
      }
    },
  };
}

function getDb() {
  if (!innerDb) throw new Error('Database not initialized. Call initDatabase() first.');
  return {
    exec(sql) {
      innerDb.run(sql);
      saveDb();
    },
    prepare(sql) {
      return wrapStmt(sql);
    },
  };
}

async function initDatabase() {
  if (innerDb) return getDb();

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    innerDb = new SQL.Database(new Uint8Array(buf));
  } else {
    innerDb = new SQL.Database();
  }

  innerDb.run('PRAGMA journal_mode = WAL');
  innerDb.run('PRAGMA foreign_keys = ON');

  innerDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      avatar TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_data TEXT,
      phone_number TEXT,
      status TEXT DEFAULT 'disconnected',
      connected_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      selected_model TEXT,
      models_cache TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS message_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input_text TEXT,
      output_table TEXT,
      provider TEXT,
      model TEXT,
      chunks_count INTEGER DEFAULT 1,
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS analysis_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      progress_current INTEGER DEFAULT 0,
      progress_total INTEGER DEFAULT 0,
      output_table TEXT,
      provider TEXT,
      model TEXT,
      chunks_count INTEGER DEFAULT 0,
      error_message TEXT,
      exported_to_sheets INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS google_sheets_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spreadsheet_id TEXT,
      credentials TEXT,
      token TEXT,
      sync_enabled INTEGER DEFAULT 0,
      last_sync DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS financial_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      management_data TEXT,
      agent_data TEXT,
      management_spreadsheet_id TEXT,
      management_sheet_name TEXT,
      agent_spreadsheet_id TEXT,
      agent_sheet_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payroll_settings (
      user_id INTEGER PRIMARY KEY,
      discount_rate REAL DEFAULT 0,
      agent_color TEXT DEFAULT '#3b82f6',
      management_color TEXT DEFAULT '#10b981',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  saveDb();

  try {
    innerDb.run('ALTER TABLE analysis_jobs ADD COLUMN exported_to_sheets INTEGER DEFAULT 0');
    saveDb();
  } catch (_) {}
  try { innerDb.run('ALTER TABLE financial_cycles ADD COLUMN management_spreadsheet_id TEXT'); saveDb(); } catch (_) {}
  try { innerDb.run('ALTER TABLE financial_cycles ADD COLUMN management_sheet_name TEXT'); saveDb(); } catch (_) {}
  try { innerDb.run('ALTER TABLE financial_cycles ADD COLUMN agent_spreadsheet_id TEXT'); saveDb(); } catch (_) {}
  try { innerDb.run('ALTER TABLE financial_cycles ADD COLUMN agent_sheet_name TEXT'); saveDb(); } catch (_) {}

  const adminUser = wrapStmt('SELECT * FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');
  if (!adminUser || !adminUser.username) {
    const hashedPassword = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    wrapStmt('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)').run(
      process.env.ADMIN_USERNAME || 'admin',
      hashedPassword,
      'مدير النظام',
      'admin'
    );
  }

  return getDb();
}

module.exports = { getDb, initDatabase };
