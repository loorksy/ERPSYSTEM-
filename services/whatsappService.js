const { MessageMedia } = require('whatsapp-web.js');
const clientModule = require('../whatsapp/client');
const session = require('../whatsapp/session');
const handlers = require('../whatsapp/handlers');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');

function formatPhone(phone) {
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.includes('@')) return cleaned;
  if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
  return `${cleaned}@c.us`;
}

function ensureConnected() {
  const state = session.getState();
  if (state.status !== 'connected') {
    return { error: 'واتساب غير متصل' };
  }
  const client = clientModule.getClient();
  if (!client) {
    return { error: 'عميل واتساب غير متوفر' };
  }
  return { client };
}

async function connect(io) {
  const state = session.getState();

  if (state.status === 'connected') {
    return { success: false, message: 'واتساب متصل بالفعل' };
  }

  if (clientModule.getInitializing()) {
    return { success: false, message: 'جاري الاتصال بالفعل...' };
  }

  try {
    session.setStatus('connecting');
    handlers.cancelReconnect();

    if (io) handlers.setIO(io);

    const client = clientModule.createClient();
    handlers.registerHandlers(client);

    await clientModule.initialize();

    return { success: true, message: 'جاري الاتصال...' };
  } catch (err) {
    console.error('[WhatsApp Service] Connect error:', err.message);
    session.setStatus('disconnected');
    session.setError(err.message);
    await clientModule.destroy();
    return { success: false, message: 'حدث خطأ أثناء الاتصال: ' + err.message };
  }
}

async function disconnect() {
  try {
    handlers.cancelReconnect();
    await clientModule.destroy();
    session.setDisconnected();
    return { success: true, message: 'تم قطع الاتصال بنجاح' };
  } catch (err) {
    console.error('[WhatsApp Service] Disconnect error:', err.message);
    return { success: false, message: 'حدث خطأ أثناء قطع الاتصال' };
  }
}

async function sendMessage(phone, message) {
  const { client, error } = ensureConnected();
  if (error) return { success: false, message: error };

  const chatId = formatPhone(phone);

  try {
    const result = await client.sendMessage(chatId, message);
    return {
      success: true,
      message: 'تم إرسال الرسالة بنجاح',
      messageId: result.id?._serialized,
    };
  } catch (err) {
    console.error('[WhatsApp Service] Send message error:', err.message);
    return { success: false, message: 'فشل إرسال الرسالة: ' + err.message };
  }
}

async function sendImage(phone, imagePath, caption = '') {
  const { client, error } = ensureConnected();
  if (error) return { success: false, message: error };

  const chatId = formatPhone(phone);

  try {
    let media;
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      media = await MessageMedia.fromUrl(imagePath, { unsafeMime: true });
    } else {
      const absPath = path.resolve(imagePath);
      if (!fs.existsSync(absPath)) {
        return { success: false, message: 'الملف غير موجود: ' + imagePath };
      }
      media = MessageMedia.fromFilePath(absPath);
    }

    const result = await client.sendMessage(chatId, media, { caption });
    return {
      success: true,
      message: 'تم إرسال الصورة بنجاح',
      messageId: result.id?._serialized,
    };
  } catch (err) {
    console.error('[WhatsApp Service] Send image error:', err.message);
    return { success: false, message: 'فشل إرسال الصورة: ' + err.message };
  }
}

async function sendFile(phone, filePath, caption = '') {
  const { client, error } = ensureConnected();
  if (error) return { success: false, message: error };

  const chatId = formatPhone(phone);

  try {
    let media;
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      media = await MessageMedia.fromUrl(filePath, { unsafeMime: true });
    } else {
      const absPath = path.resolve(filePath);
      if (!fs.existsSync(absPath)) {
        return { success: false, message: 'الملف غير موجود: ' + filePath };
      }
      media = MessageMedia.fromFilePath(absPath);
    }

    const result = await client.sendMessage(chatId, media, {
      caption,
      sendMediaAsDocument: true,
    });
    return {
      success: true,
      message: 'تم إرسال الملف بنجاح',
      messageId: result.id?._serialized,
    };
  } catch (err) {
    console.error('[WhatsApp Service] Send file error:', err.message);
    return { success: false, message: 'فشل إرسال الملف: ' + err.message };
  }
}

function getStatus() {
  const state = session.getState();
  return {
    status: state.status,
    phone: state.phone,
    connectedAt: state.connectedAt,
    qr: state.qr,
    hasSession: session.hasExistingSession(),
    lastError: state.lastError,
  };
}

async function restart(io) {
  console.log('[WhatsApp Service] Restarting...');
  await disconnect();

  await new Promise(resolve => setTimeout(resolve, 2000));

  return connect(io);
}

module.exports = {
  connect,
  disconnect,
  sendMessage,
  sendImage,
  sendFile,
  getStatus,
  restart,
};
