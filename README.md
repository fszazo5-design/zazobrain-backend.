# ZazoBrain API (`zazobrain-api`)

Backend مستقل يعمل على Cloudflare Workers. يحفظ D1 بيانات المحتوى وروابط الوسائط ومعرّفات Cloudinary فقط؛ أما ملفات الصور والفيديو نفسها فتُرفع مباشرةً من المتصفح إلى Cloudinary. لا توجد BLOBs أو ملفات وسائط في D1، ولا يلزم R2.

## الإعداد والنشر

1. قاعدة D1 المستهدفة اسمها `zazobrain-db`، ومعرّفها مضبوط في `wrangler.toml`. اسم العامل `zazobrain-api`، وأصل Pages المسموح مضبوط إلى `https://zazobrain.pages.dev`.
2. أضف أسرار العامل تفاعليًا، ولا تحفظها في ملفات المستودع أو في `[vars]`:

   ```sh
   npx wrangler secret put CLOUDINARY_API_SECRET
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   ```

   `SESSION_SECRET` يجب أن يكون عشوائيًا بطول 32 حرفًا على الأقل. `ADMIN_PASSWORD` كلمة مرور لوحة الإدارة. اسم Cloudinary ومفتاح API العام مضبوطَان كـvars في `wrangler.toml`.
3. اختبر ثم طبّق migration على قاعدة الإنتاج وانشر:

   ```sh
   npm test
   npx wrangler d1 migrations apply zazobrain-db --remote
   npx wrangler deploy
   ```
4. لبناء الواجهة اضبط `VITE_CONTENT_API_URL` على `https://zazobrain-api.<account>.workers.dev` ثم ابنِها وانشر ناتج Vite إلى مشروع Pages `zazobrain`.

للتطوير المحلي، استخدم `npx wrangler d1 migrations apply zazobrain-db --local` ثم `npx wrangler dev`، وضع الأسرار المحلية في `.dev.vars` غير المتعقب من Git.

## التخزين والأمان

- D1 يحفظ السجل الوصفي، روابط الصورة/الفيديو، و`public_id` الخاص بكل أصل Cloudinary. لا يحفظ bytes الوسائط.
- لوحة الإدارة تطلب من `POST /api/media/sign` توقيعًا بعد التحقق من JWT، ثم ترفع الملف مباشرةً إلى Cloudinary. لا يصل `CLOUDINARY_API_SECRET` إلى المتصفح.
- الرفع الموقّع يولّد `public_id` عشوائيًا تحت `zazobrain/` مع `overwrite=false`. الأنواع المدعومة في الواجهة هي PNG/JPEG/WebP/GIF للصور وMP4/MOV/WebM للفيديو.
- يجب تعيين `ALLOWED_ORIGINS` إلى أصول الموقع الدقيقة؛ لا تستخدم `*`.
- حذف سجل محتوى يحذف السجل من D1 ويحاول حذف أصول Cloudinary المسجلة معه. تعيد الاستجابة `mediaDeleted` لحالة التنظيف.
- كل استعلامات D1 تستخدم prepared statements، وPOST/DELETE وتوقيع الرفع محمية بـBearer JWT.

## عقد API

- `POST /api/login` — body `{ "password": "..." }`; يعيد `{ "token": "<JWT>", "expiresAt": "<ISO-8601>" }`. الرمز HMAC-SHA256 صالح 8 ساعات.
- `GET /api/content` — عام؛ يعيد `{ "items": [...] }`. مرشح اختياري `?kind=project|system-video|content-video`.
- `POST /api/media/sign` — يتطلب Bearer JWT؛ body `{ "resourceType": "image"|"video" }`. يعيد بيانات رفع موقّعة صالحة للرفع المباشر، من دون كشف سر Cloudinary.
- `POST /api/content` — يتطلب Bearer JWT؛ يضيف سجلًا ويعيد `{ "item": ... }`. يدعم حقول المحتوى الحالية، إضافةً إلى `imagePublicId`, `imageResourceType`, `videoPublicId`, و`videoResourceType` للوسائط التي رُفعت إلى Cloudinary. يقبل روابط HTTP(S) خارجية أيضًا. لا يقبل `imageData` أو باينري.
- `DELETE /api/content` — يتطلب Bearer JWT؛ body `{ "id": "..." }`. يحذف السجل ويحاول تنظيف ملفات Cloudinary المرتبطة.

