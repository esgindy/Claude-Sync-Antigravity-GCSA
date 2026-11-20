# GCSA — Claude Sync Antigravity

**الإصدار 3.5.0 (GCSA v3.5.0)**

> **ملاحظة مهمة:** هذه أداة غير رسمية من تطوير **Eslam Elgindy**. ليست تابعة لشركة Anthropic أو Google، ولا معتمدة منهما أو مدعومة منهما. Claude علامة تجارية مسجلة لشركة Anthropic، وAntigravity علامة تجارية مسجلة لشركة Google.

<p align="center"><a href="README.md"><b>English</b></a> &nbsp;|&nbsp; <b>العربية</b></p>

<p align="center"><img src="docs/images/gcsa-poster-ar.png" alt="GCSA: كلود يفكر وأنتيجرافيتي ينفذ" width="520"></p>

## ما الذي تفعله الأداة؟

يربط **GCSA** (**Claude Sync Antigravity**) بين Claude وGoogle Antigravity في الاتجاهين. Claude هو **العقل**: يخطط للعمل ويراجع النتائج. وكلاء Antigravity هم **العضلات**: ينفذون المهام. إرسال التنفيذ الثقيل إلى Antigravity يوفّر tokens من Claude، وتختار الأداة النموذج المناسب لكل مهمة.

الجسر يعمل في الاتجاهين:

- **من Claude إلى Antigravity**: يرسل Claude Code وClaude Desktop المهام إلى Antigravity عبر خادم MCP اسمه `csa-claude`.
- **من Antigravity إلى Claude**: يطلب Antigravity من Claude مراجعة نتيجة أو تولّي مهمة، عبر خادم MCP اسمه `csa-antigravity`.

## المميزات

