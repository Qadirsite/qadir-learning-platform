# تقرير تدقيق مشروع قادر

تاريخ التدقيق: 2026-11-16

## النتائج

- `pnpm test`: نجح 110 اختبارًا، دون فشل.
- `pnpm check`: نجح فحص صياغة ملفات الخادم والواجهة، بما فيها `admin-agent.js`.
- `git diff --check`: لا توجد مسافات أو أخطاء تنسيق في التغييرات.
- فحص المراجع المحلية في صفحات HTML: لا توجد ملفات CSS أو JavaScript محلية مفقودة.
- تم استبعاد `node_modules` و`.git` وأي ملفات أسرار محلية من النسخة المضغوطة.

## التشغيل

انسخ `.env.example` إلى `.env` واضبط `DATABASE_URL` و`MANUS_API_URL` و`MANUS_API_KEY` ثم شغّل:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

يتطلب التشغيل قاعدة MySQL وخدمات Manus المعرفة في متغيرات البيئة. لا توجد أسرار فعلية داخل الحزمة.
