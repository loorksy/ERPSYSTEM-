const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');

router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const config = db.prepare('SELECT * FROM google_sheets_config WHERE id = 1').get();
  res.render('dashboard', {
    title: 'مزامنة Google Sheets',
    page: 'sheets',
    user: req.session.user,
    sheetsConfig: config || null
  });
});

router.post('/configure', requireAuth, (req, res) => {
  try {
    const { spreadsheet_id, client_id, client_secret } = req.body;
    const db = getDb();

    db.prepare(`
      INSERT OR REPLACE INTO google_sheets_config (id, spreadsheet_id, credentials, updated_at)
      VALUES (1, ?, ?, CURRENT_TIMESTAMP)
    `).run(spreadsheet_id, JSON.stringify({ client_id, client_secret }));

    res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح' });
  } catch (error) {
    res.json({ success: false, message: 'حدث خطأ أثناء حفظ الإعدادات' });
  }
});

router.post('/toggle-sync', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const config = db.prepare('SELECT * FROM google_sheets_config WHERE id = 1').get();
    if (!config) {
      return res.json({ success: false, message: 'يرجى إعداد Google Sheets أولاً' });
    }
    const newState = config.sync_enabled ? 0 : 1;
    db.prepare('UPDATE google_sheets_config SET sync_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(newState);
    res.json({ success: true, enabled: !!newState, message: newState ? 'تم تفعيل المزامنة' : 'تم إيقاف المزامنة' });
  } catch (error) {
    res.json({ success: false, message: 'حدث خطأ' });
  }
});

router.get('/auth', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const config = db.prepare('SELECT * FROM google_sheets_config WHERE id = 1').get();
    if (!config || !config.credentials) {
      return res.redirect('/sheets?error=no_config');
    }

    const { google } = require('googleapis');
    const creds = JSON.parse(config.credentials);
    const oauth2Client = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/sheets/callback'
    );

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/spreadsheets']
    });

    res.redirect(authUrl);
  } catch (error) {
    res.redirect('/sheets?error=auth_failed');
  }
});

router.get('/callback', requireAuth, async (req, res) => {
  try {
    const { code } = req.query;
    const db = getDb();
    const config = db.prepare('SELECT * FROM google_sheets_config WHERE id = 1').get();

    const { google } = require('googleapis');
    const creds = JSON.parse(config.credentials);
    const oauth2Client = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/sheets/callback'
    );

    const { tokens } = await oauth2Client.getToken(code);
    db.prepare('UPDATE google_sheets_config SET token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(JSON.stringify(tokens));

    res.redirect('/sheets?success=connected');
  } catch (error) {
    res.redirect('/sheets?error=callback_failed');
  }
});

module.exports = router;
