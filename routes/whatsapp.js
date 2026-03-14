const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const whatsappService = require('../services/whatsappService');

const uploadDir = path.join(__dirname, '..', 'uploads', 'whatsapp');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 16 * 1024 * 1024 },
});

module.exports = function (io) {

  router.get('/', requireAuth, (req, res) => {
    const status = whatsappService.getStatus();
    res.render('dashboard', {
      title: 'ربط واتساب',
      page: 'whatsapp',
      user: req.session.user,
      whatsappStatus: status.status,
    });
  });

  router.get('/status', requireAuth, (req, res) => {
    res.json(whatsappService.getStatus());
  });

  router.get('/qr', requireAuth, (req, res) => {
    const status = whatsappService.getStatus();
    res.json({
      success: !!status.qr,
      qr: status.qr,
      status: status.status,
    });
  });

  router.post('/connect', requireAuth, async (req, res) => {
    try {
      const result = await whatsappService.connect(io);
      res.json(result);
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  router.post('/disconnect', requireAuth, async (req, res) => {
    try {
      const result = await whatsappService.disconnect();
      io.emit('whatsapp-status', { status: 'disconnected' });
      res.json(result);
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  router.post('/restart', requireAuth, async (req, res) => {
    try {
      const result = await whatsappService.restart(io);
      res.json(result);
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  router.post('/send', requireAuth, async (req, res) => {
    try {
      const { phone, message } = req.body;
      if (!phone || !message) {
        return res.json({ success: false, message: 'رقم الهاتف والرسالة مطلوبان' });
      }
      const result = await whatsappService.sendMessage(phone, message);
      res.json(result);
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  router.post('/send-image', requireAuth, upload.single('image'), async (req, res) => {
    try {
      const { phone, caption } = req.body;
      if (!phone || !req.file) {
        return res.json({ success: false, message: 'رقم الهاتف والصورة مطلوبان' });
      }
      const result = await whatsappService.sendImage(phone, req.file.path, caption || '');
      try { fs.unlinkSync(req.file.path); } catch {}
      res.json(result);
    } catch (err) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      res.json({ success: false, message: err.message });
    }
  });

  router.post('/send-file', requireAuth, upload.single('file'), async (req, res) => {
    try {
      const { phone, caption } = req.body;
      if (!phone || !req.file) {
        return res.json({ success: false, message: 'رقم الهاتف والملف مطلوبان' });
      }
      const result = await whatsappService.sendFile(phone, req.file.path, caption || '');
      try { fs.unlinkSync(req.file.path); } catch {}
      res.json(result);
    } catch (err) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      res.json({ success: false, message: err.message });
    }
  });

  return router;
};
