---
name: مرتجع وديون صفحات
overview: تنفيذ منطق المرتجع (تسجيل وترحيل اختياري لصندوق)، واستبدال نافذة الديون المنبثقة بصفحات مستقلة مع توسيع مصادر إجمالي الديون، اعتماداً على المخطط الحالي ([db/schema.pg.sql](db/schema.pg.sql)، [routes/dashboard.js](routes/dashboard.js)، [public/js/app.js](public/js/app.js)).
todos:
  - id: schema-returns
    content: إضافة جدول financial_returns (+ اختياري entity_payables) وربط التهيئة في database.js
    status: completed
  - id: api-returns
    content: تنفيذ POST المرتجع وتحديث الأرصدة/السجلات عبر fundService وشركات التحويل
    status: completed
  - id: ui-returns
    content: واجهات تسجيل المرتجع في transfer-companies و funds + JS
    status: completed
  - id: debts-stats-api
    content: توسيع /dashboard/stats وAPI ملخص للديون لصفحة /debts
    status: completed
  - id: debts-pages
    content: مسارات pages + partials /debts و /debts/company/:id و /debts/fund/:id
    status: completed
  - id: home-link
    content: ربط بطاقة إجمالي الديون بـ /debts وإيقاف/إزالة المنبثقة
    status: completed
  - id: debt-record
    content: نموذج بسيط لتسجيل دين على شركة/صندوق إن وُجد الجدول/المنطق المتفق عليه
    status: completed
isProject: false
---

# خطة: المرتجع + صفحات الديون (المرحلة 1)

## الوضع الحالي

- **الديون في اللوحة:** `[routes/dashboard.js](routes/dashboard.js)` يجمع `totalDebts` من ديون الشحن (`shipping_transactions` بيع بالدين) + اعتمادات سالبة (`[/dashboard/stats](routes/dashboard.js)` و `[/dashboard/debts-detail](routes/dashboard.js)`).
- **عرض الديون:** البطاقة في `[views/partials/home.ejs](views/partials/home.ejs)` تستدعي `homeOpenDebtsModal()` — نافذة منبثقة في نفس الملف + `[public/js/app.js](public/js/app.js)`.
- **صناديع وشركات:** أرصدة عبر `[fund_balances](db/schema.pg.sql)` / `[fund_ledger](db/schema.pg.sql)` و`[transfer_companies.balance_amount](db/schema.pg.sql)` / `[transfer_company_ledger](db/schema.pg.sql)` — لا يوجد جدول مخصص للمرتجع أو لديون مستقلة تجاه شركة/صندوق كـ «مديونية تسوية».
- **أزرار صادر/وارد/مرتجع:** تطلق فقط `CustomEvent('quickAction')` من `[initQuickActionFab](public/js/app.js)` — لا توجيه بعد.

## 1) قاعدة البيانات — المرتجع

إضافة جدول (مثلاً `financial_returns`) يوثّق:

- `user_id`, `entity_type` (`transfer_company` | `fund`), `entity_id`
- `amount`, `currency`
- حقول اختيارية لشرح المثال المحاسبي: `sent_amount` (مثلاً 10000), `utilized_amount` (9000) — الفرق يُشتق أو يُخزَّن صراحة كـ `amount`
- `disposition`: `remain_at_entity` | `transfer_to_fund` + `target_fund_id` عند الترحيل
- `notes`, `created_at`

**ربط المحاسبة:** عند `transfer_to_fund`:

- خصم/تعديل رصيد الكيان المصدر وإدراج سطر في `transfer_company_ledger` أو `fund_ledger` بنوع واضح (مثل `return_out` / `return_in`) مع `ref_table` يشير لـ `financial_returns.id`.

تعديل `[db/database.js](db/database.js)` (أو آلية الهجرة المستخدمة عندكم) لإنشاء الجدول عند التهيئة، وتحديث `[db/schema.pg.sql](db/schema.pg.sql)` كمرجع.

## 2) API المرتجع

- مسارات جديدة تحت `[routes/transferCompanies.js](routes/transferCompanies.js)` و/أو `[routes/funds.js](routes/funds.js)`، أو ملف موحّد مثل `routes/returns.js` يُحمَّل في `[server.js](server.js)`:
  - `POST` لإنشاء مرتجع (مع التحقق من الملكية `user_id`)
  - عند الترحيل لصندوق: استدعاء نفس منطق التعديل المستخدم في `[services/fundService.js](services/fundService.js)` (`adjustFundBalance`) وتحديث رصيد الشركة عبر `transfer_company_ledger` + `UPDATE transfer_companies.balance_amount` بما يتوافق مع اتجاه الحركة المعتمد عندكم.

## 3) واجهة المرتجع

