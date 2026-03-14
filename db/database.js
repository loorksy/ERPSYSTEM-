const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'lorkerp.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDatabase() {
  const db = getDb();

  db.exec(`
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

    CREATE TABLE IF NOT EXISTS google_sheets_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spreadsheet_id TEXT,
      credentials TEXT,
      token TEXT,
      sync_enabled INTEGER DEFAULT 0,
      last_sync DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const adminUser = db.prepare('SELECT * FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');
  if (!adminUser) {
    const hashedPassword = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    db.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)').run(
      process.env.ADMIN_USERNAME || 'admin',
      hashedPassword,
      'مدير النظام',
      'admin'
    );
  }

  return db;
}

module.exports = { getDb, initDatabase };
