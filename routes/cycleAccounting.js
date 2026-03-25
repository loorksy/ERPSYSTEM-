const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const {
  applyCycleAuditProfitsToLedger,
  rebuildDeferredFromLocalAgentData,
} = require('../services/cycleAccountingService');

router.post('/apply-audit-profits/:cycleId', requireAuth, async (req, res) => {
  try {
    const cycleId = parseInt(req.params.cycleId, 10);
    if (!cycleId) return res.json({ success: false, message: 'دورة غير صالحة' });
    const db = getDb();
    const c = (await db.query('SELECT id FROM financial_cycles WHERE id = $1 AND user_id = $2', [cycleId, req.session.userId])).rows[0];
    if (!c) return res.json({ success: false, message: 'الدورة غير موجودة' });
    const r = await applyCycleAuditProfitsToLedger(req.session.userId, cycleId);
    if (r.already) return res.json({ success: true, message: r.message || 'مسجّل مسبقاً', already: true });
    if (!r.success) return res.json({ success: false, message: r.message });
    res.json({ success: true, ...r });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

router.post('/rebuild-deferred/:cycleId', requireAuth, async (req, res) => {
  try {
    const cycleId = parseInt(req.params.cycleId, 10);
    if (!cycleId) return res.json({ success: false, message: 'دورة غير صالحة' });
    const db = getDb();
    const c = (await db.query('SELECT id FROM financial_cycles WHERE id = $1 AND user_id = $2', [cycleId, req.session.userId])).rows[0];
    if (!c) return res.json({ success: false, message: 'الدورة غير موجودة' });
    const r = await rebuildDeferredFromLocalAgentData(req.session.userId, cycleId);
    res.json(r);
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
