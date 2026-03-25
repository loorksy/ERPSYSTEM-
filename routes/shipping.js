const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { registerShippingForAgency } = require('./subAgencies');
const { applyBuy, applySell } = require('../services/shippingInventoryService');
const { creditShippingCashSale, debitShippingCashBuy, adjustFundBalance, getMainFundId } = require('../services/fundService');
const { insertLedgerEntry } = require('../services/ledgerService');

/** المبلغ المدخل في الحقل = إجمالي قيمة الكمية (ليس سعر الوحدة) */
function lineTotalFromBody(unitPriceField) {
  const v = parseFloat(unitPriceField);
  return isNaN(v) || v < 0 ? NaN : v;
}

// جلب الرصيد: رصيد الذهب = إجمالي الشراء ذهب - إجمالي البيع ذهب
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query(`
      SELECT type, item_type, SUM(quantity) as sum_qty
      FROM shipping_transactions
      GROUP BY type, item_type
    `)).rows;
    let goldBalance = 0;
    let crystalBalance = 0;
    rows.forEach(r => {
      const qty = r.sum_qty || 0;
      if (r.item_type === 'gold') {
        if (r.type === 'buy') goldBalance += qty;
        else goldBalance -= qty;
      } else if (r.item_type === 'crystal') {
        if (r.type === 'buy') crystalBalance += qty;
        else crystalBalance -= qty;
      }
    });
    res.json({ success: true, goldBalance, crystalBalance });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الرصيد' });
  }
});

router.get('/approved', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query('SELECT id, name FROM shipping_approved ORDER BY name')).rows;
    res.json({ success: true, list: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب المعتمدين' });
  }
});

router.get('/sub-agencies', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query('SELECT id, name FROM shipping_sub_agencies ORDER BY name')).rows;
    res.json({ success: true, list: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الوكالات' });
  }
});

router.get('/carriers', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query(
      'SELECT id, name FROM shipping_carrier_agencies WHERE user_id = $1 ORDER BY name',
      [req.session.userId]
    )).rows;
    res.json({ success: true, list: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الجلب', list: [] });
  }
});

