const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { syncNetBalance } = require('../services/accreditationBalance');

async function agencyBalance(db, subAgencyId) {
  const rows = (await db.query(
    `SELECT type, SUM(amount) as total
     FROM sub_agency_transactions
     WHERE sub_agency_id = $1
     GROUP BY type`,
    [subAgencyId]
  )).rows;
  let balance = 0;
  rows.forEach((r) => {
    const t = r.total || 0;
    if (r.type === 'profit' || r.type === 'reward') balance += t;
    else if (r.type === 'deduction' || r.type === 'due') balance -= t;
  });
  return balance;
}

/** تسليم موحّد: تصفير أرصدة معتمدين ووكالات فرعية (نفس منطق delivery-settle لكل نوع) */
router.post('/settle', requireAuth, async (req, res) => {
  try {
    const { cycleId, accreditationIds, subAgencyIds } = req.body || {};
    const cid = cycleId ? parseInt(cycleId, 10) : null;
    const accIds = Array.isArray(accreditationIds) ? accreditationIds.map((x) => parseInt(x, 10)).filter(Boolean) : [];
    const subIds = Array.isArray(subAgencyIds) ? subAgencyIds.map((x) => parseInt(x, 10)).filter(Boolean) : [];
    if (!accIds.length && !subIds.length) {
      return res.json({ success: false, message: 'اختر معتمداً أو وكالة واحدة على الأقل' });
    }
    const db = getDb();
    const userId = req.session.userId;

    for (const aid of accIds) {
      const ent = (await db.query(
        'SELECT id, balance_payable FROM accreditation_entities WHERE id = $1 AND user_id = $2',
        [aid, userId]
      )).rows[0];
      if (!ent) continue;
      const pay = Number(ent.balance_payable) || 0;
      if (pay <= 0.0001) continue;
      await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes)
         VALUES ($1, 'delivery', $2, 'USD', 'to_them', $3, $4)`,
        [aid, pay, cid, 'تسليم — تصفير علينا دون صندوق']
      );
      await db.query('UPDATE accreditation_entities SET balance_payable = 0 WHERE id = $1', [aid]);
      await syncNetBalance(db, aid);
    }

    for (const sid of subIds) {
      const bal = await agencyBalance(db, sid);
      if (bal <= 0) continue;
      await db.query(
        `INSERT INTO sub_agency_transactions (sub_agency_id, type, amount, notes, cycle_id)
         VALUES ($1, 'deduction', $2, $3, $4)`,
        [sid, bal, 'تسليم راتب — تصفير محاسبي', cid]
      );
    }

    res.json({ success: true, message: 'تم التسليم' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل التسليم' });
  }
});

module.exports = router;