- **تفويض المهام مع اختيار النموذج تلقائياً.** يُختار النموذج حسب حجم المهمة ونوعها. إذا كانت حصة النموذج المختار قليلة، تنتقل الأداة إلى النموذج التالي.
- **اختيار أي نموذج متاح.** يمكنك تحديد النموذج بنفسك بدلاً من الاختيار التلقائي.
- **الهدف الافتراضي `auto` (تفضيل Desktop ثم CLI احتياطياً) (`v3`).** تستخدم أداة `agy_task` الوضع `target="auto"` افتراضياً (`default_target: "auto"`). تفحص الأداة أولاً هل تطبيق Antigravity Desktop يعمل ويمكن الوصول إليه (`agy_desktop_status`) وتستخدم Desktop أولاً (وفق قيود `allow_desktop_auto_exec` و`allow_desktop_edit` والإغلاق عند الخطأ)، وإلا تنتقل احتياطياً إلى `agy` CLI (عبر `agy_path` في `config.json`، أو `%LOCALAPPDATA%\agy\bin\agy.exe`، أو `PATH`). كما يظل تحديد `target="cli"` أو `target="desktop"` صراحةً متاحاً.
- **الانتقال التلقائي وقت التشغيل عند الأعطال غير الأمنية فقط (`v3`).** إذا فشل وضع Desktop أو رفض التنفيذ لسبب غير أمني (مثل تعذّر الوصول للتطبيق فجأة أو انتهاء مهلة الاتصال)، ينتقل وضع `auto` تلقائياً إلى CLI مع تسجيل السبب (`transport` و`transport_reason`). أما الرفض الناتج عن بوابة الأمان `auto-run` فلا ينتقل تلقائياً إلى CLI أبداً.
- **رسالة إرشاد ثنائية اللغة عند عدم توفر أي مسار نقل (`v3`).** عندما لا يتوفر لا Desktop ولا CLI، تُرجع الأداة خطأً تشخيصياً منظماً بالعربية والإنجليزية يوضح ما تم فحصه لكلٍ من Desktop وCLI، وخطوات الإصلاح المرتبة (بما فيها `agy_path` في `config.json`، و`agy --version`، وفحص تسجيل الدخول، و`agy_desktop_status`)، وتعرضه أيضاً في لوحة المتابعة.
- **حارس ربط المشروع والمجلد في وضع Desktop (`v3`).** لأن الأمر `agentapi new-conversation` لا يقبل الخيار `--workspace` ويضع المحادثات الجديدة في قسم `Non-Project` دون ربطها بمجلد مساحة عمل، تحمي الأداة مهام Desktop (`agy_desktop_task` أو `agy_task` عند اختيار Desktop عبر `auto`) التي تستهدف مجلداً (`cwd`). تفحص الأداة ارتباطات مساحة العمل المحفوظة (`workspace-bindings.json`) وتكتشف تلقائياً محادثات مشاريع Antigravity Desktop الأخيرة (`get-conversation-metadata`) المطابقة للمجلد `cwd`. وإذا لم يكن المشروع/المجلد (`cwd`) مسجلاً أو مربوطاً في Antigravity بعد، **توقف الأداة المهمة وتُرجع سؤالاً ثنائي اللغة (`PROJECT_BINDING_REQUIRED`)** يسأل Claude/المستخدم عن مشروع/محادثة Antigravity والمجلد (`cwd`) المطلوب الربط بهما—مع ثلاثة خيارات: تمرير `conversation_id`، أو فتح المجلد كمشروع في Antigravity Desktop، أو تمرير `allow_non_project: true`. كما تحقن جميع مهام Desktop ترويسة `WORKSPACE CONTEXT` صريحة (`Working Directory (cwd)` و`Added Directories`) ليعرف وكيل Antigravity المجلد المستهدف بدقة فوراً.
- **وضع Desktop وحماية القراءة فقط.** تظهر المهام داخل تطبيق Antigravity لمتابعتها مباشرة. ولأن وضع Desktop لا يفرض وضع `plan` الخاص بـ CLI، تحقن مهام Desktop من نوع `kind="read"` تحذيراً صريحاً بعدم تعديل أي ملف، ثم تفحص `files_changed` بعد الانتهاء وتُعلِم عن أي تعديل غير متوقع (`read_only_violation` و`read_only_warning`).
- **لوحة المتابعة المباشرة وشريط الاستخدام مع التحديث التلقائي (`v2` + `v3` + `v3.5.0`).** تُفتح تلقائياً عند أول تفويض للمشروع (`dashboard_auto_open`)، وتعرض كل الوكلاء والمهام على لوحة واحدة (`csa_board` و`csa_dashboard`)، وتسجّل `transport` و`transport_reason`، وتعرض شريط تحذير بارزاً للتنفيذ التلقائي بجميع اللغات الـ 8 عند تفعيله، وتضم شريط استخدام سفلياً لحصص Claude Code ونماذج Antigravity مع تحديث تلقائي لاستهلاك Claude Code (`refreshClaudeUsage` بمعدّل مرة كل 20 ثانية كحد أقصى) عند بدء أي مهمة، أو انتهائها/تغيّر حالتها، أو تسجيل أي رسالة في أي اتجاه، وعند بدء تشغيل خادم اللوحة.
- **تقرير الاستخدام.** يعرض عدد الـ tokens المستخدمة، والحصة المتبقية لكل نموذج، ووقت تجديد كل حصة (`usage.by_model`).
- **وضع Swarm.** يشغّل عدة وكلاء بالتوازي (وضع split)، أو يشغّل الطلب نفسه على 2 إلى 3 نماذج ويقارن الإجابات (وضع compare).
- **الاتجاه العكسي.** يمكن لـ Antigravity أن يطلب من Claude المراجعة أو تولّي المهمة. حد عدد التحويلات (الافتراضي 3) يمنع الدوران بلا نهاية.
- **سجل الرسائل.** تُسجَّل كل الرسائل في الاتجاهين (مع `transport` و`transport_reason`) وتظهر في لوحة المتابعة.

## الأدوات

### `csa-claude` (يستخدمه Claude Code وClaude Desktop)

