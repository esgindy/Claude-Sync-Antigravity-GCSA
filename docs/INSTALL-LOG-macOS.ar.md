# سجل التسطيب الأول لـ GCSA V5 على macOS

- **التاريخ:** 2026-11-21
- **الجهاز:** MacBook (Intel x86_64)، macOS (Darwin 24.6)، و`zsh` هو الـ shell الافتراضي
- **النسخة:** GCSA 5.0.0

السجل ده بيوثّق اللي حصل فعلاً في أول تسطيب على ماك: المشاكل اللي ظهرت، والحلول، والتعديلات اللي دخلت البرنامج بسببها عشان التسطيب يبقى سهل على أي جهاز.

## حالة الجهاز قبل التسطيب

| العنصر | الحالة |
|---|---|
| Node.js | **غير موجود** (لا `node` ولا `npm`) |
| Homebrew | **غير موجود** |
| Antigravity | متسطّب في `/Applications/Antigravity.app` (فيه `Contents/Resources/bin/language_server`)، بس مكانش مفتوح |
| `agy` CLI | غير موجود |
| `claude` CLI | غير موجود في الـ PATH. Claude Desktop فيه نسخة داخلية من Claude Code، بس مسارها بيتغير مع كل تحديث فمينفعش نعتمد عليها |
| `~/.gemini/config/mcp_config.json` | موجود بس **فاضي** (0 bytes) |
| Claude Code وClaude Desktop | مفيش أي MCP servers متسجّلة |
| إعداد التنفيذ في Antigravity | `CASCADE_COMMANDS_AUTO_EXECUTION_AUTO` (تنفيذ تلقائي) |
| مكان المشروع | جوه OneDrive (`~/Library/CloudStorage/OneDrive-Personal/...`) |

## الخطوات اللي اتعملت

1. **تسطيب Node 22 من غير Homebrew ومن غير sudo**
   - اتنزّل `node-v22.23.5-darwin-x64.tar.gz` من `nodejs.org`، واتطابق الـ SHA-256 مع `SHASUMS256.txt` الرسمي.
   - اتفك في `~/.local/node`، مع روابط في `~/.local/bin` لـ `node` و`npm` و`npx`.
2. **نسخ البرنامج لمجلد محلي**
   - من OneDrive لـ `~/GCSA`، وبعدين `npm ci --omit=dev`.
   - **السبب:** OneDrive ممكن يقفل الملفات أو يشيلها من الجهاز (Files On-Demand) وخوادم MCP شغالة.
3. **تجربة الخادمين قبل التسجيل**
   - بالطريقة اللي بيكلّمهم بيها أي تطبيق: `initialize` وبعدين `tools/list` عن طريق stdio.
   - النتيجة: `csa-claude` فيه 15 أداة، و`csa-antigravity` فيه 4.
4. **التسجيل، مع نسخة احتياطية `.bak-gcsa-<timestamp>` قبل تعديل أي ملف**
   - Claude Code: مفتاح `mcpServers.csa` في `~/.claude.json`.
   - Claude Desktop: مفتاح `mcpServers.csa` في `~/Library/Application Support/Claude/claude_desktop_config.json`.
   - Antigravity: مفتاح `mcpServers.csa-antigravity` في `~/.gemini/config/mcp_config.json`.
   - كل الإعدادات بتشاور على **المسار الكامل** لـ Node (`~/.local/node/bin/node`)، فمش محتاجين نعدّل الـ PATH. Claude Desktop مش بيقرا الـ PATH بتاع الـ Terminal أصلاً.
5. **تشغيل لوحة المتابعة** من `~/GCSA` على `http://127.0.0.1:4317/`. اللوحة قرت أيقونة Antigravity من `app.asar` بتاع الماك.

## المشاكل والدروس

| المشكلة | الأثر | اللي اتعمل في البرنامج |
|---|---|---|
| مفيش Node، ومفيش Homebrew | التسطيب بيقف من أول خطوة | السكريبت بيتأكد إن Node 20+ موجود، ولو مش موجود بيوقف برسالة واضحة. وINSTALL.md بيشرح التسطيب من nodejs.org |
| Node شغال من مجلد مؤقت | الإعدادات هتشاور على ملف هيتمسح | السكريبت بيحذّر لو Node في `tmp` أو `temp` أو `scratchpad` |
| المشروع جوه OneDrive أو Dropbox أو iCloud | الملفات ممكن تتقفل أو تختفي أثناء التشغيل | السكريبت بيحذّر ويقترح `~/GCSA` |
| `mcp_config.json` فاضي | `JSON.parse` بيفشل | السكريبت بيعامل الملف الفاضي على إنه `{}` |
| ملف إعدادات JSON بايظ | الكتابة فوقه ممكن تمسح إعدادات المستخدم | السكريبت **مش بيكتب** ولا بيلمس الملف، وبيقول للمستخدم يصلّحه بإيده |
| التطبيق نفسه مش متسطّب | تسجيل في تطبيق مش موجود | السكريبت بيتخطّى التطبيق ده ويقول السبب |
| تشغيل التسطيب أكتر من مرة | تكرار وملفات احتياطية كتير | السكريبت بيقارن الإعداد الموجود، ولو متطابق مش بيعدّل ولا بيعمل نسخة احتياطية. لو المكان اتغير بيحدّث الإعداد بس |
| Antigravity مضبوط على التنفيذ التلقائي | GCSA بيرفض وضع Desktop عن قصد | السكريبت بيوضّح ده ويقول تغيّره لـ "Request review" |
| `claude` CLI مش متسطّب | الاتجاه العكسي (Antigravity يطلب من Claude) مش هيشتغل | السكريبت بيوضّح إنه اختياري ومطلوب للاتجاه العكسي بس |
| الجلسات المفتوحة مش بتشوف الخوادم الجديدة | المستخدم يفتكر التسطيب فشل | السكريبت بيقول في الآخر: أعد تشغيل التطبيقات وافتح جلسة Claude Code جديدة |

## التسطيب بعد كده على أي جهاز (Windows / macOS / Linux)

```bash
# 1) سطّب Node 20+ من nodejs.org (أو: brew install node)
# 2) انسخ المشروع لمجلد محلي، مش مجلد متزامن مع السحابة
cd ~/GCSA
node scripts/setup.mjs --dry-run   # اعرض اللي هيتعمل من غير ما يكتب حاجة
node scripts/setup.mjs             # سطّب الحزم + سجّل الخوادم + جرّبهم
# لإلغاء التسجيل:
node scripts/setup.mjs --uninstall
```

وعلى Windows نفس الأوامر في PowerShell، بمسار زي `C:\GCSA`.

## لسه متجربش

- تشغيل مهمة فعلية مع Antigravity وهو مفتوح. محتاج الأول نغيّر إعداد التنفيذ التلقائي لـ "Request review".
- الاتجاه العكسي (محتاج `claude` CLI).
- سكريبت التسطيب على Windows. الكود بيستخدم نفس طبقة `platform.mjs`، بس لسه ما اتشغّلش على جهاز Windows فعلي.
