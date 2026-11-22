# CHANGES-v3.md — Claude Sync Antigravity v3 (3.0.0)

## 1. قائمة الملفات المضافة والمعدّلة (`files_changed`)

### ملفات مضافة (جديدة)
1. `src/lib/transport.mjs` — وحدة اختيار وسيلة الاتصال (`auto` / `desktop` / `cli`)، وبناء رسالة الخطأ الإرشادية الثنائية اللغة (`NO_TRANSPORT`)، وحفظ حالة الاتصال والأخطاء في `<CSA_HOME>/transport-state.json` مع تنقية الأسرار (`redact`).
2. `src/lib/workspace-binding.mjs` — وحدة حارس ربط المشاريع والفولدرات في وضع الديسكتوب (`resolveDesktopProjectBinding`, `discoverAntigravityProjects`, `saveWorkspaceBinding`, `getSavedBinding`, `listWorkspaceBindings`, `fileUriToPath`, `buildProjectBindingRequiredError`): تفحص سجل الروابط المحفوظة (`<CSA_HOME>/workspace-bindings.json`) وتكتشف مشاريع Antigravity Desktop المفتوحة عبر `get-conversation-metadata`، وتوقف المهمة برسالة ثنائية اللغة (`PROJECT_BINDING_REQUIRED`) للسؤال أولًا عن المشروع/المحادثة والفولدر (`cwd`) إن لم يكن المشروع مسجلًا هنا من قبل (مع دعم `conversation_id` و`allow_non_project: true`).
3. `test/fakes/v3-fake-agentapi-fail-connect.mjs` — محاكاة `agentapi` تنجح في فحص الجاهزية (`get-conversation-metadata`) وترفض عند بدء المحادثة (`Unavailable`) لاختبار الرجوع التلقائي وقت التشغيل (`runner.mjs`) من الديسكتوب إلى الـ CLI.
4. `test/v3-transport-usage.test.mjs` — حزمة اختبارات شاملة (11 مجموعة اختبارات) لمنطق `auto`، والرجوع التلقائي، وحارس أمان `auto-run` (عدم التراجع للـ CLI عند الرفض الأمني)، وتنبيه `kind="read"` وفحص `files_changed`، ورسالة الخطأ الثنائية اللغة، وإجراء `csa_board set_usage`، وواجهة وتخطيط لوحة التحكم (`/api/status` و`/`)، وحارس ربط المشاريع والفولدرات (`PROJECT_BINDING_REQUIRED` والربط بـ `conversation_id` والاكتشاف التلقائي و`allow_non_project` وحقن `cwd`).
5. `CHANGES-v3.md` — هذا الملف التوثيقي الشامل لتغييرات الإصدار v3 (`3.0.0`).

