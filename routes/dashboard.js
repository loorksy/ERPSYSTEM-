const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, (req, res) => {
  res.render('dashboard', {
    title: 'لوحة التحكم',
    page: 'home',
    user: req.session.user
  });
});

module.exports = router;
