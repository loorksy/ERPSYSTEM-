const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

const pages = [
  { path: '/sheet', page: 'sheet', title: 'Sheet' },
  { path: '/payroll', page: 'payroll', title: 'تدقيق الرواتب' },
  { path: '/clients', page: 'clients', title: 'بيانات العملاء' },
  { path: '/messages', page: 'messages', title: 'ترتيب الرسائل' },
  { path: '/approvals', page: 'approvals', title: 'الاعتمادات' },
  { path: '/sub-agencies', page: 'sub-agencies', title: 'الوكالات الفرعية' },
  { path: '/main-agency', page: 'main-agency', title: 'الوكالة الرئيسية' },
  { path: '/transfer-companies', page: 'transfer-companies', title: 'شركات التحويل' },
  { path: '/shipping', page: 'shipping', title: 'الشحن' },
  { path: '/wa-bot', page: 'wa-bot', title: 'بوت واتساب' },
  { path: '/client-portal', page: 'client-portal', title: 'واجهة العملاء' },
];

pages.forEach(({ path, page, title }) => {
  router.get(path, requireAuth, (req, res) => {
    res.render('dashboard', { title, page, user: req.session.user });
  });
});

module.exports = router;