### ملفات معدّلة
6. `package.json` — تحديث رقم الإصدار إلى `"3.0.0"` (الإصدار v3).
7. `packaging/manifest.json` — تحديث رقم الإصدار إلى `"3.0.0"`.
8. `config.default.json` — إضافة `"default_target": "auto"` و`"agy_path": ""` و`"require_desktop_project_binding": true` مع الإبقاء على `"allow_desktop_auto_exec": false` و`"allow_desktop_edit": false`.
9. `src/lib/agy.mjs` — تحديث `findAgy()` وإضافة `probeCli()` لفحص مسار `agy` بالترتيب: `CSA_AGY_BIN` ثم `config.agy_path` ثم `%LOCALAPPDATA%\agy\bin\agy.exe` ثم `PATH` (دون امتدادات `.cmd`/`.bat` التي تسبب `EINVAL` مع `shell: false` في Node 20+).
10. `src/lib/desktop.mjs` — إضافة حقل `readable` في `desktopPolicy()` مع الحفاظ الكامل على سلوك `fail-closed` (`auto_exec: true` عند تعذّر قراءة إعدادات التطبيق)، ووسم أخطاء `desktopGate()` برموز `DESKTOP_AUTO_EXEC_REFUSED` و`DESKTOP_EDIT_REFUSED`، وتحصين `agentapi()` و`probeOk()` عند عدم وجود ملف `CSA_AGENTAPI`.
11. `src/lib/desktop-job.mjs` — إضافة ترويسة `workspaceContextHeader(job)` لحقن مسار العمل المطلق `Working Directory (cwd)` والمجلدات الإضافية `Added Directories` في كل مهام الديسكتوب، وإضافة تنبيه القراءة فقط الصريح `DESKTOP_READONLY_NOTICE` لمهام الديسكتوب `kind="read"`، وفحص `files_changed` بعد انتهاء المهمة (`read_only_violation`, `read_only_warning`) في كل من النتيجة الفورية و`adoptLateResult`، ودعم إعادة `{ fallbackNeeded: true, reason }` لـ `runner.mjs` عند فشل الاتصال بـ `newConversation`/`sendMessage` في وضع `auto`، وتسجيل `transport` و`transport_reason`.
12. `src/lib/store.mjs` — إضافة الحقول الافتراضية `requested_target: 'auto'`, `transport: 'cli'`, `transport_reason: null`, `fallback_from: null`, `fallback_reason: null`, `requested_model: null` في سجل المهمة (`createJob`).
13. `src/lib/messages.mjs` — حفظ `transport` و`transport_reason` (بعد تنقيتها بـ `redact`) في كل سطر داخل `messages.jsonl`.
14. `src/lib/jobs-api.mjs` — تصدير `resolveModel`، واستخدام `selectTransport` و`resolveDesktopProjectBinding` في `startJob` لاختيار الوسيلة والتحقق من ربط المشروع/الفولدر في الديسكتوب قبل فتح أي محادثة جديدة، وإرجاع وتخزين `transport` و`transport_reason` و`binding_mode` في `startJob` و`getCompact` و`cancelJob` مع `fallback_from` و`fallback_reason` و`read_only_violation` و`read_only_warning`.
15. `src/runner.mjs` — تنفيذ الرجوع التلقائي وقت التشغيل من الديسكتوب إلى الـ CLI عند فشل الاتصال غير الأمني في مهام `requested_target === 'auto'` (مع إعادة اختيار موديل مناسب للـ CLI وتحديث `job.json` وتسجيل رسالة `kind: 'fallback'` في `messages.jsonl`)، أو إرجاع الخطأ الثنائي اللغة `NO_TRANSPORT` إذا لم يتوفر الـ CLI أيضًا.
16. `src/lib/quota.mjs` — تحديث `summarizeStatus` للاحتفاظ بالموديلات التي لا تملك `quotaInfo` أو `remainingFraction` (مثل `Gemini 4 Carbon`) بقيمة `remaining_pct: null` ليظهر لها «غير متاح» في اللوحة.
17. `src/lib/swarm.mjs` — دعم `target="auto"` في `startSwarm` عبر `selectTransport` مع الإبقاء على التوافق مع اختبارات `orbit-swarm`.
18. `src/tools/core-tools.mjs` — تغيير `target` في `agy_task` ليدعم `['auto', 'cli', 'desktop']` (الافتراضي `auto`)، وإضافة الخيارين `conversation_id` و`allow_non_project` لربط مشاريع الديسكتوب، وتوريث `transport`/`target` عند استخدام `continue_job`، وإضافة `transport` و`transport_reason` و`tier_reason` في `agy_list`.
19. `src/tools/desktop-tools.mjs` — إضافة `allow_non_project` في `agy_desktop_task`، وتحديث `agy_desktop_status` ليمسح خطأ `transport-state.json` تلقائيًا عند توفر الديسكتوب أو الـ CLI وإرجاع حالة `cli` وقائمة `bindings` (المشاريع/الفولدرات المربوطة) إلى جانب `reachable` و`policy`.
20. `src/tools/swarm-tools.mjs` — السماح بقيمة `'auto'` في مخطط `target` لأداة `agy_swarm`.
21. `src/servers/claude-side.mjs` — تحديث الإصدار إلى `'3.0.0'`، وتوسيع `csa_board` بإجراء `set_usage` مع الحقول `{five_hour_remaining_pct, weekly_remaining_pct, resets_at, note}` وتنقية النصوص من أي أسرار قبل الحفظ، دون فتح المتصفح قسرًا عند دفع الاستهلاك.
22. `src/servers/antigravity-side.mjs` — تحديث الإصدار إلى `'3.0.0'`.
23. `src/lib/dashboard.mjs` — تصدير `boardActionToArgv` و`applyBoardAction` و`setClaudeUsage` مع تنقية شاملة لأي مفاتيح أو توكنات (`sanitizeUsageText`).
24. `dashboard/common.mjs` — ضمان استخدام `<CSA_HOME>/status.json` دائمًا عند تعيين `CSA_HOME` لمنع تسرب كتابات الاختبارات إلى `dashboard/status.json` داخل المستودع، مع استمرار قراءة `dashboard/status.json` في وضع المراقبة المحلي.
25. `dashboard/progress.mjs` — دعم الخيار `--set-usage '<json>'` مع التحقق من النسب المئوية (`0..100` أو `null`) وتنقية `resets_at` و`note` من أي توكنات أو أسرار، وحفظ `claude_usage` ذريًا في `status.json`.
26. `dashboard/server.mjs` — تحديث `/api/status` ليُرجع `transportState`، و`security` (`auto_exec_warning`)، و`claudeUsage`، و`antigravityUsage` (دمج `models-cache.json` و`quota.models` و`cfg.tiers` و`usage.by_model` مع حساب `top_model` الأعلى استهلاكًا وعرض `remaining_pct: null` للموديلات بلا حصة)، وإصلاح `claudeLogo()` على ويندوز عبر `(Get-AppxPackage *Claude*).InstallLocation` عندما يرفض النظام `readdirSync` على `WindowsApps`.
27. `dashboard/index.html` — تحديث شامل للوحة التحكم (مُعتمد كتغيير أساسي في المشروع):
    - دعم اللغات الثمانية (`ar`, `en`, `zh`, `hi`, `es`, `fr`, `pt`, `ru`) لكل النصوص الجديدة والـ RTL والثيمين (الفضائي والنهاري) والموبايل.
    - شريط تحذير بارز (`#secWarn`) بكل اللغات الثمانية عند تفعيل `allow_desktop_auto_exec` أو سياسة `AUTO` في التطبيق، بالنص العربي الدقيق: «وضع التنفيذ التلقائي مفعّل: قد ينفّذ التطبيق أوامر دون موافقتك».
    - بطاقة عرض رسالة الخطأ الإرشادية الثنائية اللغة (`#trErr`) عند عدم توفر أي وسيلة اتصال.
    - عرض `transport` و`transport_reason` و`tier_reason` وحالة التراجع (`fallback`) وتحذير القراءة فقط (`read_only_warning`) في بطاقات المهام وسجل المراسلات.
    - **تحديث ثيمات الأيقونات والأفاتار (`char` / `pixel` / `simple`):**
      1. **الكركترز الفضائية (`char` 🤖):** الإبقاء عليها (`charAv` و`ACC`) كما هي تمامًا بدون أي تعديل.
      2. **ثيم البيكسل (`pixel` 👾 — 16-Bit Arcade Heroes):** تصميم شخصيات أركيد بيكسل 16×16 (`pixelAv`) بملامح وجه دافئة، وعيون بيكسل كبيرة تومض (`blink`)، وخدود وابتسامة، وشعر/قبعات/تاج ملكي وبذلة بطل ويد تلوّح (`arm`) لكل عائلة موديل، مع أيقونات بيكسل 16×16 لشعاري Claude وAntigravity.
      3. **الثيم الكرتوني الثالث (`simple` 🦊 — Chibi Cartoon Heroes):** تصميم كركتر كرتوني ثالث مميز ومختلف كليًا عن الفضائي والبيكسل (شخصيات أبطال كرتون/أنمي بأذنين/تاج/قبعة ساحر/سماعات، وعيون أنمي لامعة تومض، وخدود وردية وابتسامة، وبدلة/وشاح ويد تلوّح لكل عائلة موديل).
    - **تخطيط الداشبورد الجديد المُعتمد:**
      1. تثبيت بطاقة **Gindy** (المدير والمشرف العام) دائمًا في المكان الأول كأول وكيل ثابت، وترتيب باقي الوكلاء ديناميكيًا بحيث يظهر **الوكلاء الذين يعملون حاليًا (`working` / `doing`) بجواره مباشرةً بالترتيب**، ثم يليهم الخاملون/المنتهون.
      2. جعل قسم **المراسلات (`#msgs`)** في بطاقة بعرض الصفحة الكامل (`100%` عبر `.msgs-full`).
      3. وضع **سجل النشاط (`#log`)** و**ملفات المشروع (`#files`)** و**الـ Commits (`#commits`)** متجاورين في سطر واحد بتقسيم الشاشة إلى 3 أعمدة متساوية (`.cols3`: `repeat(3, minmax(0, 1fr))` مع التجاوب على الشاشات الصغيرة).
      4. إضافة **شريط الاستهلاكات (`.usage-bar`)** أسفل الأعمدة الثلاثة مباشرةً بالأيقونتين الشخصيتين (Claude وAntigravity بنفس أيقونة/أفاتار الجسر): تحت Claude Code نسبة المتبقي لـ 5 ساعات والأسبوعي وموعد التجدد («غير متاح» إن لم تُدفع عبر `csa_board set_usage` دون اختراع أرقام أو حفظ أي سر)، وتحت Antigravity قائمة منسدلة (`<details id="agyModelsDd">`) تحافظ على حالة فتحها عبر التحديث التلقائي وتعرض في سطر الملخص المغلق الموديل الأعلى استهلاكًا (`top_model`)، وداخلها كل الموديلات مع النسبة المتبقية وموعد التجدد وتوكنات اليوم والإجمالي وعدد المهام، و«غير متاح» للموديلات بلا نسبة مثل `Gemini 4 Carbon`.