| الأداة | الوظيفة |
| --- | --- |
| `agy_task` | بدء مهمة على Antigravity (قراءة أو تعديل). الافتراضي `target="auto"` (Desktop أولاً إذا كان متاحاً وآمناً، وإلا `agy` CLI)؛ مع دعم التحديد الصريح `target="cli"` أو `target="desktop"`. |
| `agy_wait` | الانتظار حتى تنتهي مهمة تعمل، حتى 50 ثانية في كل مرة. |
| `agy_result` | قراءة نتيجة مهمة انتهت (وتشمل `transport` و`transport_reason` وأعلام `read_only_violation` / `read_only_warning` عند حدوثها). |
| `agy_approve` | تنفيذ الأوامر التي طلبها Antigravity، حسب `job_id` وأرقامها، ثم متابعة المهمة (خيار `rerun`). |
| `agy_cancel` | إلغاء مهمة تعمل. |
| `agy_list` | عرض المهام الأخيرة. |
| `agy_models` | عرض النماذج المتاحة، والحصة المتبقية لكل نموذج، وفئته. |
| `agy_usage` | عرض تقرير الاستخدام والحصة (`usage.by_model`: الـ tokens والمهام والنسبة المتبقية ووقت التجديد). |
| `agy_messages` | عرض سجل الرسائل (بما في ذلك `transport` و`transport_reason`). |
| `agy_desktop_task` | بدء مهمة مباشرة داخل تطبيق Antigravity على الكمبيوتر. |
| `agy_desktop_status` | فحص جاهزية تطبيق Antigravity Desktop وبوابة الأمان أو متابعة مهمة Desktop. |
| `agy_swarm` | بدء تشغيل متوازٍ (split أو compare). |
| `agy_swarm_status` | متابعة تشغيل Swarm. |
| `csa_dashboard` | فتح أو إعادة فتح لوحة المتابعة المباشرة للمشروع في المتصفح. |
| `csa_board` | تحديث لوحة المتابعة بوكلاء Claude والخطة (`project` و`add_agent` و`add_task` و`set_task` و`now`) وإرسال حصة Claude Code (`set_usage {five_hour_remaining_pct, weekly_remaining_pct, resets_at, note}`) الذي يحفظ اللقطة ذرياً أيضاً في `<CSA_HOME>/claude-usage.json`. |

### `csa-antigravity` (يستخدمه Antigravity)

| الأداة | الوظيفة |
| --- | --- |
| `claude_review` | طلب مراجعة من Claude لما نفّذه Antigravity (خيار `model`). يراجع Claude بالقراءة فقط ويرد بـ `approve` أو `changes` مع ملاحظات. |
| `claude_task` | تسليم مهمة إلى Claude (خيار `model`). |
| `claude_wait` | الانتظار حتى تنتهي مهمة Claude. |
| `claude_result` | قراءة نتيجة مهمة Claude. |

## لوحة المتابعة المباشرة وشريط الاستخدام (`v2` + `v3` + `v3.5.0`)

