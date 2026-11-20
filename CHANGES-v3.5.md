# CHANGES-v3.5.md — GCSA (Claude Sync Antigravity) v3.5.0

## 1. ملخص الإصدار 3.5.0 (GCSA v3.5.0)

يُقدّم الإصدار **3.5.0** التحديث التلقائي لاستهلاك Claude Code على شريط الاستهلاك السفلي في لوحة المتابعة الحية (`src/lib/claude-usage.mjs`)، مع اعتماد الاسم المختصر **GCSA** (**Claude Sync Antigravity**) في العناوين واللوحة والتوثيق مع الحفاظ الكامل على أسماء الحزم والأدوات (`claude-sync-antigravity`, `csa-claude`, `csa-antigravity`).

---

## 2. ما يعمل تلقائيًا بالكامل مقابل ما يحتاج ربط مصدر خارجي (بصدق وشفافية)

### أ. ما يعمل تلقائيًا بالكامل (100% Automatic):
1. **إطلاق التحديث التلقائي (`refreshClaudeUsage({reason})`)**:
   - يعمل تلقائيًا (Fire-and-forget، لا يرمي أي استثناء أبدًا، ومقيّد بـ Throttle مرة كل 20 ثانية) عند:
     - بدء أي مهمة (`startJob`, `createJob`, `startClaudeJob`)
     - انتهاء أي مهمة أو تغيّر حالتها (`updateJob`, `runner.mjs`, `claude-runner.mjs`)
     - تسجيل أي رسالة في أي اتجاه بين Claude وAntigravity (`logMessage` في `src/lib/messages.mjs`)
     - بدء تشغيل خادم الداشبورد وعند استعلام `/api/status`
2. **قراءة وترتيب المصادر الثلاثة تلقائيًا (الأول الصالح يفوز)**:
   - **(أ) ملف اللقطة `<CSA_HOME>/claude-usage.json`**: يُقرأ فورًا إن كان عمره ضمن `claude_usage_max_age_s` (الافتراضي `600` ثانية = 10 دقائق).
   - **(ب) أمر `claude_usage_command` الاختياري في `config.json`**: يُنفَّذ تلقائيًا عند انتهاء صلاحية اللقطة (كمصفوفة `[executable, ...args]` بدون shell وبمهلة 5 ثوانٍ)، ويحصر القيم بين `0` و`100` ويحفظ اللقطة ذريًا.
   - **(ج) آخر قيمة من `csa_board set_usage`**: تُعرض تلقائيًا موسومةً بأنها قديمة (`stale: true`) عند غياب اللقطة الحديثة والأمر.
   - **(عند غياب الجميع)**: يعرض `unavailable` (`غير متاح`) مع السبب الدقيق وتلميحة إعداد قصيرة.
3. **الكتابة الذرية من `csa_board set_usage`**:
   - أي استدعاء لـ `csa_board` بالإجراء `set_usage` يكتب الآن اللقطة ذريًا في `<CSA_HOME>/claude-usage.json` إلى جانب `status.json`.
   - تم تحديث تعليمات خادم MCP (`src/servers/claude-side.mjs`) ليقوم Claude باستدعاء `csa_board set_usage` بالأرقام الحقيقية في بداية كل مهمة مفوّضة.
4. **مؤشر الحداثة في الداشبورد باللغات الثماني**:
   - يظهر تحت أيقونة Claude مباشرةً (`#claudeFreshness`) نص الحداثة (`محدّث منذ N د` / `قديم` / `غير متاح: السبب`) باللغات الثماني (`ar`, `en`, `zh`, `hi`, `es`, `fr`, `pt`, `ru`)، وفي الثيمين (الداكن والفاتح)، ووضع RTL والموبايل.

### ب. ما لا يزال يحتاج أن يربطه المستخدم أو يدفع به Claude (بسبب قيود الخصوصية والأمان الصارمة):
- على عكس تطبيق Antigravity Desktop (الذي يوفر نقطة `GetUserStatus` محلية)، فإن أداة `claude` CLI لا توفر واجهة محلية غير مصادق عليها لقراءة نسبة الحصة المتبقية (5 ساعات / أسبوعي).
- التزامًا صارمًا بقواعد الأمان (عدم قراءة `.credentials.json` أو رموز OAuth أو الكوكيز، وعدم استدعاء نقاط نهاية غير موثقة بتوكنات المستخدم، وعدم تعديل `~/.claude/settings.json` تلقائيًا، وعدم تخمين أرقام وهمية من ملفات المحادثات):
  - تدخل الأرقام الحقيقية إلى `<CSA_HOME>/claude-usage.json` عبر أحد 3 مسارات شفافة:
    1. استدعاء Claude لأداة `csa_board set_usage` عند بدء المهام المفوّضة (مُضاف في تعليمات خادم MCP).
    2. تشغيل المستخدم أو سكربت `statusLine` / Hook خاص به للأداة الجديدة `node scripts/push-claude-usage.mjs --five-hour <pct> --weekly <pct> --resets-at "<time>"` (موثّق في `docs/CLAUDE-USAGE.md` و`docs/INSTALL.md` دون تثبيت تلقائي في `~/.claude`).
    3. ضبط `claude_usage_command` في `%LOCALAPPDATA%\claude-sync-antigravity\config.json` ليشير إلى سكربت محلي يخص المستخدم ويطبع JSON الاستهلاك.

---

## 3. قائمة الملفات المضافة والمعدّلة (`files_changed`)

