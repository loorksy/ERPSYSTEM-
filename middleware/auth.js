function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  return res.redirect('/login');
}

module.exports = { requireAuth };