- **الفتح التلقائي وإعادة الفتح:** تُفتح اللوحة تلقائياً على `http://localhost:4317` (`dashboard_port`) عند أول تفويض عمل في المشروع (`dashboard_auto_open: true`). ويمكن إعادة فتحها في أي وقت عبر `csa_dashboard`.
- **جسر الفضاء واللوحة الموحدة:** تستخدم أيقونات Claude وAntigravity الحقيقية (تُقرأ من التطبيقات المثبتة وليست مضمّنة)، مع خطوط ألياف تضيء مع كل رسالة في الاتجاهين. يظهر `Gindy` (`id: "gindy"`) كمدير ومشرف إلى جانب وكلاء Claude المسجّلين عبر `csa_board` ومهام Antigravity ومهام مراجعة Claude. يتحول لون الوكلاء الخاملين أو المنتهين إلى الرمادي وتتوقف حركتهم.
- **التخصيص:** ثلاثة أنماط للشخصيات (روبوتات كرتونية، شخصيات بكسل، بسيط)، ومظهر داكن/فاتح، و8 لغات.
- **ظهور مسار النقل والتشخيص:** تُسجَّل قيم `transport` (`desktop` أو `cli`) و`transport_reason` في نتائج المهام وسجل الرسائل ولوحة المتابعة. وعند غياب كلا المسارين، تظهر رسالة التشخيص الثنائية اللغة (العربية + الإنجليزية) وخطوات الإصلاح المرتبة داخل اللوحة أيضاً.
- **شريط تحذير التنفيذ التلقائي (بـ 8 لغات):** يظهر شريط تحذير بارز بجميع اللغات الـ 8 كلما كان `allow_desktop_auto_exec` مفعّلاً أو كانت سياسة التشغيل التلقائي (`auto-run`) نشطة في تطبيق Antigravity.
- **شريط الاستخدام السفلي والتحديث التلقائي لاستهلاك Claude (`v3` + `v3.5.0`):**
  - **حصة Claude Code الإجمالية (`v3.5.0` تحديث تلقائي):** تعمل الدالة `refreshClaudeUsage({reason})` في `src/lib/claude-usage.mjs` تلقائياً (دون إيقاف التنفيذ أو رمي استثناءات، وبمعدّل مرة كل 20 ثانية كحد أقصى) عند بدء أي مهمة، أو انتهائها/تغيّر حالتها، أو تسجيل أي رسالة في الاتجاهين، وعند بدء تشغيل خادم اللوحة. وتفحص ثلاثة مصادر بالترتيب (أول مصدر صالح يفوز):
    1. ملف اللقطة `<CSA_HOME>/claude-usage.json` (`{five_hour_remaining_pct, weekly_remaining_pct, resets_at, note, updated_at}`) إذا كان حديثاً ضمن `claude_usage_max_age_s` (الافتراضي `600` ثانية). يُكتب هذا الملف ذرياً عبر `csa_board` `set_usage` أو عبر الأداة `node scripts/push-claude-usage.mjs --five-hour <pct> --weekly <pct> --resets-at "<time>"`.
    2. الأمر الاختياري `claude_usage_command` في `config.json` (مصفوفة `[executable, ...args]` وليس نص shell، بمهلة 5 ثوانٍ، يطبع نفس JSON مع التحقق وحصر القيم بين `0` و`100`).
    3. آخر قيمة دُفعت عبر `csa_board` `set_usage` مع وسمها كبيانات قديمة (`stale: true`).
    وإذا لم يتوفر أي مصدر، تعرض اللوحة `غير متاح: <السبب>` مع تلميحة إعداد قصيرة. كما يظهر نص الحداثة مباشرةً تحت أيقونة Claude (`محدّث منذ N د` / `قديم` / `غير متاح: السبب`) بجميع اللغات الـ 8، وفي الثيمين، ووضع RTL والموبايل، ويعرض `/api/status` كائن `claude_usage` بالحقلين `updated_at` و`stale`. لا يتم أبداً قراءة ملفات الاعتماد أو رموز OAuth أو ملفات تعريف الارتباط أو `.credentials.json` أو تلفيق أرقام من السجلات (راجع [docs/CLAUDE-USAGE.md](docs/CLAUDE-USAGE.md)).
  - **القائمة المنسدلة لنماذج Antigravity:** يعرض السطر المختصر المطوي النموذج الأعلى استهلاكاً، وعند فتح القائمة تظهر النسبة المتبقية للحصة ووقت التجديد وإجمالي tokens واليوم والمهام لكل نموذج من `usage.by_model`. والنماذج التي لا توفر نسب حصة (مثل `Gemini 4 Carbon`) تعرض `غير متاح` (`Unavailable`).

## الأمان

