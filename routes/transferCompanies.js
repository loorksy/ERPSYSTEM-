const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');

const DEFAULT_TYPES = ['شام كاش', 'هرم', 'فؤاد', 'USDT', 'سرياتيل كاش', 'العالمية'];

router.get('/list', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query(
      `SELECT id, name, country, region_syria, balance_amount, balance_currency, transfer_types, created_at
       FROM transfer_companies WHERE user_id = $1 ORDER BY name`,
      [req.session.userId]
    )).rows;
    const list = rows.map((r) => ({
      ...r,
      transfer_types: r.transfer_types ? (() => { try { return JSON.parse(r.transfer_types); } catch (_) { return []; } })() : [],
    }));
    res.json({ success: true, companies: list, defaultTransferTypes: DEFAULT_TYPES });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', companies: [] });
  }
});

router.post('/add', requireAuth, async (req, res) => {
  try {
    const {
      name, country, regionSyria, balanceAmount, balanceCurrency, transferTypes,
    } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'الاسم مطلوب' });
    const db = getDb();
    const typesJson = JSON.stringify(Array.isArray(transferTypes) ? transferTypes : []);
    const bal = parseFloat(balanceAmount) || 0;
    const cur = (balanceCurrency || 'USD').trim();
    const r = await db.query(
      `INSERT INTO transfer_companies (user_id, name, country, region_syria, balance_amount, balance_currency, transfer_types)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.session.userId, String(name).trim(), country || null, regionSyria || null, bal, cur, typesJson]
    );
    const id = r.lastInsertRowid;
    if (id && bal !== 0) {
      await db.query(
        `INSERT INTO transfer_company_ledger (company_id, amount, currency, notes) VALUES ($1, $2, $3, $4)`,
        [id, bal, cur, 'رصيد افتتاحي']
      );
    }
    res.json({ success: true, message: 'تمت الإضافة', id });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const row = (await db.query(
      'SELECT * FROM transfer_companies WHERE id = $1 AND user_id = $2',
      [id, req.session.userId]
    )).rows[0];
    if (!row) return res.json({ success: false, message: 'غير موجود' });
    const tx = (await db.query(
      'SELECT * FROM transfer_company_ledger WHERE company_id = $1 ORDER BY created_at DESC LIMIT 300',
      [id]
    )).rows;
    let types = [];
    try {
      types = row.transfer_types ? JSON.parse(row.transfer_types) : [];
    } catch (_) {}
    res.json({ success: true, company: { ...row, transfer_types: types }, ledger: tx });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
