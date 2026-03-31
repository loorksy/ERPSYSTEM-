const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { buildFinancialMovementFeed } = require('../services/financialMovementFeedService');

/** سجل موحّد: دين لنا / دين علينا / الالتزامات + ترحيل نقدي */
router.get('/feed', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.userId;
    const bucket = (req.query.bucket || 'all').toString().trim().toLowerCase();
    const limit = req.query.limit;
    const data = await buildFinancialMovementFeed(db, userId, { bucket, limit });
    res.json({ success: true, ...data });
  } catch (e) {
    res.json({ success: false, message: e.message || 'فشل تحميل السجل' });
  }
});

module.exports = router;