- في `[views/partials/transfer-companies.ejs](views/partials/transfer-companies.ejs)` و/أو `[public/js/transfer-companies.js](public/js/transfer-companies.js)`: نموذج أو قسم «تسجيل مرتجع» (مبلغ، عملة، اختيار الإبقاء عند الشركة أو التحويل لصندوق مرتبط/آخر).
- نفس الفكرة لـ `[views/partials/funds.ejs](views/partials/funds.ejs)` إذا كان المسار من صندوق إلى صندوق/شركة يحتاج واجهة مطابقة.

## 4) الديون — توسيع الرقم وصفحات مستقلة

**توسيع `totalDebts` في `[GET /dashboard/stats](routes/dashboard.js)`:**

- إضافة مصادر متفق عليها في المرحلة 1، مثلاً:
  - اعتمادات سالبة (موجود)
  - ديون شحن (موجود)
  - **إن وُجدت مديونيات مسجّلة** في جدول جديد بسيط `entity_payables` أو عبر حقل/قيود في السجلات الحالية — يُفضّل جدول صريح: `(user_id, entity_type, entity_id, amount_usd_equiv, currency, notes)` للتسويات «مديون لشركة تحويل» حتى لا نخلطها مع `balance_amount` إن كان معناها مختلفاً عندكم.

إن رغبت بتجنب جدول جديد في الدفعة الأولى: يمكن احتساب **دين تجاه شركة** كـ `MAX(0, -balance_amount)` فقط إذا اتفقتم أن الرصيد السالب = مديونية عليكم؛ وإلا يُؤجَّل لجدول `payables`.

**صفحات (بدل المنبثقة):**

- إضافة مسارات في `[routes/pages.js](routes/pages.js)` (أو router صفحات منفصل):
  - `GET /debts` — قائمة «ملفات»: شركات وصناديع لها رصيد دين/مديونية (البيانات من API جديد مثل `GET /dashboard/debts-overview` أو `/api/debts/summary`).
  - `GET /debts/company/:id` و `GET /debts/fund/:id` — صفحة سجل مستقلة تعرض نفس منطق التفاصيل الحالية (شحن + اعتمادات + سطور ledger ذات الصلة) مع إمكانية إعادة استخدام بيانات `[/dashboard/debts-detail](routes/dashboard.js)` وموسّعة.
- في `[views/dashboard.ejs](views/dashboard.ejs)`: فروع `page === 'debts' | 'debt-company' | 'debt-fund'` تتضمّن partials جديدة.
- في `[views/partials/home.ejs](views/partials/home.ejs)`: تغيير `onclick` على بطاقة إجمالي الديون من `homeOpenDebtsModal()` إلى `location.href='/debts'` (أو رابط `<a href="/debts">`).
- إبقاء النافذة المنبثقة اختيارياً لمن يريدها أو حذفها لتفادي الازدواج.

## 5) «سحب ديون» وتسجيلها على الحساب

ضمن المرحلة 1 (مختصرة): **نموذج تسجيل حدث دين** (مبلغ، جهة صندوق/شركة، ملاحظات) يكتب في `entity_payables` أو ledger بنوع `debt_recognized`، ويظهر في `/debts` وفي `totalDebts`. التفاصيل الدقيقة للقيد المزدوج تُثبَّت معك عند التنفيذ إن لزم.

## 6) ما يُؤجَّل (ذكر للسياق فقط)

- **فرق التصريف:** جداول أسعار مرجعية لكل دورة/عملة، ومقارنة بسعر التسليم لشركة التحويل — مرحلة لاحقة.
- **ربط صادر/وارد/مرتجع بكل الموقع:** مستمع مركزي في `[public/js/app.js](public/js/app.js)` يوجّه حسب `detail.type` إلى `/shipping`, `/debts`, صفحة مرتجع، إلخ — بعد استقرار الصفحات والمسارات.

```mermaid
flowchart LR
  subgraph phase1 [Phase1]
    RetTable[financial_returns]
    DebtsPages[/debts routes]
    Stats[totalDebts expand]
  end
  HomeCard[home debt card] --> DebtsPages
  RetUI[transfer-companies / funds UI] --> RetTable
  RetTable --> Ledger[fund_ledger / company_ledger]
  Stats --> HomeCard
```



## ملفات رئيسية للمس

- `[db/schema.pg.sql](db/schema.pg.sql)`, `[db/database.js](db/database.js)`
- `[routes/dashboard.js](routes/dashboard.js)`, `[routes/pages.js](routes/pages.js)`, `[server.js](server.js)` إذا أضيف router جديد
- `[views/partials/home.ejs](views/partials/home.ejs)`, partials جديدة للديون
- `[public/js/app.js](public/js/app.js)` (إزالة/استبدال المنبثقة)
- `[views/partials/transfer-companies.ejs](views/partials/transfer-companies.ejs)`, `[views/partials/funds.ejs](views/partials/funds.ejs)` + JS المقابل

## مخاطر / قرار يحتاج تأكيد عند التنفيذ

- معنى **إشارة** `transfer_companies.balance_amount` (موجب = أموال عند الشركة أم لكم؟) — يحدد ما إذا كان «الدين» يُشتق من الرصيد أو من جدول منفصل.