- **القراءة فقط افتراضياً وحماية القراءة فقط في Desktop.** مهام القراءة في CLI تعمل في وضع `plan` ولا تغيّر الملفات. وبما أن وضع Desktop لا يفرض وضع `plan`، تحقن مهام Desktop من نوع `kind="read"` تحذيراً صريحاً بعدم التعديل وتفحص `files_changed` بعد الانتهاء للإبلاغ عن أي تغييرات غير متوقعة (`read_only_violation` و`read_only_warning`).
- **لا يوجد تجاوز للصلاحيات.** لا تستخدم الأداة الخيار `--dangerously-skip-permissions` مع Claude أو Antigravity أبداً.
- **موافقة على الأوامر.** الأوامر التي يطلب Antigravity تنفيذها تُعرض أولاً، ولا تُنفَّذ إلا إذا وافقت عليها برقمها عبر `agy_approve`.
- **حجب الملفات السرية.** ترفض الأداة ملفات مثل `config.php` و`.env*` و`*.pem` و`*.key` و`id_rsa*` و`credentials*` و`secrets*` و`*.kdbx` وأي شيء داخل `.git/`.
- **رمز CSRF لا يُحفظ أبداً.** يُمرَّر رمز Antigravity فقط إلى عملية فرعية أو إلى ترويسة HTTP. لا يُكتب في ملف أو سجل أو نتيجة.
- **لا تلفيق للحصص ولا حفظ لبيانات اعتماد Claude.** تعرض حصة Claude Code `غير متاح` (`Unavailable`) حتى تُرسل عبر `csa_board` `set_usage`، دون تخمين أرقام أو حفظ tokens أو أسرار.
- **تنظيف المخرجات.** يُزال أي رمز أو سطر أوامر قد يظهر في رسائل الخطأ قبل عرضها أو تسجيلها.
- **حد التحويلات.** لا تتجاوز سلسلة المهمة التنقل بين Claude وAntigravity أكثر من 3 مرات افتراضياً.
- **تحذير وضع Desktop.** يعمل وضع Desktop بإعدادات الصلاحيات الخاصة بتطبيق Antigravity نفسه، وقد ينفّذ التطبيق الأوامر دون أن يسألك. راجع هذه الإعدادات قبل استخدام الوضع.
- **رفض التنفيذ التلقائي في Desktop (دون التفاف عبر CLI).** يُرفض وضع Desktop إذا كان التطبيق مضبوطاً على تنفيذ الأوامر تلقائياً (`auto-run`). غيّر إعداد التطبيق إلى "Request review"، أو ضع `allow_desktop_auto_exec` على `true` في ملف `config.json` الخاص بك لقبول المخاطرة (وهو ما يُظهر أيضاً شريط التحذير بـ 8 لغات في اللوحة). والرفض الصادر من بوابة أمان `auto-run` **لا ينتقل تلقائياً إلى CLI أبداً** في وضع `auto`.
- **مهام تعديل Desktop مغلقة افتراضياً.** تبقى `allow_desktop_edit` على `false` في `config.default.json`، ولا تُفعَّل إلا في ملف `config.json` الخاص بالمستخدم.
- **الإغلاق عند الخطأ.** إذا تعذّرت قراءة إعدادات التطبيق، تُعامل الأداة الإعدادات على أنها تنفيذ تلقائي، فيُرفض وضع Desktop.
- **مهام Claude في الاتجاه العكسي مقيّدة.** تستخدم `--setting-sources user`، وتمنع Bash وPowerShell، ولا تحمّل أي خوادم MCP.
- **مواقع محجوبة.** المجلدات `.claude` و`.gemini` و`.ssh` و`.aws` و`.git`، وملفات بيانات الاعتماد، وجذور الأقراص، ومجلد ملف المستخدم الشخصي، كلها مرفوضة.
- **معرّفات السلاسل من الخادم.** يُنشئ الخادم معرّفات السلاسل وليس المتصل. تنطبق حدود يومية على عدد المهام وتكلفة Claude.
- **لوحة المتابعة محلية.** تجيب اللوحة فقط على الطلبات القادمة من localhost.

## المتطلبات

- نظام Windows
- Node.js الإصدار 20 أو أحدث
- تطبيق Antigravity على الكمبيوتر و/أو أداة `agy` CLI (مثبتة ومسجَّل الدخول فيها)؛ يفضّل وضع `auto` تطبيق Desktop العامل ثم ينتقل احتياطياً إلى `agy` CLI
- Claude Code (و/أو Claude Desktop)

## التثبيت

