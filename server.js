require('dotenv').config();

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
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

/** مدة بقاء الجلسة: 7 أيام (بالمللي ثانية للـ cookie وبالثواني لـ session store) */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_MAX_AGE_MS / 1000);

const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:", "https://cdnjs.cloudflare.com"],
    },
  },
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'lorkerp-secret',
  store: new FileStore({
    path: sessionsDir,
    ttl: SESSION_MAX_AGE_SECONDS,
    retries: 0,
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_MS,
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
const sheetRoutes = require('./routes/sheet');
const settingsRoutes = require('./routes/settings');
const pagesRoutes = require('./routes/pages');
const aiRoutes = require('./routes/ai');

app.use('/', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/whatsapp', whatsappRoutes);
app.use('/sheets', sheetsRoutes);
app.use('/api/sheet', sheetRoutes);
app.use('/settings', settingsRoutes);
app.use('/ai', aiRoutes(io));
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

io.on('connection', (socket) => {
  socket.on('subscribe_analysis', (jobId) => {
    if (jobId) socket.join(`analysis:${jobId}`);
  });
});

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

initDatabase()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[LorkERP] Server running on http://0.0.0.0:${PORT}`);
      console.log(`[LorkERP] WhatsApp module initialized`);
    });
  })
  .catch((err) => {
    console.error('[LorkERP] Database init failed:', err);
    process.exit(1);
  });

module.exports = { app, server, io };