استجابة المحتوى تتضمن `id`, `kind`, `title`, `description`, `category`, `imageUrl`, `contentUrl`, `technologies`, `topic`, `views`, `duration`, `date`, `image`, `thumbnail`, `videoUrl`, `createdAt`, و`updatedAt`. `image` alias لـ`imageUrl`.

---

# English

Standalone Cloudflare Worker backend. D1 stores content metadata, media URLs, and Cloudinary public IDs only; image and video bytes are uploaded directly from the browser to Cloudinary. No media BLOBs are stored in D1, and no R2 binding is needed.

## Setup and deployment

1. The configured D1 database is `zazobrain-db`; its ID is in `wrangler.toml`. The Worker is `zazobrain-api`, with Pages origin `https://zazobrain.pages.dev` allowed.
2. Add Worker secrets interactively; never put them in source files or `[vars]`:

   ```sh
   npx wrangler secret put CLOUDINARY_API_SECRET
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   ```

   `SESSION_SECRET` must be random and at least 32 characters. `ADMIN_PASSWORD` protects the admin dashboard. The Cloudinary cloud name and public API key are configured as vars in `wrangler.toml`.
3. Test, apply the migration to production D1, and deploy:

   ```sh
   npm test
   npx wrangler d1 migrations apply zazobrain-db --remote
   npx wrangler deploy
   ```
4. Set frontend `VITE_CONTENT_API_URL` to `https://zazobrain-api.<account>.workers.dev`, build Vite, and deploy its output to Pages project `zazobrain`.

For local development, apply `npx wrangler d1 migrations apply zazobrain-db --local`, run `npx wrangler dev`, and put local secrets in an untracked `.dev.vars` file.

## Storage and security

- D1 stores each content row, image/video URLs, and the Cloudinary public ID for each uploaded asset. It does not store media bytes.
- The admin dashboard requests a signed upload from `POST /api/media/sign` after JWT authorization, then uploads directly to Cloudinary. `CLOUDINARY_API_SECRET` never reaches the browser.
- Signed uploads use a random `public_id` under `zazobrain/` and `overwrite=false`. The UI supports PNG/JPEG/WebP/GIF images and MP4/MOV/WebM video.
- Set `ALLOWED_ORIGINS` to exact site origins; do not use `*`.
- Deleting a content row removes it from D1 and attempts to delete its registered Cloudinary assets. The response includes `mediaDeleted`.
- All D1 queries use prepared statements; POST/DELETE and upload signing require a Bearer JWT.

## API contract

- `POST /api/login` — body `{ "password": "..." }`; returns `{ "token": "<JWT>", "expiresAt": "<ISO-8601>" }`. The HMAC-SHA256 token expires after 8 hours.
- `GET /api/content` — public; returns `{ "items": [...] }`. Optional filter: `?kind=project|system-video|content-video`.
- `POST /api/media/sign` — Bearer JWT required; body `{ "resourceType": "image"|"video" }`. Returns signed direct-upload parameters without exposing the Cloudinary secret.
- `POST /api/content` — Bearer JWT required; creates a row and returns `{ "item": ... }`. In addition to content fields, it accepts `imagePublicId`, `imageResourceType`, `videoPublicId`, and `videoResourceType` for uploaded Cloudinary assets. External HTTP(S) links are also supported. `imageData` and binary payloads are rejected.
- `DELETE /api/content` — Bearer JWT required; body `{ "id": "..." }`. Deletes the row and attempts Cloudinary cleanup for associated assets.

Records include `id`, `kind`, `title`, `description`, `category`, `imageUrl`, `contentUrl`, `technologies`, `topic`, `views`, `duration`, `date`, `image`, `thumbnail`, `videoUrl`, `createdAt`, and `updatedAt`. `image` aliases `imageUrl`.