28. `dashboard/status.json` — تحديث حالة لوحة المتابعة لـ `Claude Sync Antigravity v3 (3.0.0)` مع سجل الوكلاء والمهام.
29. `test/atlas-tools.test.mjs` — إضافة متغيرات عزل الديسكتوب (`CSA_AGENTAPI`, `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`, `CSA_AG_CONFIG`) لضمان عدم اتصال الاختبار بتطبيق الديسكتوب الحقيقي عند تشغيل الاختبارات مع الافتراضي `target="auto"`.
30. `test/atlas-security.test.mjs` — إضافة `CSA_AGENTAPI` و`CSA_AG_CONFIG` لعزل فحوصات الديسكتوب في بيئة الاختبار.
31. `README.md` — تحديث التوثيق الإنجليزي للإصدار `3.0.0 (v3)` وكل المزايا والإعدادات الجديدة بما فيها حارس ربط المشاريع والفولدرات.
32. `README.ar.md` — تحديث التوثيق العربي للإصدار `3.0.0 (v3)` وكل المزايا والإعدادات الجديدة بما فيها حارس ربط المشاريع والفولدرات.
33. `CHANGELOG.md` — إضافة قسم `## 3.0.0 (v3) - 2026-11-20`.

---

## 2. قرارات التصميم

