const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');

router.get('/', requireAuth, (req, res) => {
  res.render('dashboard', {
    title: 'الإعدادات',
    page: 'settings',
    user: req.session.user
  });
});

router.post('/change-password', requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const db = getDb();

    if (newPassword !== confirmPassword) {
      return res.json({ success: false, message: 'كلمات المرور غير متطابقة' });
    }

    if (newPassword.length < 6) {
      return res.json({ success: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!bcrypt.compareSync(currentPassword, user.password)) {
      return res.json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashedPassword, req.session.userId);

    res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
  } catch (error) {
    res.json({ success: false, message: 'حدث خطأ أثناء تغيير كلمة المرور' });
  }
});

router.post('/update-profile', requireAuth, (req, res) => {
  try {
    const { displayName } = req.body;
    const db = getDb();

    db.prepare('UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(displayName, req.session.userId);
    req.session.user.displayName = displayName;

    res.json({ success: true, message: 'تم تحديث الملف الشخصي بنجاح' });
  } catch (error) {
    res.json({ success: false, message: 'حدث خطأ أثناء تحديث الملف الشخصي' });
  }
});

module.exports = router;
