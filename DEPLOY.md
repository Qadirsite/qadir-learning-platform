# حزمة منصة قادر — دليل النشر

هذه الحزمة تعمل عبر Node.js 22 أو Docker. التطبيق يحتاج MySQL دائمًا لحفظ الحسابات والمحتوى والجلسات، ويحتاج اتصالًا بخدمة Manus API لتشغيل الذكاء الاصطناعي والتخزين المرفق بالنسخة الحالية.

## أسرع تشغيل عبر Docker Compose

1. انسخ `.env.example` إلى `.env` وعدّل القيم، خصوصًا `DATABASE_URL` و`INITIAL_ADMIN_PASSWORD` وبيانات Manus API.
2. شغّل:

```bash
docker compose up -d --build
```

3. افتح `http://SERVER_IP:3000` أو اربط Reverse Proxy مثل Nginx/Cloudflare على المنفذ 3000.

يطبّق الخادم ملفات migrations تلقائيًا عند أول تشغيل. لا تستخدم قاعدة بيانات الإنتاج نفسها للتجربة أو الاختبارات.

## التشغيل على سيرفر Node.js مباشر

```bash
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
# عدّل .env
pnpm start
```

اضبط `PORT` حسب المنفذ الذي يقدمه مزود الاستضافة. يجب أن يستمع الخادم على `0.0.0.0`، ويقدم فحص الصحة من `GET /api/health`.

## المتغيرات الأساسية

- `DATABASE_URL`: رابط MySQL كامل.
- `INITIAL_ADMIN_PASSWORD`: كلمة مرور الحساب الإداري الأول `ak9`، وتستخدم عند إنشاء الحساب لأول مرة فقط.
- `MANUS_API_URL`: عنوان Manus API.
- `MANUS_API_KEY`: مفتاح Manus API؛ لا تضعه داخل ملفات الموقع أو Git.
- `PORT`: المنفذ، الافتراضي `3000`.
- `COOKIE_SECURE`: اتركه `true` مع HTTPS.
- `COOKIE_SAMESITE`: استخدم `Lax` أو `Strict` في النشر العادي، و`None` فقط عند الحاجة إلى تضمين الموقع داخل iframe عبر نطاق مختلف.
- `FRAME_ANCESTORS`: النطاقات المسموح لها بتضمين الموقع داخل iframe.
- `TRUST_PROXY`: اضبطه وفق عدد الوكلاء العكسيين أمام الخادم.

## Reverse Proxy وHTTPS

استخدم HTTPS في الإنتاج، ومرّر `Host` و`X-Forwarded-Proto` إلى التطبيق. لا تضع أسرار API في الواجهة الأمامية. خذ نسخة احتياطية من MySQL قبل ترقية نسخة التطبيق.

## التخزين والذكاء الاصطناعي

رفع الملفات، تحليل PDF/OCR، Whisper، الدردشة، وتحويل الردود إلى صوت تعتمد على بيانات اعتماد Manus API في هذه النسخة. إذا أردت تشغيلًا مستقلًا بالكامل دون Manus Storage/API، يلزم استبدال طبقة التخزين والذكاء الاصطناعي بمزوداتك قبل النشر.

## فحص سريع بعد النشر

```bash
curl -f http://127.0.0.1:3000/api/health
```

ثم جرّب الصفحة الرئيسية، التسجيل، تسجيل الدخول، رفع ملف، والمساعد من خلال HTTPS.
