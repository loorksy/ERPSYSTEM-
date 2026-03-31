const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { adjustFundBalance, getMainFundId, getMainFundUsdBalance } = require('../services/fundService');
const { settleOpenPayablesFifo, sumOpenPayables } = require('../services/entityPayablesService');

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

/** صرف من الصندوق الرئيسي إلى شركة (زيادة رصيد الشركة) أو تسجيل دين علينا */
router.post('/:id/payout-from-main', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, notes, mode, applyToPayables } = req.body || {};
    const amt = parseFloat(amount);
    if (!id || isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const db = getDb();
    const uid = req.session.userId;
    const company = (await db.query(
      'SELECT id FROM transfer_companies WHERE id = $1 AND user_id = $2',
      [id, uid]
    )).rows[0];
    if (!company) return res.json({ success: false, message: 'شركة غير موجودة' });

    if (mode === 'payable') {
      await db.query(
        `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes, settlement_mode)
         VALUES ($1, 'transfer_company', $2, $3, 'USD', $4, 'payable')`,
        [uid, id, amt, notes || 'إجراء سريع — دين علينا']
      );
      return res.json({ success: true, message: 'تم تسجيل التزام (دين علينا) على الشركة' });
    }

    const mainId = await getMainFundId(db, uid);
    if (!mainId) return res.json({ success: false, message: 'عيّن صندوقاً رئيسياً أولاً' });
    const { usd: mainUsd } = await getMainFundUsdBalance(db, uid);
    if ((mainUsd || 0) < amt) {
      return res.json({
        success: false,
        code: 'INSUFFICIENT_MAIN',
        message: 'رصيد الصندوق الرئيسي غير كافٍ. اختر «تسجيل كدين علينا» أو خفّض المبلغ.',
      });
    }

    let payablesSettled = 0;
    const doPayables = applyToPayables !== false;
    if (doPayables) {
      const open = await sumOpenPayables(db, uid, 'transfer_company', id);
      const settleBudget = Math.min(amt, open);
      if (settleBudget > 0) {
        const r = await settleOpenPayablesFifo(db, uid, 'transfer_company', id, settleBudget);
        payablesSettled = r.settled;
      }
    }

    const cashPortion = Math.max(0, amt - payablesSettled);

    await adjustFundBalance(db, mainId, 'USD', -amt, 'company_payout', notes || 'صرف لشركة تحويل', 'transfer_companies', id);
    if (cashPortion > 0) {
      const ledNotes = (notes || 'صرف من الصندوق الرئيسي') + (payablesSettled > 0 ? ` (بعد تسوية دين ${payablesSettled.toFixed(2)} $)` : '');
      await db.query(
        `INSERT INTO transfer_company_ledger (company_id, amount, currency, notes) VALUES ($1, $2, 'USD', $3)`,
        [id, cashPortion, ledNotes]
      );
      await db.query(
        `UPDATE transfer_companies SET balance_amount = balance_amount + $1 WHERE id = $2 AND user_id = $3`,
        [cashPortion, id, uid]
      );
    }
    res.json({
      success: true,
      message: payablesSettled > 0
        ? `تم الصرف: تسوية ديون مسجّلة ${payablesSettled.toFixed(2)} $` + (cashPortion > 0 ? `، وإيداع ${cashPortion.toFixed(2)} $ لرصيد الشركة` : '')
        : 'تم الصرف من الصندوق الرئيسي',
      payablesSettled,
      cashToCompany: cashPortion,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** إضافة رصيد «دين لنا» لدى شركة التحويل */
router.post('/:id/add-receivable', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, currency, notes } = req.body || {};
    const amt = parseFloat(amount);
    if (!id || isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const cur = (currency || 'USD').trim();
    const db = getDb();
    const uid = req.session.userId;
    const company = (await db.query(
      'SELECT id FROM transfer_companies WHERE id = $1 AND user_id = $2',
      [id, uid]
    )).rows[0];
    if (!company) return res.json({ success: false, message: 'شركة غير موجودة' });
    const noteText = (notes && String(notes).trim()) ? String(notes).trim() : 'إضافة دين لنا';
    await db.query(
      `INSERT INTO transfer_company_ledger (company_id, amount, currency, notes) VALUES ($1, $2, $3, $4)`,
      [id, amt, cur, noteText]
    );
    await db.query(
      `UPDATE transfer_companies SET balance_amount = balance_amount + $1, balance_currency = $2 WHERE id = $3 AND user_id = $4`,
      [amt, cur, id, uid]
    );
    res.json({ success: true, message: 'تم تسجيل دين لنا' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const uid = req.session.userId;
    const row = (await db.query(
      'SELECT * FROM transfer_companies WHERE id = $1 AND user_id = $2',
      [id, uid]
    )).rows[0];
    if (!row) return res.json({ success: false, message: 'غير موجود' });
    const tx = (await db.query(
      'SELECT * FROM transfer_company_ledger WHERE company_id = $1 ORDER BY created_at DESC LIMIT 300',
      [id]
    )).rows;
    const chron = [...tx].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    let runUsd = 0;
    chron.forEach((l) => {
      if ((l.currency || 'USD') === 'USD') runUsd += Number(l.amount) || 0;
      l.balanceAfterUsd = runUsd;
      const n = String(l.notes || '');
      if (/دين لنا|إضافة دين/i.test(n)) l.labelAr = 'دين لنا';
      else if (/صرف من الصندوق|صرف لشركة/i.test(n)) l.labelAr = 'صرف من الرئيسي';
      else if (/رصيد افتتاحي/i.test(n)) l.labelAr = 'رصيد افتتاحي';
      else if (/استيراد|معتمد|اعتماد/i.test(n)) l.labelAr = 'من الاعتمادات';
      else l.labelAr = 'حركة';
      l.colorCategory = Number(l.amount) >= 0 ? 'balance' : 'payout';
    });
    let types = [];
    try {
      types = row.transfer_types ? JSON.parse(row.transfer_types) : [];
    } catch (_) {}
    const openPayablesUsd = await sumOpenPayables(db, uid, 'transfer_company', id);
    res.json({ success: true, company: { ...row, transfer_types: types }, ledger: tx, openPayablesUsd });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