باختصار: ثبّت المكتبات، ثم سجّل خادمَي MCP لدى Claude ولدى Antigravity.

```powershell
cd "<path>\Claude-Sync-Antigravity"
npm install
npm run dashboard
```

اسم الخادم في Claude Code هو `csa`.

الخطوات الكاملة، بما فيها امتداد Claude Desktop وإعداد Antigravity، موجودة في [docs/INSTALL.md](docs/INSTALL.md).

## الإعدادات

القيم الافتراضية موجودة في ملف `config.default.json` داخل مجلد المشروع. لتغييرها، أنشئ الملف `%LOCALAPPDATA%\claude-sync-antigravity\config.json`. المفاتيح الموجودة فيه تتجاوز القيم الافتراضية، ويكفي أن تكتب المفاتيح التي تريد تغييرها فقط.

| المفتاح | القيمة الافتراضية | ماذا يفعل |
| --- | --- | --- |
| `tiers` | قوائم النماذج fast وbalanced وdeep | النماذج التابعة لكل فئة، حسب ترتيب الأفضلية. |
| `default_tier` | `auto` | الفئة المستخدمة عندما لا تحدد المهمة فئة. `auto` يختار حسب حجم المهمة ونوعها. |
| `default_target` | `"auto"` | الهدف الافتراضي لأداة `agy_task`: `"auto"` (Desktop أولاً عبر `agy_desktop_status` ثم `agy` CLI احتياطياً)، أو `"desktop"`، أو `"cli"`. |
| `agy_path` | `""` | مسار اختياري صريح للملف التنفيذي `agy` CLI. عند تركه فارغاً تفحص الأداة `%LOCALAPPDATA%\agy\bin\agy.exe` و`PATH`. |
| `require_desktop_project_binding` | `true` | يلزم مهام Desktop التي تستهدف `cwd` بالارتباط بمحادثة مشروع مسجّلة في Antigravity Desktop (عبر `workspace-bindings.json` أو `get-conversation-metadata`)؛ ويوقف المهمة بسؤال ثنائي اللغة (`PROJECT_BINDING_REQUIRED`) إذا لم يكن المجلد مربوطاً، ما لم يُمرَّر `conversation_id` أو `allow_non_project: true`. |
| `claude_usage_max_age_s` | `600` | أقصى عمر بالثواني (10 دقائق) لاعتبار ملف اللقطة `<CSA_HOME>/claude-usage.json` حديثاً قبل الرجوع إلى `claude_usage_command` أو وسم آخر قيمة `set_usage` بأنها قديمة (`stale`). |
| `claude_usage_command` | `null` | مصفوفة اختيارية `[executable, ...args]` (بدون نص shell، وبمهلة 5 ثوانٍ) تطبع كائن JSON `{five_hour_remaining_pct, weekly_remaining_pct, resets_at, note}` مع التحقق وحصر القيم بين `0` و`100`. |
| `quota_min_fraction` | `0.1` | النموذج الذي تكون حصته المتبقية أقل من هذه النسبة (10%) يُتجاوز. |
| `default_timeout_s` | `600` | الحد الزمني للمهمة بالثواني عندما لا يُحدد. |
| `max_timeout_s` | `3600` | أطول حد زمني بالثواني تستطيع المهمة طلبه. |
| `max_hops` | `3` | عدد مرات التنقل المسموح لسلسلة المهمة بين Claude وAntigravity. |
| `dashboard_auto_open` | `true` | يفتح لوحة المتابعة المباشرة تلقائياً عند أول تفويض عمل في المشروع. |
| `dashboard_port` | `4317` | منفذ localhost الذي يعمل عليه خادم لوحة المتابعة المباشرة. |
| `claude_models` | `review`: sonnet، `task`: sonnet | نموذج Claude المستخدم في مهام المراجعة والمهام من الاتجاه العكسي. |
| `claude_max_budget_usd` | `1.0` | أقصى تكلفة لـ Claude بالدولار لمهمة واحدة من الاتجاه العكسي. |
| `claude_max_parallel` | `2` | عدد مهام Claude من الاتجاه العكسي التي تعمل في وقت واحد. |
| `daily_max_claude_usd` | `10` | الحد اليومي لتكلفة Claude بالدولار لمهام الاتجاه العكسي. |
| `daily_max_jobs` | `200` | الحد اليومي لعدد المهام. |
| `swarm_max_parallel` | `4` | عدد أجزاء Swarm التي تعمل في وقت واحد. |
| `desktop_model_map` | fast: flash، balanced: flash، deep: pro | النموذج الذي يستخدمه تطبيق Antigravity لكل فئة في وضع Desktop. |
| `allowed_roots` | `[]` (فارغ) | المجلدات التي يُسمح بتشغيل المهام فيها. **موصى به:** ضع قيمة له، مثل `["D:\\Projects"]`. |
| `allow_desktop_auto_exec` | `false` | يبقى `false` في `config.default.json`. ضعه على `true` في ملف `config.json` الخاص بك فقط إذا قبلت أن مهام Desktop قد تنفذ أوامر دون أن تسألك (راجع الأمان). |
| `allow_desktop_edit` | `false` | يبقى `false` في `config.default.json`. ضعه على `true` في ملف `config.json` الخاص بك فقط للسماح بمهام Desktop التي تغيّر الملفات. |
| `approved_command_timeout_s` | `120` | الحد الزمني بالثواني لكل أمر توافق عليه عبر `agy_approve`. |

