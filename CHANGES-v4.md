# CHANGES-v4.md — GCSA (Claude Sync Antigravity) V4 (4.0.0)

## 1. ملخص الإصدار 4.0.0 (GCSA V4)

يتضمّن الإصدار **4.0.0 (GCSA V4)** الحزمة الكاملة التالية (تم التحقق منها بالكامل وتأكيد ظهور الأيقونة والـ Favicon والبيانات الحية بصرياً على لوحة المتابعة):

1. **التحديث التلقائي لاستهلاك Claude Code (`src/lib/claude-usage.mjs`)**:
   - دالة `refreshClaudeUsage({reason})` لا ترمي استثناءات وتعمل بـ Throttle مرة كل 20 ثانية تلقائياً عند بدء المهام، وانتهاء/تغيّر حالة المهام، وكل رسالة في الاتجاهين، وبدء خادم اللوحة.
   - ترتيب المصادر (الأول الصالح يفوز):
     - **(أ)** ملف اللقطة `<CSA_HOME>/claude-usage.json` إذا كان حديثاً ضمن `claude_usage_max_age_s` (الافتراضي `600` ثانية).
     - **(ب)** أمر `claude_usage_command` الاختياري (مصفوفة `[executable, ...args]` بدون shell، بمهلة 5 ثوانٍ، وحصر القيم `0..100`).
     - **(ج)** آخر قيمة من `csa_board set_usage` موسومة كـ `stale: true`.
     - عند غياب الجميع: `unavailable` مع السبب وتلميحة إعداد قصيرة.
   - الكتابة الذرية من `csa_board set_usage` ([dashboard/progress.mjs](dashboard/progress.mjs)) ومن السكربت الجديد [scripts/push-claude-usage.mjs](scripts/push-claude-usage.mjs)، مع توثيق الربط الاختياري بـ `statusLine` / Hook في [docs/CLAUDE-USAGE.md](docs/CLAUDE-USAGE.md) و[docs/INSTALL.md](docs/INSTALL.md) دون أي تعديل تلقائي على `~/.claude` أو قراءة أي ملفات اعتماد/توكنات/كوكيز.
   - مؤشر الحداثة (`#claudeFreshness`) تحت أيقونة Claude في اللوحة باللغات الثماني (`ar`, `en`, `zh`, `hi`, `es`, `fr`, `pt`, `ru`) والثيمين وRTL والموبايل، مع كشف `claude_usage` (`updated_at`, `stale`) في `/api/status`.
   - تم التحقق العملي الحي: حدث التحديث التلقائي فعلياً على اللوحة (`source: "snapshot"`, `stale: false`, `five_hour_remaining_pct: 87`, `weekly_remaining_pct: 57`).

2. **إشعارات استباقية لطلبات الموافقة/الصلاحيات وتوقيت الانتهاء الدقيق (`src/lib/notifications.mjs`)**:
   - تسجيل التوقيت الدقيق للانتهاء (`completed_at` بصيغة ISO-8601) في `result.json` و`agy_wait`/`agy_result` و`agy_list` و`messages.jsonl` و`<CSA_HOME>/notifications.jsonl`.
   - عند ظهور أي طلب موافقة أو صلاحية (`needs_approval` / `commands_requested` / `blocked`) أو عند انتهاء أي مهمة، يتم تسجيل إشعار مهيكل (`approval_needed` أو `task_completed`) في `notifications.jsonl` و`agy_messages` و`/api/status`، وتوجّه تعليمات مهام Desktop ([src/lib/desktop-job.mjs](src/lib/desktop-job.mjs)) و[src/servers/antigravity-side.mjs](src/servers/antigravity-side.mjs) وكيل Antigravity لإخطار جلسة Claude فوراً (مع دعم `notify_session`) ليسأله عن الموافقة أو يُعلمه بلحظة الانتهاء بدقة.

3. **أيقونة GCSA الرسمية في الداشبورد والـ Favicon (`dashboard/gcsa-icon.webp`)**:
   - حفظ أيقونة البرنامج الرسمية في [dashboard/gcsa-icon.webp](dashboard/gcsa-icon.webp) وتقديمها عبر `/logo/gcsa` و`/favicon.ico` و`/gcsa-icon.webp` مع دعم كسر الكاش (`?v=4`) في [dashboard/server.mjs](dashboard/server.mjs).
   - إظهار الأيقونة بجوار اسم البرنامج أعلى الداشبورد (`.brand` / `.brand-ic`) وتعيينها كـ `favicon` للمتصفح في [dashboard/index.html](dashboard/index.html).
   - تم التأكيد البصري من المستخدم بظهور الأيقونة والـ `favicon` بشكل سليم على `http://127.0.0.1:4317`.

4. **ترقية رقم الإصدار إلى `4.0.0 (GCSA V4)`**:
   - تم التحديث في `package.json`، و`packaging/manifest.json`، و`src/servers/claude-side.mjs`، و`src/servers/antigravity-side.mjs`، و`scripts/push-claude-usage.mjs`، و`dashboard/index.html`، و`dashboard/status.json`، و`README.md`، و`README.ar.md`، و`docs/INSTALL.md`، و`docs/CLAUDE-USAGE.md`، و`CHANGELOG.md`.

---

## 2. نتائج الاختبارات والتحقق

- `node --test --test-concurrency=1 "test/*.test.mjs"`: **134/134 نجاح، 0 فشل، 0 متجاوز** (جميع الـ 125 اختباراً السابقة + 9 مجموعات اختبارات في `test/v35-claude-usage.test.mjs`).
- التحقق البصري الحي على `http://127.0.0.1:4317`: ظهرت أيقونة GCSA بجانب العنوان وفي الـ `favicon` بنجاح، وتحديث استهلاك Claude التلقائي يعمل (`stale: false`).

## 3. الحالة النهائية للنشر على GitHub

- جميع الملفات جاهزة وموثّقة ومختبرة بالكامل؛ تم تسليمها وإخطار **Claude** لإتمام مراجعة `git status` وعمل Commit وTag (`v4.0.0`) ورفع النسخة الجديدة **GCSA V4 (4.0.0)** إلى GitHub.
