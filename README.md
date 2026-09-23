# CPGMeet — جلسات و کلندر (MVP فاز ۱)

اپ جدا از CPGChat برای مدیریت جلسات سازمانی. روی LAN کنار CPGChat اجرا می‌شود و با **همان JWT / حساب کاربری** لاگین می‌کند.

## استقرار پروداکشن روی meet.cpg-pars.ir

- در Render یک Node Web Service با شاخهٔ `main` و ریشهٔ ریپازیتوری انتخاب کنید.
- Build Command: `npm ci --prefix server && npm ci --prefix web --include=dev && npm run build`
- Start Command: `npm start`
- Health Check Path: `/api/health`
- دامنهٔ `meet.cpg-pars.ir` را به همان Web Service متصل کنید. سرور Node خروجی `web/dist`، مسیرهای `/api` و Socket.IO را روی یک پورت ارائه می‌کند. در صورت استفاده از Cloudflare، این مسیرها و WebSocket باید به همین سرویس هدایت شوند.
- `PORT` از محیط میزبان خوانده می‌شود و سرور روی `0.0.0.0` گوش می‌دهد.
- `web/.env.production` مقدار خالی `VITE_API_URL` دارد تا مرورگر به دامنهٔ جاری متصل شود. برای API جداگانه، origin کامل HTTPS را بدون `/api` هنگام build در `VITE_API_URL` تنظیم و مجدداً build کنید.
- `CPGMEET_WEB_URL=https://meet.cpg-pars.ir` و `CPGCHAT_API_URL` را به آدرس قابل دسترسی سرویس واقعی CPGChat تنظیم کنید؛ مقدار localhost برای یک سرویس چت جداگانه در Render مناسب نیست.
- `JWT_SECRET` و `CPGMEET_NOTIFY_SECRET` باید مقادیر امن و مشترک با CPGChat داشته باشند؛ آن‌ها را در تنظیمات محیط میزبان نگه دارید.
- برای حفظ داده‌ها، `DB_PATH` و `UPLOADS_DIR` را به دیسک پایدار سرویس متصل کنید.
- موفقیت `/api/health` فقط سلامت Meet را نشان می‌دهد؛ ورود کاربران به دسترسی CPGChat نیز وابسته است. اگر ۵۰۳ باقی ماند، لاگ استقرار، وضعیت سرویس و تنظیمات دامنه/پروکسی را بررسی کنید.

## پیش‌نیاز توسعه

- Node.js 18+ (پیشنهادی 20+)
- **CPGChat باید روشن باشد** (پیش‌فرض API روی `http://127.0.0.1:8787`) تا لاگین و لیست کاربران کار کند.

## پورت‌ها

| سرویس | پورت |
|--------|------|
| CPGMeet Web (Vite HTTPS) | `5174` |
| CPGMeet API | `8788` |
| CPGChat Web | `5173` |
| CPGChat API | `8787` |

## متغیرهای محیطی (سرور Meet)

| متغیر | پیش‌فرض | توضیح |
|--------|---------|--------|
| `PORT` | `8788` | پورت API |
| `JWT_SECRET` | `cpgchat-pilot-change-me` | **باید با CPGChat یکی باشد** |
| `CPGCHAT_API_URL` | `http://127.0.0.1:8787` | آدرس API چت (لاگین، کاربران، notify) |
| `CPGMEET_NOTIFY_SECRET` | `cpgmeet-notify-pilot` | **باید با CPGChat یکی باشد** — هدر `X-CPGMeet-Secret` |
| `CPGMEET_WEB_URL` | `https://127.0.0.1:5174` | لینک داخل اعلان‌های CPGChat |
| `DB_PATH` | `D:\Projects\cpgmeet\data\cpgmeet.db` | مسیر SQLite (sql.js) |

در PowerShell (نمونه):

