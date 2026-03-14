const QRCode = require('qrcode');
const session = require('./session');
const clientModule = require('./client');

let io = null;
let reconnectTimer = null;

const RECONNECT_DELAY_MS = 10000;
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectAttempts = 0;

function setIO(socketIO) {
  io = socketIO;
}

function emit(event, data) {
  if (io) {
    io.emit(event, data);
  }
}

function registerHandlers(client) {
  client.on('qr', handleQR);
  client.on('ready', handleReady);
  client.on('authenticated', handleAuthenticated);
  client.on('auth_failure', handleAuthFailure);
  client.on('disconnected', handleDisconnected);
  client.on('message', handleMessage);
  client.on('loading_screen', handleLoadingScreen);

  console.log('[WhatsApp] Event handlers registered');
}

function handleQR(qr) {
  console.log('[WhatsApp] QR code received');
  session.setStatus('connecting');

  QRCode.toDataURL(qr, { width: 300, margin: 2 }, (err, url) => {
    if (err) {
      console.error('[WhatsApp] QR generation error:', err.message);
      return;
    }
    session.setQR(url);
    emit('whatsapp-qr', { qr: url });
    emit('whatsapp-status', { status: 'connecting' });
  });
}

function handleReady() {
  const client = clientModule.getClient();
  const phone = client?.info?.wid?.user || null;

  console.log('[WhatsApp] Client ready. Phone:', phone || 'unknown');
  reconnectAttempts = 0;

  session.setConnected(phone);
  emit('whatsapp-status', {
    status: 'connected',
    phone: phone || 'غير معروف',
  });
}

function handleAuthenticated() {
  console.log('[WhatsApp] Authenticated successfully');
  session.clearQR();
}

function handleAuthFailure(msg) {
  console.error('[WhatsApp] Authentication failure:', msg);

  session.setStatus('auth_failed');
  session.setError(msg);
  session.clearSessionFiles();

  emit('whatsapp-status', { status: 'auth_failed', error: String(msg) });
}

async function handleDisconnected(reason) {
  console.warn('[WhatsApp] Disconnected. Reason:', reason);

  session.setDisconnected();
  emit('whatsapp-status', { status: 'disconnected', reason });

  await clientModule.destroy();

  if (reason !== 'LOGOUT' && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    scheduleReconnect();
  }
}

function handleMessage(msg) {
  if (msg.fromMe) return;

  console.log(`[WhatsApp] Message from ${msg.from}: ${msg.body?.substring(0, 50) || '(media)'}`);

  emit('whatsapp-message', {
    from: msg.from,
    body: msg.body,
    timestamp: msg.timestamp,
    type: msg.type,
    hasMedia: msg.hasMedia,
  });
}

function handleLoadingScreen(percent, message) {
  console.log(`[WhatsApp] Loading: ${percent}% - ${message}`);
  emit('whatsapp-loading', { percent, message });
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * reconnectAttempts;

  console.log(`[WhatsApp] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s`);

  emit('whatsapp-status', {
    status: 'reconnecting',
    attempt: reconnectAttempts,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
  });

  reconnectTimer = setTimeout(async () => {
    try {
      console.log('[WhatsApp] Attempting reconnection...');
      const client = clientModule.createClient();
      registerHandlers(client);
      await clientModule.initialize();
    } catch (err) {
      console.error('[WhatsApp] Reconnection failed:', err.message);
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        scheduleReconnect();
      } else {
        console.error('[WhatsApp] Max reconnect attempts reached');
        emit('whatsapp-status', { status: 'disconnected', error: 'فشل إعادة الاتصال' });
      }
    }
  }, delay);
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
}

module.exports = {
  setIO,
  registerHandlers,
  cancelReconnect,
};