### ملفات مضافة (جديدة)
1. `src/lib/claude-usage.mjs` — وحدة التحديث التلقائي لاستهلاك Claude Code (`refreshClaudeUsage`, `readCurrentClaudeUsage`, `writeClaudeUsageSnapshot`, `validateAndClampUsage`, `clampUsagePct`, `sanitizeUsageText`, `resetClaudeUsageThrottle`) مع Throttle كل 20 ثانية، وترتيب المصادر `(a) -> (b) -> (c) -> unavailable`، وحماية صارمة تمنع تمرير أي ملفات اعتماد أو أسرار.
2. `scripts/push-claude-usage.mjs` — أداة CLI (`--five-hour`, `--weekly`, `--resets-at`, `--note`, `--json`) تتحقق من القيم وتحصرها بين `0` و`100` وتكتب `<CSA_HOME>/claude-usage.json` و`status.json` ذريًا.
3. `docs/CLAUDE-USAGE.md` — دليل توثيقي لكيفية عمل التحديث التلقائي وكيفية ربط `scripts/push-claude-usage.mjs` أو `claude_usage_command` اختياريًا بـ `statusLine` أو Hook في Claude Code دون أي تعديل تلقائي لملفات `~/.claude`.
4. `test/v35-claude-usage.test.mjs` — حزمة اختبارات شاملة للإصدار 3.5.0 (الـ Throttle، أولوية المصادر، وسم `stale`، الكتابة الذرية، حصر القيم `0-100`، عدم رمي استثناءات عند فشل المصادر أو انتهاء المهلة 5 ثوانٍ، منع قراءة ملفات الاعتماد، والتحديث التلقائي مع `/api/status` واللغات الثماني).
5. `CHANGES-v3.5.md` — هذا الملف التوثيقي للإصدار 3.5.0.

### ملفات معدّلة
6. `config.default.json` — إضافة `"claude_usage_max_age_s": 600` و`"claude_usage_command": null`.
7. `package.json` — ترقية الإصدار إلى `"3.5.0"` وتحديث الوصف باسم `GCSA (Claude Sync Antigravity)` مع الإبقاء على `"name": "claude-sync-antigravity"`.
8. `packaging/manifest.json` — ترقية الإصدار إلى `"3.5.0"` وتحديث `display_name` إلى `"GCSA (Claude Sync Antigravity)"`.
9. `src/servers/claude-side.mjs` — ترقية الإصدار إلى `'3.5.0'` وتحديث `INSTRUCTIONS` باسم `GCSA` وتوجيه Claude لاستدعاء `csa_board` `action="set_usage"` بالأرقام الحقيقية مع بداية كل مهمة مفوّضة.
10. `src/servers/antigravity-side.mjs` — ترقية الإصدار إلى `'3.5.0'`.
11. `src/lib/messages.mjs` — استدعاء `refreshClaudeUsage` تلقائيًا مع كل رسالة مسجّلة في كلا الاتجاهين.
12. `src/lib/store.mjs` — استدعاء `refreshClaudeUsage` تلقائيًا عند إنشاء المهمة (`createJob`) وعند تغيّر حالتها (`updateJob`).
13. `src/lib/jobs-api.mjs` — استدعاء `refreshClaudeUsage` تلقائيًا عند بدء المهمة (`startJob`).
14. `src/runner.mjs` — استدعاء `refreshClaudeUsage` تلقائيًا عند انتهاء المهمة وكتابة النتيجة (`writeResult`).
15. `src/lib/claude-jobs.mjs` — استدعاء `refreshClaudeUsage` تلقائيًا عند بدء مهمة Claude العكسية (`startClaudeJob`).
16. `src/claude-runner.mjs` — استدعاء `refreshClaudeUsage` تلقائيًا عند بدء وانتهاء مهمة Claude العكسية.
17. `dashboard/progress.mjs` — تحديث `--set-usage` ليكتب `<CSA_HOME>/claude-usage.json` ذريًا بالإضافة إلى حفظ `claude_usage` و`claude_usage_last_set` في `status.json`.
18. `dashboard/server.mjs` — استدعاء `refreshClaudeUsage` عند بدء تشغيل خادم اللوحة وفي `/api/status`، وإرجاع `claude_usage` مع الحقلين `updated_at` و`stale` (مع الإبقاء على `claudeUsage` للتوافق الرجعي).
19. `dashboard/index.html` — إضافة عنصر `#claudeFreshness` تحت أيقونة Claude مباشرةً في شريط الاستهلاك السفلي لعرض (`updated N min ago` / `stale` / `unavailable: reason`) وتلميحة الإعداد باللغات الثماني والثيمين وRTL والموبايل، وتحديث العنوان والتذييل إلى `GCSA (Claude Sync Antigravity) v3.5.0`.
20. `dashboard/status.json` — تحديث حالة اللوحة لإصدار `GCSA (Claude Sync Antigravity) v3.5.0`.
21. `docs/INSTALL.md` — توثيق إعدادات التحديث التلقائي لاستهلاك Claude Code وربط `scripts/push-claude-usage.mjs` الاختياري.
22. `README.md` — تحديث التوثيق الإنجليزي إلى `GCSA — Claude Sync Antigravity` الإصدار `3.5.0`.
23. `README.ar.md` — تحديث التوثيق العربي إلى `GCSA — Claude Sync Antigravity` الإصدار `3.5.0`.
24. `CHANGELOG.md` — إضافة قسم `## 3.5.0 (GCSA v3.5.0) - 2026-11-20`.

---

## 4. نتائج الاختبارات (`test/`)

- **إجمالي الاختبارات (`node --test --test-concurrency=1 "test/*.test.mjs"`)**:
  - جميع الاختبارات السابقة (**125 اختبارًا**) + اختبارات v3.5.0 الجديدة (**8 مجموعات اختبارات في `test/v35-claude-usage.test.mjs`**) = **133/133 نجاح (`133 pass, 0 fail`)**.
