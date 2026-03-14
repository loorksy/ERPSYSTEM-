require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { initDatabase } = require('./db/database');
const handlers = require('./whatsapp/handlers');
const whatsappService = require('./services/whatsappService');
const waSession = require('./whatsapp/session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

initDatabase();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  },
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'lorkerp-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const whatsappRoutes = require('./routes/whatsapp')(io);
const sheetsRoutes = require('./routes/sheets');
const settingsRoutes = require('./routes/settings');
const pagesRoutes = require('./routes/pages');
const aiRoutes = require('./routes/ai');

app.use('/', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/whatsapp', whatsappRoutes);
app.use('/sheets', sheetsRoutes);
app.use('/settings', settingsRoutes);
app.use('/ai', aiRoutes);
app.use('/', pagesRoutes);

app.get('/', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

app.use((req, res) => {
  res.status(404).render('404', { title: 'الصفحة غير موجودة' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { title: 'خطأ في الخادم', error: err.message });
});

handlers.setIO(io);

if (waSession.hasExistingSession()) {
  console.log('[LorkERP] Existing WhatsApp session found, auto-connecting...');
  setTimeout(() => {
    whatsappService.connect(io).then(result => {
      console.log('[LorkERP] Auto-connect result:', result.message);
    }).catch(err => {
      console.error('[LorkERP] Auto-connect failed:', err.message);
    });
  }, 3000);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[LorkERP] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[LorkERP] WhatsApp module initialized`);
});

module.exports = { app, server, io };
