const express = require('express');
const { randomUUID } = require('crypto');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb, runTransaction } = require('../db/database');
const { settleOpenPayablesFifo, sumOpenPayables } = require('../services/entityPayablesService');
const { adjustFundBalance, getMainFundId, getMainFundUsdBalance, ensureDefaultMainFund } = require('../services/fundService');
const { labelFundLedgerType, movementColorCategory } = require('../services/accountingLabelsAr');
const { enrichFundLedgerDisplayNotes } = require('../services/fundLedgerNotes');
const { canCancelFundLedgerRow, cancelFundLedgerMovement } = require('../services/ledgerCancelService');

router.get('/transfer-companies/list', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query(
      'SELECT id, name FROM transfer_companies WHERE user_id = $1 ORDER BY name',
      [req.session.userId]
    )).rows;
    res.json({ success: true, list: rows });
  } catch (e) {
    res.json({ success: false, list: [], message: e.message });
  }
});

router.post('/update-main', requireAuth, async (req, res) => {
  try {
    const { name, fundNumber } = req.body || {};
    const db = getDb();
    const uid = req.session.userId;
    await ensureDefaultMainFund(db, uid);
    const main = (await db.query('SELECT id FROM funds WHERE user_id = $1 AND is_main = 1 LIMIT 1', [uid])).rows[0];
    if (!main) return res.json({ success: false, message: 'لا يوجد صندوق رئيسي' });
    const updates = [];
    const params = [];
    let idx = 1;
    if (name != null && String(name).trim()) {
      updates.push(`name = $${idx++}`);
      params.push(String(name).trim());
    }
    if (fundNumber !== undefined) {
      updates.push(`fund_number = $${idx++}`);
      params.push(fundNumber ? String(fundNumber).trim() : null);
    }
    if (updates.length === 0) return res.json({ success: false, message: 'لا توجد بيانات للتحديث' });
    params.push(main.id);
    await db.query(`UPDATE funds SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    res.json({ success: true, message: 'تم تحديث الصندوق الرئيسي' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.get('/list', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    await ensureDefaultMainFund(db, req.session.userId);
    const uid = req.session.userId;
    const forAccTransfer = String(req.query.forAccreditationTransfer || '') === '1';
    let fundWhere = 'user_id = $1';
    if (forAccTransfer) {
      fundWhere +=
        ' AND COALESCE(is_main,0) = 0 AND COALESCE(exclude_from_dashboard,0) = 0 AND TRIM(name) <> \'صندوق الربح\'';
    }
    const rows = (await db.query(
      `SELECT id, name, fund_number, country, region_syria, is_main, transfer_company_id, created_at, exclude_from_dashboard
       FROM funds WHERE ${fundWhere} ORDER BY is_main DESC, name`,
      [uid]
    )).rows;
    const payRows = (await db.query(
      `SELECT entity_id, COALESCE(SUM(amount), 0)::float AS t
       FROM entity_payables
       WHERE user_id = $1 AND entity_type = 'fund' AND amount > 0.0001
       GROUP BY entity_id`,
      [uid]
    )).rows;
    const payMap = {};
    payRows.forEach((r) => { payMap[r.entity_id] = r.t; });
    const list = [];
    for (const f of rows) {
      const bals = (await db.query('SELECT currency, amount FROM fund_balances WHERE fund_id = $1', [f.id])).rows;
      list.push({ ...f, balances: bals, openPayablesUsd: payMap[f.id] || 0 });
    }
    res.json({ success: true, funds: list });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', funds: [] });
  }
});

router.post('/add', requireAuth, async (req, res) => {
  try {
    const {
      name, fundNumber, transferCompanyId, country, regionSyria,
      referenceBalances,
    } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'اسم الصندوق مطلوب' });
    const db = getDb();
    const tc = transferCompanyId ? parseInt(transferCompanyId, 10) : null;
    const r = await db.query(
      `INSERT INTO funds (user_id, name, fund_number, transfer_company_id, country, region_syria, is_main)
       VALUES ($1, $2, $3, $4, $5, $6, 0)`,
      [req.session.userId, String(name).trim(), fundNumber || null, tc || null, country || null, regionSyria || null]
    );
    const fundId = r.lastInsertRowid;
    const refs = Array.isArray(referenceBalances) ? referenceBalances : [];
    if (refs.length === 0) {
      await db.query(
        `INSERT INTO fund_balances (fund_id, currency, amount) VALUES ($1, 'USD', 0)
         ON CONFLICT (fund_id, currency) DO NOTHING`,
        [fundId]
      );
    } else {
      for (const rb of refs) {
        const cur = (rb.currency || 'USD').trim();
        const amt = parseFloat(rb.amount);
        if (!cur || isNaN(amt)) continue;
        await db.query(
          `INSERT INTO fund_balances (fund_id, currency, amount) VALUES ($1, $2, $3)
           ON CONFLICT (fund_id, currency) DO UPDATE SET amount = fund_balances.amount + $3`,
          [fundId, cur, amt]
        );
        await db.query(
          `INSERT INTO fund_ledger (fund_id, type, amount, currency, notes)
           VALUES ($1, 'opening_reference', $2, $3, $4)`,
          [fundId, amt, cur, 'رصيد مرجعي افتتاحي']
        );
      }
    }
    res.json({ success: true, message: 'تم إنشاء الصندوق', id: fundId });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const f = (await db.query(
      'SELECT * FROM funds WHERE id = $1 AND user_id = $2',
      [id, req.session.userId]
    )).rows[0];
    if (!f) return res.json({ success: false, message: 'غير موجود' });
    const bals = (await db.query('SELECT currency, amount FROM fund_balances WHERE fund_id = $1', [id])).rows;
    const ledgerRaw = (await db.query(
      'SELECT * FROM fund_ledger WHERE fund_id = $1 ORDER BY created_at DESC LIMIT 200',
      [id]
    )).rows;
    const ledger = await enrichFundLedgerDisplayNotes(db, req.session.userId, ledgerRaw);
    const chron = [...ledger].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    let runUsd = 0;
    chron.forEach((l) => {
      if ((l.currency || 'USD') === 'USD') runUsd += Number(l.amount) || 0;
      l.balanceAfterUsd = runUsd;
      l.labelAr = labelFundLedgerType(l.type);
      l.colorCategory = movementColorCategory({ fundLedgerType: l.type, amount: l.amount });
      l.canCancel = canCancelFundLedgerRow(l);
    });
    const openPayablesUsd = await sumOpenPayables(db, req.session.userId, 'fund', id);
    res.json({ success: true, fund: f, balances: bals, ledger, openPayablesUsd });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.post('/:id/set-main', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const ok = (await db.query('SELECT id FROM funds WHERE id = $1 AND user_id = $2', [id, req.session.userId])).rows[0];
    if (!ok) return res.json({ success: false, message: 'غير موجود' });
    await db.query('UPDATE funds SET is_main = 0 WHERE user_id = $1', [req.session.userId]);
    await db.query('UPDATE funds SET is_main = 1 WHERE id = $1', [id]);
    res.json({ success: true, message: 'تم تعيين الصندوق الرئيسي' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** إيداع من الصندوق الرئيسي إلى هذا الصندوق (صرف للصندوق) أو تسجيل دين علينا */
router.post('/:id/receive-from-main', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, notes, mode, applyToPayables } = req.body || {};
    const amt = parseFloat(amount);
    if (!id || isNaN(amt) || amt <= 0) return res.json({ success: false, message: 'مبلغ غير صالح' });
    const db = getDb();
    const uid = req.session.userId;
    const fund = (await db.query('SELECT id, is_main FROM funds WHERE id = $1 AND user_id = $2', [id, uid])).rows[0];
    if (!fund) return res.json({ success: false, message: 'صندوق غير موجود' });
    if (fund.is_main) return res.json({ success: false, message: 'اختر صندوقاً غير الرئيسي' });

    if (mode === 'payable') {
      await db.query(
        `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes, settlement_mode)
         VALUES ($1, 'fund', $2, $3, 'USD', $4, 'payable')`,
        [uid, id, amt, notes || 'إجراء سريع — دين علينا']
      );
      return res.json({ success: true, message: 'تم تسجيل التزام (دين علينا) على الصندوق' });
    }

    const mainId = await getMainFundId(db, uid);
    if (!mainId) return res.json({ success: false, message: 'لا صندوق رئيسي' });
    const { usd: mainUsd } = await getMainFundUsdBalance(db, uid);
    if ((mainUsd || 0) < amt) {
      return res.json({
        success: false,
        code: 'INSUFFICIENT_MAIN',
        message: 'رصيد الصندوق الرئيسي غير كافٍ. اختر «تسجيل كدين علينا» أو خفّض المبلغ.',
      });
    }

    let payablesSettled = 0;
    let creditPortion = 0;
    await runTransaction(async (client) => {
      const doPayables = applyToPayables !== false;
      if (doPayables) {
        const open = await sumOpenPayables(client, uid, 'fund', id);
        const settleBudget = Math.min(amt, open);
        if (settleBudget > 0) {
          const r = await settleOpenPayablesFifo(client, uid, 'fund', id, settleBudget);
          payablesSettled = r.settled;
        }
      }

      creditPortion = Math.max(0, amt - payablesSettled);
      const groupId = randomUUID();

      await adjustFundBalance(client, mainId, 'USD', -amt, 'fund_allocation', notes || 'تحويل لصندوق', 'funds', id, groupId);
      if (creditPortion > 0) {
        const recvNotes = (notes || 'وارد من الصندوق الرئيسي')
          + (payablesSettled > 0 ? ` (بعد تسوية دين ${payablesSettled.toFixed(2)} $)` : '');
        await adjustFundBalance(
          client,
          id,
          'USD',
          creditPortion,
          'fund_receive_from_main',
          recvNotes,
          'funds',
          mainId,
          groupId
        );
      }
      await client.query(
        `INSERT INTO movement_side_effects (user_id, movement_group_id, payload_json) VALUES ($1, $2, $3)`,
        [
          uid,
          groupId,
          JSON.stringify({
            kind: 'receive_from_main',
            mainFundId: mainId,
            targetFundId: id,
            amount: amt,
            payablesSettled,
            creditedToFund: creditPortion,
            currency: 'USD',
          }),
        ]
      );
    });
    res.json({
      success: true,
      message: payablesSettled > 0
        ? `تم التحويل: تسوية ديون مسجّلة ${payablesSettled.toFixed(2)} $` + (creditPortion > 0 ? `، وإيداع ${creditPortion.toFixed(2)} $ في الصندوق` : '')
        : 'تم التحويل إلى الصندوق',
      payablesSettled,
      creditedToFund: creditPortion,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.post('/:id/transfer', requireAuth, async (req, res) => {
  try {
    const fromId = parseInt(req.params.id, 10);
    const { toFundId, amount, currency, notes } = req.body || {};
    const toId = parseInt(toFundId, 10);
    const amt = parseFloat(amount);
    if (!fromId || !toId || fromId === toId || isNaN(amt) || amt <= 0) {
      return res.json({ success: false, message: 'بيانات صحيحة مطلوبة' });
    }
    const cur = (currency || 'USD').trim();
    const db = getDb();
    const u = req.session.userId;
    const a = (await db.query('SELECT id FROM funds WHERE id = $1 AND user_id = $2', [fromId, u])).rows[0];
    const b = (await db.query('SELECT id FROM funds WHERE id = $1 AND user_id = $2', [toId, u])).rows[0];
    if (!a || !b) return res.json({ success: false, message: 'صندوق غير صالح' });
    await runTransaction(async (client) => {
      const insFt = await client.query(
        `INSERT INTO fund_transfers (from_fund_id, to_fund_id, amount, currency, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [fromId, toId, amt, cur, notes || null]
      );
      const ftId = insFt.rows[0].id;
      const groupId = randomUUID();
      await adjustFundBalance(client, fromId, cur, -amt, 'transfer_out', notes || 'ترحيل لصندوق آخر', 'fund_transfers', ftId, groupId);
      await adjustFundBalance(client, toId, cur, amt, 'transfer_in', notes || 'وارد من صندوق', 'fund_transfers', ftId, groupId);
      await client.query(
        `INSERT INTO movement_side_effects (user_id, movement_group_id, payload_json) VALUES ($1, $2, $3)`,
        [
          u,
          groupId,
          JSON.stringify({
            kind: 'fund_transfer',
            fundTransferId: ftId,
            fromFundId: fromId,
            toFundId: toId,
            amount: amt,
            currency: cur,
            payablesSettled: 0,
          }),
        ]
      );
    });
    res.json({ success: true, message: 'تم الترحيل' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

/** إلغاء حركة من دفتر الصندوق (استرجاع الأرصدة والالتزامات حسب نوع الحركة) */
router.post('/:id/ledger/:ledgerId/cancel', requireAuth, async (req, res) => {
  try {
    const fundId = parseInt(req.params.id, 10);
    const ledgerId = parseInt(req.params.ledgerId, 10);
    if (!fundId || !ledgerId) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const row = (await db.query('SELECT fund_id FROM fund_ledger WHERE id = $1', [ledgerId])).rows[0];
    if (!row || row.fund_id !== fundId) {
      return res.json({ success: false, message: 'الحركة لا تنتمي لهذا الصندوق' });
    }
    await cancelFundLedgerMovement(db, req.session.userId, ledgerId);
    res.json({ success: true, message: 'تم إلغاء التحويل واسترجاع الحسابات' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإلغاء' });
  }
});

module.exports = router;