> **ملاحظة حول الإعدادات الافتراضية للأمان:** تظل قيمتا `allow_desktop_auto_exec` و`allow_desktop_edit` مضبوطتين على `false` في `config.default.json`، ولا تُفعَّلان إلا إذا ضبطتهما صراحةً في ملف `%LOCALAPPDATA%\claude-sync-antigravity\config.json` الخاص بك.

حافظ على صحة ملف JSON: علامات اقتباس مزدوجة، وبدون فاصلة زائدة بعد آخر عنصر، ومع شرطتين مائلتين للخلف في مسارات Windows.

## القيود

- تعتمد الأداة على تفاصيل داخلية غير موثقة في Antigravity. قد تتغير هذه التفاصيل في تحديث مستقبلي، فتتوقف الأداة حتى يتم تحديثها.
- قراءة ردود وضع Desktop تعتمد على ملف نتيجة يُطلب من الوكيل كتابته. إذا لم يكتبه الوكيل، لا يمكن قراءة الرد.
- معلومات الحصة تحتاج إلى أن يكون تطبيق Antigravity مفتوحاً. والنماذج التي لا توفر نسبة حصة (مثل `Gemini 4 Carbon`) تعرض `غير متاح`.
- لأن Claude Code CLI لا يوفر نقطة نهاية محلية غير مصادق عليها لقراءة الحصة، ولأن GCSA لا يقرأ أبداً ملفات الاعتماد أو رموز OAuth أو ملفات تعريف الارتباط، يتم تحديث حصة Claude Code في الشريط السفلي للوحة تلقائياً من `<CSA_HOME>/claude-usage.json` (المكتوب عبر `csa_board` `set_usage` أو `scripts/push-claude-usage.mjs`)، أو من `claude_usage_command` الاختياري، أو من آخر قيمة `set_usage` (موسومة كـ `stale`)؛ وإلا تعرض `غير متاح` مع السبب وتلميحة إعداد قصيرة (راجع [docs/CLAUDE-USAGE.md](docs/CLAUDE-USAGE.md)).
- الأداة تعمل على Windows فقط في هذا الإصدار.

## قواعد الأمان كاملة

راجع [docs/SECURITY.md](docs/SECURITY.md) لقائمة قواعد الأمان كاملة.

## الرخصة

رخصة PolyForm Noncommercial 1.0.0: الكود ظاهر للجميع ومجاني للاستخدام غير التجاري، والاستخدام التجاري يتطلب إذنًا كتابيًا من المؤلف. Copyright (c) 2026 Eslam Elgindy. راجع [LICENSE](LICENSE).

المؤلف: Eslam Elgindy