```powershell
$env:JWT_SECRET = "cpgchat-pilot-change-me"
$env:CPGCHAT_API_URL = "http://127.0.0.1:8787"
$env:CPGMEET_NOTIFY_SECRET = "cpgmeet-notify-pilot"
$env:CPGMEET_WEB_URL = "https://127.0.0.1:5174"
```

همان `CPGMEET_NOTIFY_SECRET` را روی سرور CPGChat هم ست کنید (یا از پیش‌فرض مشترک استفاده کنید).

## نصب

```powershell
cd D:\Projects\cpgmeet\server
npm install

cd D:\Projects\cpgmeet\web
npm install
```

یا از ریشه:

```powershell
cd D:\Projects\cpgmeet
npm run install:all
```

## اجرا

ترمینال ۱ — API:

```powershell
cd D:\Projects\cpgmeet\server
npm run dev
```

ترمینال ۲ — Web:

```powershell
cd D:\Projects\cpgmeet\web
npm run dev
```

سپس مرورگر: **`https://127.0.0.1:5174`** (یا `https://<LAN-IP>:5174`).

Vite گواهی‌های `D:\Projects\cpgchat\certs` (`dev-cert.pem` / `dev-key.pem` یا `cpgchat.crt` / `cpgchat.key`) را برای HTTPS می‌خواند تا Desktop Notification در secure context کار کند. پروکسی: `/api` و `/socket.io` → `http://127.0.0.1:8788`.

اگر هشدار گواهی دیدید همان مراحل Trust گواهی CPGChat را انجام دهید، سپس رفرش کنید تا `window.isSecureContext === true`.

**هر دو سرور (Chat + Meet) را بعد از تغییر notify ری‌استارت کنید.**

## تفویض جلسه (از طرف / On behalf)

ادمین می‌تواند برای هر مدیر/معاون (principal) یک یا چند دستیار (assistant) تعریف کند. جدول `meeting_delegates` و فیلد `created_by_id` روی جلسات این را نگه می‌دارند.

## قابلیت‌های MVP

- لاگین با حساب CPGChat
- ایجاد / ویرایش / لغو جلسه + شرکت‌کنندگان
- RSVP: قبول / رد / شاید
- نمای هفتگی + لیست جلسات من
- دانلود `.ics`
- چک‌باکس «۱۵ دقیقه قبل از شروع جلسه، یادآوری کن» (`remind_15`، پیش‌فرض روشن)
- جاب ~۶۰ث: جلسات `remind_15=1` در پنجره now…now+15.5m → `meeting:reminder` + POST به CPGChat
- Desktop Notification در Meet (HTTPS) و بنر/اعلان در CPGChat (`cpgmeet:notify`)
- تفویض جلسه (از طرف)
- **تکرار (recurrence) پیاده نشده** — عمداً برای بعد

## اعلان‌ها ↔ CPGChat

1. Secret مشترک: `CPGMEET_NOTIFY_SECRET` (پیش‌فرض `cpgmeet-notify-pilot`)
2. Meet → `POST ${CPGCHAT_API_URL}/api/internal/cpgmeet/notify` با هدر `X-CPGMeet-Secret`
3. Chat برای هر `userId` سوکت `cpgmeet:notify` می‌فرستد؛ Shell بنر + Desktop Notification نشان می‌دهد

### تست سریع یادآوری

1. Chat و Meet (API+Web) را روشن کنید؛ Meet را روی **HTTPS** باز کنید و اجازه Notification بدهید.
2. جلسه‌ای با شروع ≈ now+10min و چک‌باکس یادآوری روشن بسازید.
3. ظرف ~۱ دقیقه `reminded_at` ست می‌شود؛ نوتیف در Meet و داخل CPGChat ظاهر می‌شود.

## ساختار

```
D:\Projects\cpgmeet\
  README.md
  CPGMeet-Product-Brief.md
  package.json
  data\cpgmeet.db
  server\src\index.js, db.js, auth.js
  web\vite.config.js, src\App.jsx, ...
```
