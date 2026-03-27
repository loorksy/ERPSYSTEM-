const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

router.get('/debts/company/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.redirect('/debts');
  res.render('dashboard', {
    title: 'سجل شركة',
    page: 'debt-company',
    debtEntityId: id,
    user: req.session.user,
  });
});

router.get('/debts/fund/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.redirect('/debts');
  res.render('dashboard', {
    title: 'سجل صندوق',
    page: 'debt-fund',
    debtEntityId: id,
    user: req.session.user,
  });
});

router.get('/debts', requireAuth, (req, res) => {
  res.render('dashboard', { title: 'الديون', page: 'debts', user: req.session.user });
});

router.get('/fx-spread', requireAuth, (req, res) => {
  res.render('dashboard', { title: 'فرق التصريف', page: 'fx-spread', user: req.session.user });
});

/** توافق مع الروابط القديمة */
router.get('/payroll-google', requireAuth, (req, res) => {
  res.redirect(301, '/payroll');
});
router.get('/local-audit', requireAuth, (req, res) => {
  res.redirect(301, '/dashboard');
});

const pages = [
  { path: '/sheet', page: 'sheet', title: 'Sheet' },
  { path: '/payroll', page: 'payroll-google', title: 'تدقيق الرواتب' },
  { path: '/expenses-manual', page: 'expenses-page', title: 'المصاريف' },
  { path: '/profit-sources', page: 'profit-sources', title: 'مصادر الربح' },
  { path: '/admin-brokerage', page: 'admin-brokerage', title: 'وساطة إدارية' },
  { path: '/payables-us', page: 'payables-overview', title: 'دين علينا' },
  { path: '/receivables-to-us', page: 'receivables-to-us', title: 'ديين لنا' },
  { path: '/deferred-balance', page: 'deferred-balance', title: 'رصيد المؤجل' },
  { path: '/search', page: 'search', title: 'البحث' },
  { path: '/clients', page: 'clients', title: 'بيانات العملاء' },
  { path: '/messages', page: 'messages', title: 'ترتيب الرسائل' },
  { path: '/approvals', page: 'approvals', title: 'الاعتمادات' },
  { path: '/sub-agencies', page: 'sub-agencies', title: 'الوكالات الفرعية' },
  { path: '/main-agency', page: 'main-agency', title: 'الوكالة الرئيسية' },
  { path: '/transfer-companies', page: 'transfer-companies', title: 'شركات التحويل' },
  { path: '/funds', page: 'funds', title: 'الصناديق' },
  { path: '/shipping', page: 'shipping', title: 'الشحن' },
  { path: '/client-portal', page: 'client-portal', title: 'واجهة العملاء' },
  { path: '/member-directory', page: 'member-directory', title: 'بيانات المستخدمين' },
  { path: '/member-adjustments', page: 'member-adjustments', title: 'إضافات وخصومات' },
];

router.get('/member-directory/member/:memberUserId', requireAuth, (req, res) => {
  res.render('dashboard', {
    title: 'ملف عضو',
    page: 'member-directory-detail',
    memberUserId: req.params.memberUserId,
    user: req.session.user,
  });
});

router.get('/profit-sources/:sourceType/detail', requireAuth, (req, res) => {
  res.render('dashboard', {
    title: 'تفاصيل مصدر الربح',
    page: 'profit-source-detail',
    profitSourceType: decodeURIComponent(req.params.sourceType || ''),
    user: req.session.user,
  });
});

router.get('/media-finance', requireAuth, (req, res) => {
  res.render('dashboard', { title: 'الوسائط المالية', page: 'media-finance', user: req.session.user });
});

pages.forEach(({ path, page, title }) => {
  router.get(path, requireAuth, (req, res) => {
    res.render('dashboard', { title, page, user: req.session.user });
  });
});

module.exports = router;
