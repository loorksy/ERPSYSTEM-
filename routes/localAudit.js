const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { markMemberAuditedLocal } = require('../services/localAuditService');

router.get('/cycles', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.query(
      'SELECT id, name, created_at FROM financial_cycles WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.userId]
    )).rows;
    res.json({ success: true, cycles: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', cycles: [] });
  }
});

router.post('/mark-audited', requireAuth, async (req, res) => {
  try {
    const { cycleId, memberId } = req.body || {};
    const cid = parseInt(cycleId, 10);
    if (!cid || !memberId) {
      return res.json({ success: false, message: 'الدورة ورقم المستخدم مطلوبان' });
    }
    const r = await markMemberAuditedLocal(req.session.userId, cid, memberId);
    res.json(r);
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
