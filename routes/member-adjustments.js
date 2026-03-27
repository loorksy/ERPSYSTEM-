const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { processAdjustment } = require('../services/memberAdjustmentsService');

router.post('/apply', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const {
      memberUserId,
      kind,
      amount,
      notes,
      cycleId,
      syncUserInfoSheet,
      userInfoUserIdCol,
      userInfoSalaryCol,
    } = req.body || {};
    let cid = null;
    if (cycleId != null && cycleId !== '') {
      const n = parseInt(cycleId, 10);
      if (!Number.isNaN(n)) cid = n;
    }
    const r = await processAdjustment(db, req.session.userId, {
      memberUserId,
      kind,
      amount,
      notes,
      cycleId: cid,
      syncUserInfoSheet,
      userInfoUserIdCol,
      userInfoSalaryCol,
    });
    if (!r.success) return res.json(r);
    let msg = 'تم التسجيل في النظام';
    if (r.sheetMessage) msg += ' — ' + r.sheetMessage;
    res.json({
      success: true,
      message: msg,
      id: r.id,
      sheetSynced: r.sheetSynced,
      sheetMessage: r.sheetMessage || null,
    });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل' });
  }
});

module.exports = router;
