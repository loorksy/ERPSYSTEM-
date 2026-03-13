const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');

module.exports = function(io) {
  let whatsappClient = null;
  let whatsappStatus = 'disconnected';
  let currentQR = null;

  router.get('/', requireAuth, (req, res) => {
    res.render('dashboard', {
      title: 'ربط واتساب',
      page: 'whatsapp',
      user: req.session.user,
      whatsappStatus
    });
  });

  router.get('/status', requireAuth, (req, res) => {
    res.json({
      status: whatsappStatus,
      qr: currentQR
    });
  });

  router.post('/connect', requireAuth, async (req, res) => {
    try {
      if (whatsappStatus === 'connected') {
        return res.json({ success: false, message: 'واتساب متصل بالفعل' });
      }

      whatsappStatus = 'connecting';
      io.emit('whatsapp-status', { status: 'connecting' });

      const { Client, LocalAuth } = require('whatsapp-web.js');

      whatsappClient = new Client({
        authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
        puppeteer: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
      });

      whatsappClient.on('qr', (qr) => {
        const QRCode = require('qrcode');
        QRCode.toDataURL(qr, (err, url) => {
          if (!err) {
            currentQR = url;
            io.emit('whatsapp-qr', { qr: url });
          }
        });
      });

      whatsappClient.on('ready', () => {
        whatsappStatus = 'connected';
        currentQR = null;
        const info = whatsappClient.info;
        io.emit('whatsapp-status', {
          status: 'connected',
          phone: info?.wid?.user || 'غير معروف'
        });

        const db = getDb();
        db.prepare(`
          INSERT OR REPLACE INTO whatsapp_sessions (id, phone_number, status, connected_at, updated_at)
          VALUES (1, ?, 'connected', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(info?.wid?.user || '');
      });

      whatsappClient.on('disconnected', () => {
        whatsappStatus = 'disconnected';
        currentQR = null;
        whatsappClient = null;
        io.emit('whatsapp-status', { status: 'disconnected' });
      });

      whatsappClient.on('auth_failure', () => {
        whatsappStatus = 'auth_failed';
        currentQR = null;
        io.emit('whatsapp-status', { status: 'auth_failed' });
      });

      await whatsappClient.initialize();
      res.json({ success: true, message: 'جاري الاتصال...' });
    } catch (error) {
      console.error('WhatsApp connection error:', error);
      whatsappStatus = 'error';
      res.json({ success: false, message: 'حدث خطأ أثناء الاتصال' });
    }
  });

  router.post('/disconnect', requireAuth, async (req, res) => {
    try {
      if (whatsappClient) {
        await whatsappClient.destroy();
        whatsappClient = null;
      }
      whatsappStatus = 'disconnected';
      currentQR = null;
      io.emit('whatsapp-status', { status: 'disconnected' });
      res.json({ success: true, message: 'تم قطع الاتصال' });
    } catch (error) {
      res.json({ success: false, message: 'حدث خطأ أثناء قطع الاتصال' });
    }
  });

  router.post('/send', requireAuth, async (req, res) => {
    try {
      if (!whatsappClient || whatsappStatus !== 'connected') {
        return res.json({ success: false, message: 'واتساب غير متصل' });
      }
      const { phone, message } = req.body;
      const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
      await whatsappClient.sendMessage(chatId, message);
      res.json({ success: true, message: 'تم إرسال الرسالة بنجاح' });
    } catch (error) {
      res.json({ success: false, message: 'فشل إرسال الرسالة' });
    }
  });

  return router;
};
