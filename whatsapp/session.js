const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');

const SESSION_DIR = path.join(__dirname, '..', '.wwebjs_auth');

const state = {
  status: 'disconnected',
  qr: null,
  phone: null,
  connectedAt: null,
  lastError: null,
};

function getState() {
  return { ...state };
}

function setStatus(status) {
  state.status = status;
  if (status === 'disconnected' || status === 'auth_failed') {
    state.qr = null;
  }
}

function setQR(qrDataUrl) {
  state.qr = qrDataUrl;
  state.status = 'connecting';
}

function clearQR() {
  state.qr = null;
}

function setConnected(phoneNumber) {
  state.status = 'connected';
  state.phone = phoneNumber;
  state.connectedAt = new Date().toISOString();
  state.qr = null;
  state.lastError = null;

  try {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO whatsapp_sessions (id, phone_number, status, connected_at, updated_at)
      VALUES (1, ?, 'connected', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(phoneNumber || '');
  } catch (err) {
    console.error('[WhatsApp Session] DB save error:', err.message);
  }
}

function setDisconnected() {
  state.status = 'disconnected';
  state.phone = null;
  state.connectedAt = null;
  state.qr = null;

  try {
    const db = getDb();
    db.prepare(`
      UPDATE whatsapp_sessions SET status = 'disconnected', updated_at = CURRENT_TIMESTAMP WHERE id = 1
    `).run();
  } catch (err) {
    console.error('[WhatsApp Session] DB update error:', err.message);
  }
}

function setError(error) {
  state.lastError = error;
}

function hasExistingSession() {
  try {
    return fs.existsSync(SESSION_DIR) &&
      fs.readdirSync(SESSION_DIR).length > 0;
  } catch {
    return false;
  }
}

function clearSessionFiles() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      console.log('[WhatsApp Session] Session files cleared');
    }
  } catch (err) {
    console.error('[WhatsApp Session] Failed to clear session:', err.message);
  }
}

module.exports = {
  getState,
  setStatus,
  setQR,
  clearQR,
  setConnected,
  setDisconnected,
  setError,
  hasExistingSession,
  clearSessionFiles,
  SESSION_DIR,
};
