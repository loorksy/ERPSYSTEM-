require('dotenv').config();

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { Server } = require('socket.io');
const { initDatabase } = require('./db/database');
const { startBackgroundSync } = require('./services/cycleSyncWorker');

const PORT = parseInt(process.env.PORT || 3000, 10);
const LOCK_FILE = path.join(__dirname, '.server.lock');

/** منع تشغيل أكثر من نسخة واحدة على نفس المنفذ */
function ensureSingleInstance() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const [oldPid, oldPort] = content.split(':');
      if (oldPort && parseInt(oldPort, 10) === PORT) {
        try {
          process.kill(parseInt(oldPid, 10), 0);
          console.error(`[LorkERP] نسخة أخرى تعمل بالفعل (PID: ${oldPid}) على المنفذ ${PORT}. أوقفها أولاً.`);
          process.exit(1);
        } catch (_) {}
      }
    } catch (_) {}
  }
  try {
    fs.writeFileSync(LOCK_FILE, `${process.pid}:${PORT}`, 'utf8');
  } catch (e) {
    console.error('[LorkERP] فشل إنشاء ملف القفل:', e.message);
    process.exit(1);
  }
  function removeLock() {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const c = fs.readFileSync(LOCK_FILE, 'utf8').trim();
        if (c.startsWith(process.pid + ':')) fs.unlinkSync(LOCK_FILE);
      }
    } catch (_) {}
  }
  process.on('exit', removeLock);
  process.on('SIGTERM', () => { removeLock(); });
  process.on('SIGINT', () => { removeLock(); });
}

/** التحقق من أن المنفذ غير مستخدم قبل البدء */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => {
      s.close();
      resolve(false);
    });
    s.listen(port, '127.0.0.1');
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
    retries: 5,
    reapInterval: 3600,
    reapAsync: true,
    logFn: () => {},
  }),
  resave: true,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_MS,
    sameSite: 'lax',
  },
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const sheetsRoutes = require('./routes/sheets');
const sheetRoutes = require('./routes/sheet');
const settingsRoutes = require('./routes/settings');
const pagesRoutes = require('./routes/pages');
const searchRoutes = require('./routes/search');
const shippingRoutes = require('./routes/shipping');
const subAgenciesRoutes = require('./routes/subAgencies');
const aiRoutes = require('./routes/ai');

app.use('/', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/sheets', sheetsRoutes);
app.use('/api/sheet', sheetRoutes);
app.use('/settings', settingsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api/sub-agencies', subAgenciesRoutes);
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
  console.error(err.stack || err);

  // إذا كانت الاستجابة قد أرسلت بالفعل، لا نحاول إرسال هيدر/HTML جديد
  if (res.headersSent) {
    return next(err);
  }

  res.status(500).render('error', {
    title: 'خطأ في الخادم',
    error: err && err.message ? err.message : 'حدث خطأ غير متوقع',
  });
});

io.on('connection', (socket) => {
  socket.on('subscribe_analysis', (jobId) => {
    if (jobId) socket.join(`analysis:${jobId}`);
  });
});

// إغلاق نظيف عند إعادة التشغيل من nodemon لتحرير المنفذ فوراً
function gracefulShutdown() {
  console.log('[LorkERP] جاري إغلاق الخادم...');
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[LorkERP] المنفذ ${PORT} مشغول. أوقف العملية الأخرى أولاً: taskkill /PID <رقم_العملية> /F`);
    process.exit(1);
  }
  console.error('[LorkERP] Server error:', err);
});

initDatabase()
  .then(async () => {
    ensureSingleInstance();
    const inUse = await isPortInUse(PORT);
    if (inUse) {
      console.error(`[LorkERP] المنفذ ${PORT} مشغول. أوقف العملية الأخرى أولاً: taskkill /F /PID <رقم_العملية>`);
      process.exit(1);
    }
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[LorkERP] Server running on http://0.0.0.0:${PORT}`);
      try {
        startBackgroundSync(60000, 5);
        console.log('[LorkERP] Payroll cycle background sync started');
      } catch (e) {
        console.error('[LorkERP] Failed to start background sync', e.message);
      }
    });
  })
  .catch((err) => {
    console.error('[LorkERP] Database init failed:', err);
    process.exit(1);
  });

module.exports = { app, server, io };