1. **ترتيب فحص `auto` وحماية `fail-closed`:**
   - عند طلب `target="auto"`, يتم أولًا فحص جاهزية تطبيق Antigravity Desktop عبر `checkApp()` (نفس فحص `agy_desktop_status`).
   - إذا كان الديسكتوب شغّالًا ومتاحًا، يُنفَّذ فحص `desktopGate({ kind }, config)`. إذا رُفض بسبب سياسة التنفيذ التلقائي (`DESKTOP_AUTO_EXEC_REFUSED` أو تعذّر قراءة إعدادات التطبيق `fail-closed`) بينما `allow_desktop_auto_exec=false`، **لا يرجع النظام للـ CLI تلقائيًا** بل يوقف المهمة بالخطأ الأمني الواضح، التزامًا حرفيًا بالمتطلب.
   - إذا كان الديسكتوب غير شغّال عند البدء، أو فشل الاتصال به فجأة وقت التشغيل (`newConversation` / `sendMessage` في `runner.mjs`) لسبب غير أمني، يرجع النظام تلقائيًا للـ CLI مع تسجيل السبب في `transport` و`transport_reason` و`fallback_from` و`fallback_reason` وفي `messages.jsonl` واللوحة.
2. **حارس ربط المشروع والفولدر (`PROJECT_BINDING_REQUIRED`) ومنع النزول العشوائي في `Non-Project`:**
   - نظرًا لأن `language_server.exe agentapi new-conversation` يدعم فقط `--model` و`--title` و`--profile` ولا يقبل `--workspace` (مما يجعل المحادثات الجديدة تنزل في `Non-Project`)، بينما `get-conversation-metadata` يكشف `projectId` و`workspaceUris` للمحادثات القائمة داخل المشاريع:
   - يقوم `resolveDesktopProjectBinding()` بفحص سجل الروابط المحفوظة (`<CSA_HOME>/workspace-bindings.json`) واكتشاف محادثات المشاريع الحديثة في Antigravity Desktop التي تطابق الفولدر `cwd`.
   - إذا لم يكن المشروع/الفولدر مسجلًا أو مربوطًا في Antigravity بعد، **يوقف الجسر المهمة قبل فتح محادثة عشوائية في `Non-Project` ويرجع سؤالًا ثنائي اللغة (`PROJECT_BINDING_REQUIRED`)** يسأل أولًا عن المشروع/المحادثة في Antigravity والفولدر (`cwd`) المراد العمل عليه، مع 3 خيارات: تمرير `conversation_id` (ويُحفظ الربط تلقائيًا)، أو فتح المجلد كمشروع في Antigravity Desktop، أو تمرير `allow_non_project: true`.
   - بالإضافة إلى ذلك، تحقن كل مهمة ديسكتوب ترويسة `WORKSPACE CONTEXT (Working Directory cwd + Added Directories)` في بداية الرسالة حتى يعرف الوكيل مسار المجلد فورًا.