/** إضافة وكالة شحن */
router.post('/carriers', requireAuth, async (req, res) => {
  try {
    const { name, amount, quantity } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'الاسم مطلوب' });
    const db = getDb();
    const r = await db.query(
      'INSERT INTO shipping_carrier_agencies (user_id, name) VALUES ($1, $2)',
      [req.session.userId, String(name).trim()]
    );
    const id = r.lastInsertRowid;
    const amt = parseFloat(amount);
    const qty = parseFloat(quantity);
    if (id && !isNaN(amt) && amt !== 0) {
      await db.query(
        `INSERT INTO shipping_carrier_transactions (carrier_id, direction, amount, quantity, notes)
         VALUES ($1, 'in', $2, $3, $4)`,
        [id, amt, !isNaN(qty) ? qty : 0, 'رصيد افتتاحي']
      );
    }
    res.json({ success: true, message: 'تمت الإضافة', id });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.get('/carriers/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const row = (await db.query(
      'SELECT * FROM shipping_carrier_agencies WHERE id = $1 AND user_id = $2',
      [id, req.session.userId]
    )).rows[0];
    if (!row) return res.json({ success: false, message: 'غير موجود' });
    const txRows = (await db.query(
      `SELECT * FROM shipping_carrier_transactions WHERE carrier_id = $1 ORDER BY created_at DESC`,
      [id]
    )).rows;
    res.json({ success: true, carrier: row, transactions: txRows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.post('/carriers/:id/balance', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, quantity, direction, notes } = req.body || {};
    if (!id) return res.json({ success: false, message: 'معرف غير صالح' });
    const db = getDb();
    const ok = (await db.query(
      'SELECT id FROM shipping_carrier_agencies WHERE id = $1 AND user_id = $2',
      [id, req.session.userId]
    )).rows[0];
    if (!ok) return res.json({ success: false, message: 'غير موجود' });
    const dir = direction === 'out' ? 'out' : 'in';
    await db.query(
      `INSERT INTO shipping_carrier_transactions (carrier_id, direction, amount, quantity, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, dir, parseFloat(amount) || 0, parseFloat(quantity) || 0, notes || null]
    );
    res.json({ success: true, message: 'تم التسجيل' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.get('/companies', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query('SELECT id, name FROM shipping_companies ORDER BY name')).rows;
    res.json({ success: true, list: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب الشركات' });
  }
});

router.get('/users', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const cycles = (await db.query('SELECT id FROM financial_cycles WHERE user_id = $1', [req.session.userId])).rows;
    const userIds = new Set();
    for (const c of cycles) {
      const cache = (await db.query('SELECT management_data, agent_data FROM payroll_cycle_cache WHERE user_id = $1 AND cycle_id = $2', [req.session.userId, c.id])).rows[0];
      if (cache) {
        const parse = (d) => d ? (JSON.parse(d) || []) : [];
        for (const row of [...parse(cache.management_data), ...parse(cache.agent_data)]) {
          const id = row.user_id ?? row.userId ?? row.user_id_col ?? row.id;
          if (id != null) userIds.add(String(id));
        }
      }
    }
    const list = Array.from(userIds).sort().map(id => ({ id, name: id }));
    res.json({ success: true, list });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب المستخدمين', list: [] });
  }
});

router.post('/approved', requireAuth, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'الاسم مطلوب' });
    const db = getDb();
    const r = await db.query('INSERT INTO shipping_approved (name) VALUES ($1)', [String(name).trim()]);
    res.json({ success: true, message: 'تم إضافة المعتمد', id: r.lastInsertRowid });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإضافة' });
  }
});

router.post('/sub-agencies', requireAuth, async (req, res) => {
  try {
    const { name, commissionPercent } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'الاسم مطلوب' });
    const db = getDb();
    const pct = parseFloat(commissionPercent);
    const pctVal = (isNaN(pct) || pct < 0) ? 0 : Math.min(100, pct);
    const companyPct = 100 - pctVal;
    const r = await db.query('INSERT INTO shipping_sub_agencies (name, commission_percent, company_percent) VALUES ($1, $2, $3)', [String(name).trim(), pctVal, companyPct]);
    res.json({ success: true, message: 'تم إضافة الوكالة', id: r.lastInsertRowid });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإضافة' });
  }
});

router.post('/companies', requireAuth, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'اسم الشركة مطلوب' });
    const db = getDb();
    const r = await db.query('INSERT INTO shipping_companies (name) VALUES ($1)', [String(name).trim()]);
    res.json({ success: true, message: 'تم إضافة الشركة', id: r.lastInsertRowid });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل الإضافة' });
  }
});

router.post('/sell', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const {
      buyerType, userNumber, approvedId, subAgencyId, carrierId,
      itemType, quantity, unitPrice, paymentMethod, salaryDeductionUserId, notes,
    } = body;
    const qty = parseFloat(quantity);
    const lineTotal = lineTotalFromBody(unitPrice);
    if (!itemType || !buyerType || !quantity || isNaN(qty) || qty <= 0 || isNaN(lineTotal) || lineTotal < 0 || !paymentMethod) {
      return res.json({ success: false, message: 'تأكد من ملء جميع الحقول المطلوبة' });
    }
    if (buyerType === 'shipping_carrier' && !carrierId) {
      return res.json({ success: false, message: 'اختر وكالة الشحن' });
    }
    const userId = req.session.userId;
    const db = getDb();
    const { costAllocated, profit, capital } = await applySell(db, userId, itemType, qty, lineTotal);
    const unitEquiv = qty > 0 ? lineTotal / qty : 0;
    const status = paymentMethod === 'debt' ? 'debt' : 'completed';
    const carrierIdInt = buyerType === 'shipping_carrier' && carrierId ? parseInt(carrierId, 10) : null;
    const r = await db.query(`
      INSERT INTO shipping_transactions (
        type, item_type, quantity, unit_price, total, payment_method, status,
        buyer_type, buyer_user_id, buyer_approved_id, buyer_sub_agency_id, buyer_carrier_id,
        salary_deduction_user_id, notes, cost_allocated, profit_amount, capital_amount
      )
      VALUES (
        'sell', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      )
    `, [
      itemType, qty, unitEquiv, lineTotal, paymentMethod, status, buyerType,
      buyerType === 'user' ? (userNumber || null) : null,
      buyerType === 'approved' ? (approvedId || null) : null,
      buyerType === 'sub_agent' ? (subAgencyId || null) : null,
      carrierIdInt,
      paymentMethod === 'salary_deduction' ? (salaryDeductionUserId || null) : null,
      notes || null,
      costAllocated, profit, capital,
    ]);
    const txId = r.lastInsertRowid;
    const txRow = {
      id: txId,
      type: 'sell',
      buyer_type: buyerType,
      buyer_sub_agency_id: subAgencyId ? parseInt(subAgencyId, 10) : null,
      payment_method: paymentMethod,
      total: lineTotal,
      profit_amount: profit,
    };
    await registerShippingForAgency(db, txRow);
    if (paymentMethod === 'cash') {
      await creditShippingCashSale(db, userId, lineTotal, notes, txId);
    }
    if (carrierIdInt) {
      await db.query(
        `INSERT INTO shipping_carrier_transactions (carrier_id, direction, amount, quantity, notes, shipping_transaction_id)
         VALUES ($1, 'out', $2, $3, $4, $5)`,
        [carrierIdInt, lineTotal, qty, notes || 'بيع عبر وكالة شحن', txId]
      );
    }
    res.json({ success: true, message: 'تم تسجيل عملية البيع', profit, capitalRecovered: capital });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_QTY') {
      return res.json({ success: false, message: e.message });
    }
    res.json({ success: false, message: e.message || 'فشل تسجيل البيع' });
  }
});

router.post('/buy', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const { purchaseSource, companyName, companyId, itemType, quantity, unitPrice, paymentMethod, notes } = body;
    const qty = parseFloat(quantity);
    const lineTotal = lineTotalFromBody(unitPrice);
    if (!itemType || !purchaseSource || !quantity || isNaN(qty) || qty <= 0 || isNaN(lineTotal) || lineTotal < 0 || !paymentMethod) {
      return res.json({ success: false, message: 'تأكد من ملء جميع الحقول المطلوبة' });
    }
    const userId = req.session.userId;
    const db = getDb();
    let finalCompanyName = null;
    let finalCompanyId = null;
    if (purchaseSource === 'company') {
      if (companyId) {
        const row = (await db.query('SELECT id, name FROM shipping_companies WHERE id = $1', [companyId])).rows[0];
        if (row) {
          finalCompanyId = row.id;
          finalCompanyName = row.name;
        }
      }
      if (!finalCompanyName && companyName) finalCompanyName = String(companyName).trim();
      if (!finalCompanyName) return res.json({ success: false, message: 'اسم الشركة مطلوب' });
    }
    await applyBuy(db, userId, itemType, qty, lineTotal);
    const unitEquiv = qty > 0 ? lineTotal / qty : 0;
    const status = paymentMethod === 'debt' ? 'debt' : 'completed';
    const r = await db.query(`
      INSERT INTO shipping_transactions (
        type, item_type, quantity, unit_price, total, payment_method, status,
        purchase_source, purchase_company_id, purchase_company_name, notes,
        cost_allocated, profit_amount, capital_amount
      )
      VALUES (
        'buy', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      )
    `, [
      itemType, qty, unitEquiv, lineTotal, paymentMethod, status,
      purchaseSource, finalCompanyId, finalCompanyName, notes || null,
      lineTotal, 0, lineTotal,
    ]);
    const txId = r.lastInsertRowid;
    if (paymentMethod === 'cash') {
      await debitShippingCashBuy(db, userId, lineTotal, notes, txId);
    }
    res.json({ success: true, message: 'تم تسجيل عملية الشراء' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل تسجيل الشراء' });
  }
});

/** تبديل راتب: كاش / تقسيط / دين — خصم يُسجّل مصروفاً */
router.post('/salary-swap', requireAuth, async (req, res) => {
  try {
    const { companyId, grossAmount, discountPct, paymentMode, firstInstallment, notes } = req.body || {};
    const cid = parseInt(companyId, 10);
    const gross = parseFloat(grossAmount);
    const disc = parseFloat(discountPct);
    if (!cid || isNaN(gross) || gross <= 0) {
      return res.json({ success: false, message: 'شركة ومبلغ صالحان مطلوبان' });
    }
    const d = !isNaN(disc) && disc > 0 ? Math.min(100, disc) : 0;
    const netAfter = Math.round(gross * (1 - d / 100) * 100) / 100;
    const expenseDiscount = Math.round((gross - netAfter) * 100) / 100;
    const mode = paymentMode === 'installment' ? 'installment' : paymentMode === 'debt' ? 'debt' : 'cash';
    const first = mode === 'installment' ? (parseFloat(firstInstallment) || 0) : 0;

    const db = getDb();
    const userId = req.session.userId;
    const co = (await db.query('SELECT id, name FROM transfer_companies WHERE id = $1 AND user_id = $2', [cid, userId])).rows[0];
    if (!co) return res.json({ success: false, message: 'شركة غير موجودة' });

    const mainFundId = await getMainFundId(db, userId);
    let mainFundCredit = 0;
    let debtAmount = 0;

    if (expenseDiscount > 0) {
      await insertLedgerEntry(db, {
        userId,
        bucket: 'expense',
        sourceType: 'salary_swap_discount',
        amount: expenseDiscount,
        notes: 'خصم تبديل راتب — ' + (co.name || ''),
      });
    }

    if (mode === 'cash') {
      mainFundCredit = netAfter;
      if (mainFundId && mainFundCredit > 0) {
        await adjustFundBalance(db, mainFundId, 'USD', mainFundCredit, 'salary_swap_cash', 'تبديل راتب كاش', 'transfer_companies', cid);
        await insertLedgerEntry(db, {
          userId,
          bucket: 'main_cash',
          sourceType: 'salary_swap',
          amount: mainFundCredit,
          refTable: 'transfer_companies',
          refId: cid,
          notes: 'تبديل راتب كاش',
        });
      }
      debtAmount = 0;
    } else if (mode === 'installment') {
      const rest = Math.max(0, netAfter - first);
      mainFundCredit = Math.min(first, netAfter);
      debtAmount = rest;
      if (mainFundId && mainFundCredit > 0) {
        await adjustFundBalance(db, mainFundId, 'USD', mainFundCredit, 'salary_swap_installment', 'دفعة أولى تبديل راتب', 'transfer_companies', cid);
        await insertLedgerEntry(db, {
          userId,
          bucket: 'main_cash',
          sourceType: 'salary_swap',
          amount: mainFundCredit,
          refTable: 'transfer_companies',
          refId: cid,
          notes: 'تبديل راتب — دفعة أولى',
        });
      }
      if (rest > 0) {
        await db.query(
          `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes)
           VALUES ($1, 'transfer_company', $2, $3, 'USD', $4)`,
          [userId, cid, rest, notes || 'تبديل راتب — باقي تقسيط']
        );
      }
    } else {
      debtAmount = netAfter;
      mainFundCredit = 0;
      if (debtAmount > 0) {
        await db.query(
          `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes)
           VALUES ($1, 'transfer_company', $2, $3, 'USD', $4)`,
          [userId, cid, debtAmount, notes || 'تبديل راتب — دين']
        );
      }
    }

    await db.query(
      `INSERT INTO salary_swap_entries (user_id, company_id, gross_amount, discount_pct, payment_mode, net_after_discount, first_installment, debt_amount, main_fund_credit, expense_discount, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [userId, cid, gross, d, mode, netAfter, first, debtAmount, mainFundCredit, expenseDiscount, notes || null]
    );

    res.json({
      success: true,
      message: 'تم تسجيل تبديل الراتب',
      netAfterDiscount: netAfter,
      mainFundCredit,
      debtAmount,
      expenseDiscount,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const { type, buyerType, buyerId, fromDate, toDate, status } = req.query || {};
    const db = getDb();
    let sql = 'SELECT * FROM shipping_transactions WHERE 1=1';
    const params = [];
    if (type) { sql += ` AND type = $${params.length + 1}`; params.push(type); }
    if (buyerType) { sql += ` AND buyer_type = $${params.length + 1}`; params.push(buyerType); }
    if (buyerId) {
      if (buyerType === 'user') { sql += ` AND buyer_user_id = $${params.length + 1}`; params.push(buyerId); }
      else if (buyerType === 'approved') { sql += ` AND buyer_approved_id = $${params.length + 1}`; params.push(buyerId); }
      else if (buyerType === 'sub_agent') { sql += ` AND buyer_sub_agency_id = $${params.length + 1}`; params.push(buyerId); }
    }
    if (fromDate) { sql += ` AND date(created_at) >= date($${params.length + 1})`; params.push(fromDate); }
    if (toDate) { sql += ` AND date(created_at) <= date($${params.length + 1})`; params.push(toDate); }
    if (status) { sql += ` AND status = $${params.length + 1}`; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const rows = (await db.query(sql, params)).rows;
    res.json({ success: true, transactions: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل جلب السجل' });
  }
});

module.exports = router;
