const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { createReturn, listReturnsForEntity } = require('../services/returnsService');

router.post('/', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const result = await createReturn(db, req.session.userId, req.body || {});
    let message = 'تم تسجيل المرتجع';
    if (result.payablesSettled > 0) {
      message += ` — تسوية دين ${result.payablesSettled.toFixed(2)} ${result.currency || ''}`.trim();
      if (result.netAmount > 0) {
        message += `، متبقّى للحركة ${result.netAmount.toFixed(2)} ${result.currency || ''}`.trim();
      } else {
        message += ' (اكتفى المرتجع بتسوية الدين)';
      }
    }
    res.json({ success: true, message, ...result });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل تسجيل المرتجع' });
  }
});

router.get('/for-entity', requireAuth, async (req, res) => {
  try {
    const { entityType, entityId } = req.query || {};
    const db = getDb();
    const rows = await listReturnsForEntity(db, req.session.userId, entityType, entityId);
    res.json({ success: true, returns: rows });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل', returns: [] });
  }
});

module.exports = router;