3. **التوافق مع الاختبارات السابقة في مهام القراءة على الديسكتوب (`kind="read"`):**
   - لأن `test/orbit-desktop.test.mjs` و`test/orbit-tools.test.mjs` يستخدمان `orbit-fake-agentapi.mjs` الذي يُرجع `files_changed: ['a.txt']` مع التحقق من ثبات `summary === 'fake agent finished'` و`warning === DESKTOP_WARNING`، صُمّم فحص `files_changed` بعد مهام `kind="read"` ليُضيف الحقول الصريحة `read_only_violation: true` و`read_only_warning` ويُلحق التنبيه بـ `handoff_notes` وسجل الرسائل واللوحة دون كسر حقلي `summary` و`warning`.

---

## 3. نتيجة الاختبارات وفحوصات الصياغة (بصدق)

- **فحص الصياغة الفعلي (`node --check`):** تم فحص جميع ملفات `.mjs` في `src/` و`dashboard/` و`test/` بنجاح تام (`ALL SYNTAX OK`, exit code `0`).
- **اختبارات v3 الجديدة (`node --test --test-concurrency=1 test/v3-transport-usage.test.mjs`):** نجحت جميعها — **11/11 pass, 0 fail** (تشمل اختبارات `auto` والرجوع التلقائي وحارس `auto-run` وتنبيه `read-only` والخطأ الثنائي اللغة و`set_usage` وحارس ربط المشاريع `PROJECT_BINDING_REQUIRED`).
- **حزمة الاختبارات الكاملة (`node --test --test-concurrency=1 "test/*.test.mjs"`):** نجحت جميعها بالكامل — **125/125 pass, 0 fail, 0 skipped**، بما فيها كل اختبارات التوافق الرجعي (`atlas-*`, `echo-*`, `lead-*`, `orbit-*`) واختبارات `v3-transport-usage.test.mjs`.
- **المراجعة الثابتة وفحص الواجهة الحية (`http://127.0.0.1:4318/`):** تم التحقق من استجابة `/api/status` و`/` و`/logo/claude` (`200 OK`, `39081 bytes`) و`/logo/antigravity` (`200 OK`, `48633 bytes`) وثيمات الأيقونات الثلاثة (`char` و`pixel` 16×16 و`simple` الكلاسيكي).
