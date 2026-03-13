# LorkERP - نظام المحاسبة المتكامل

نظام محاسبة متجاوب يعمل على الموبايل واللابتوب، مبني بلغة عربية كاملة مع دعم RTL.

## المميزات

- **تصميم متجاوب** - يعمل كتطبيق موبايل على الهاتف وكداشبورد على اللابتوب
- **واجهة عربية كاملة** - دعم RTL مع خط Tajawal
- **ربط واتساب** - اتصال عبر مسح QR Code
- **مزامنة Google Sheets** - ربط وتزامن البيانات مع جداول بيانات Google
- **نظام مصادقة آمن** - تسجيل دخول مع تشفير كلمات المرور
- **قابل للتوسع** - مبني بهيكلية جاهزة لإضافة أقسام وصفحات جديدة

## المتطلبات

- Node.js 18+
- npm

## التثبيت

```bash
git clone <repository-url>
cd LorkERP
cp .env.example .env
npm install
```

## التشغيل

```bash
# تشغيل عادي
npm start

# تشغيل للتطوير (إعادة تشغيل تلقائي)
npm run dev
```

التطبيق سيعمل على: `http://localhost:3000`

## بيانات الدخول الافتراضية

- **اسم المستخدم:** admin
- **كلمة المرور:** admin123

> قم بتغيير كلمة المرور فوراً بعد أول تسجيل دخول

## هيكلية المشروع

```
LorkERP/
├── server.js              # الخادم الرئيسي
├── package.json
├── .env                   # متغيرات البيئة
├── db/
│   └── database.js        # إعداد قاعدة البيانات SQLite
├── middleware/
│   └── auth.js            # وسيط المصادقة
├── routes/
│   ├── auth.js            # مسارات تسجيل الدخول
│   ├── dashboard.js       # لوحة التحكم
│   ├── whatsapp.js        # ربط واتساب
│   ├── sheets.js          # مزامنة Google Sheets
│   └── settings.js        # الإعدادات
├── views/
│   ├── login.ejs          # صفحة تسجيل الدخول
│   ├── dashboard.ejs      # قالب الداشبورد
│   ├── 404.ejs
│   ├── error.ejs
│   └── partials/
│       ├── home.ejs       # الصفحة الرئيسية
│       ├── whatsapp.ejs   # صفحة واتساب
│       ├── sheets.ejs     # صفحة Google Sheets
│       └── settings.ejs   # صفحة الإعدادات
└── public/
    ├── css/
    │   └── style.css      # الأنماط الرئيسية
    └── js/
        ├── app.js         # السكريبت الرئيسي
        ├── whatsapp.js    # سكريبت واتساب
        └── sheets.js      # سكريبت Google Sheets
```

## النشر على VPS

```bash
# تثبيت Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# تثبيت chromium لـ whatsapp-web.js
sudo apt-get install -y chromium-browser

# استنساخ المشروع وتثبيت التبعيات
git clone <repository-url>
cd LorkERP
cp .env.example .env
npm install --production

# تشغيل بـ PM2
npm install -g pm2
pm2 start server.js --name lorkerp
pm2 save
pm2 startup
```
