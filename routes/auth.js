const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

router.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render('login', { title: 'تسجيل الدخول', error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('login', { title: 'تسجيل الدخول', error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  req.session.userId = user.id;
  req.session.user = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role
  };

  res.redirect('/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
