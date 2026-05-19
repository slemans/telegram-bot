import "dotenv/config";
import express from "express";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;
const JOB_SECRET = process.env.JOB_SECRET;

if (!SUPABASE_URL || !SUPABASE_KEY || !BOT_TOKEN || !MOYK_API_KEY) {
  console.error(
    "Задайте в .env: SUPABASE_URL, SUPABASE_KEY, BOT_TOKEN, MOYK_API_KEY"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let isNotificationsJobRunning = false;
const sentNotificationKeys = new Set();

function dbLogError(tag, err) {
  if (!err) return;
  console.error(
    `[Supabase:${tag}]`,
    err.code ?? "",
    err.message ?? err,
    err.details ?? "",
    err.hint ?? ""
  );
}

/** PostgreSQL: unique_violation — дубль ключа (ожидаемо при гонке джобов). */
function isUniqueViolation(err) {
  return err && String(err.code) === "23505";
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.sendStatus(200);
});

// ================= TELEGRAM =================
async function send(chatId, text, extra = {}) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...extra
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("Telegram sendMessage:", r.status, data);
  }
}

async function answerCallbackQuery(q, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: q.id,
      ...(text ? { text } : {})
    })
  });
}

async function setBotCommands() {
  const commands = [
    { command: "start", description: "Запустить бота" },
    { command: "help", description: "Помощь и сообщение о проблеме" }
  ];
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("Telegram setMyCommands:", r.status, d);
  } else {
    console.log("Telegram commands updated");
  }
}

// ================= MOYK =================
async function getToken() {
  const r = await fetch("https://api.moyklass.com/v1/company/auth/getToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: MOYK_API_KEY })
  });

  const d = await r.json();
  return d.accessToken;
}

/** Варианты номера: Telegram даёт +7… / 8… / без кода — в МойКласс может быть иначе */
function phoneLookupVariants(digits) {
  const d = String(digits).replace(/\D/g, "");
  const out = [];
  const push = (x) => {
    if (x && !out.includes(x)) out.push(x);
  };
  push(d);
  if (d.length === 11 && d.startsWith("8")) push("7" + d.slice(1));
  if (d.length === 11 && d.startsWith("7")) push(d.slice(1));
  if (d.length === 10) {
    push("7" + d);
    push("8" + d);
  }
  // BY: 375XXXXXXXXX
  if (d.length === 12 && d.startsWith("375")) {
    push(d.slice(3));
    push("8" + d.slice(3));
  }
  if (d.length === 9) {
    push("375" + d);
  }
  return out;
}

async function findUser(phoneDigits) {
  const token = await getToken();

  for (const phone of phoneLookupVariants(phoneDigits)) {
    const r = await fetch(
      `https://api.moyklass.com/v1/company/users?phone=${encodeURIComponent(phone)}&limit=1`,
      { headers: { "x-access-token": token } }
    );
    const d = await r.json().catch(() => ({}));
    const u = d.users?.[0];
    if (u) return u;
  }
  return null;
}

async function getSubs(userId) {
  const token = await getToken();

  const r = await fetch(
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}&statusId=2`,
    { headers: { "x-access-token": token } }
  );

  const d = await r.json().catch(() => ({}));
  return d.subscriptions || [];
}

/** Полная карточка абонемента (список часто без остатка и названия группы) */
async function fetchUserSubscriptionDetail(token, subscriptionId) {
  const url = `https://api.moyklass.com/v1/company/userSubscriptions/${subscriptionId}`;
  const r = await fetch(url, { headers: { "x-access-token": token } });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  if (!d || typeof d !== "object") return null;
  return d.userSubscription || d.subscription || d.data || d;
}

function stripRichText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickTextField(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return stripRichText(v);
  }
  return null;
}

function parseClassObject(d) {
  if (d == null) return null;
  if (Array.isArray(d)) return d[0] ?? null;
  if (Array.isArray(d.classes)) return d.classes[0] ?? null;
  if (d.class && typeof d.class === "object") return d.class;
  if (d.data && typeof d.data === "object") return parseClassObject(d.data);
  if (d.id != null || d.name != null) return d;
  return null;
}

/** Группа: GET /v1/company/classes/{id}?includeDescription=true */
async function fetchClassById(token, classId, cache) {
  if (classId == null || classId === "") return null;
  const n = Number(classId);
  if (Number.isFinite(n) && n <= 0) return null;

  const cacheKey = `classObj:${classId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const headers = { "x-access-token": token };
  const descQs = "includeDescription=true";

  const byPath = `https://api.moyklass.com/v1/company/classes/${encodeURIComponent(classId)}?${descQs}`;
  let r = await fetch(byPath, { headers });
  let cls = null;
  if (r.ok) cls = parseClassObject(await r.json().catch(() => null));

  if (!cls) {
    const byQuery = `https://api.moyklass.com/v1/company/classes?classId=${encodeURIComponent(classId)}&${descQs}`;
    r = await fetch(byQuery, { headers });
    if (r.ok) cls = parseClassObject(await r.json().catch(() => null));
  }

  cache.set(cacheKey, cls ?? null);
  return cls;
}

async function fetchClassNameById(token, classId, cache) {
  const cls = await fetchClassById(token, classId, cache);
  const name = cls?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Ведущий группы: managerIds → GET /v1/company/managers/{id} */
async function fetchManagerNameById(token, managerId, cache) {
  if (managerId == null || managerId === "") return null;
  const cacheKey = `mgr:${managerId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const url = `https://api.moyklass.com/v1/company/managers/${encodeURIComponent(managerId)}`;
  const r = await fetch(url, { headers: { "x-access-token": token } });
  if (!r.ok) {
    cache.set(cacheKey, null);
    return null;
  }
  const d = await r.json().catch(() => null);
  const name =
    d?.name ??
    d?.manager?.name ??
    (typeof d === "object" && d?.data?.name ? d.data.name : null);
  const out = typeof name === "string" && name.trim() ? name.trim() : null;
  cache.set(cacheKey, out);
  return out;
}

async function resolveClassTeacherNames(token, classObj, cache) {
  if (!classObj) return null;

  const embedded =
    classObj.manager?.name ??
    classObj.teacher?.name ??
    (Array.isArray(classObj.managers)
      ? classObj.managers.map((m) => m?.name).filter(Boolean).join(", ")
      : null);
  if (embedded) return embedded;

  let ids = classObj.managerIds;
  if (!Array.isArray(ids) || !ids.length) {
    const single = classObj.managerId ?? classObj.teacherId;
    ids = single != null ? [single] : [];
  }

  const names = [];
  for (const id of ids) {
    const n = await fetchManagerNameById(token, id, cache);
    if (n) names.push(n);
  }
  return names.length ? names.join(", ") : null;
}

/** Программа: GET /v1/company/courses?courseId= — описание, если у группы пусто */
async function fetchCourseById(token, courseId, cache) {
  if (courseId == null || courseId === "") return null;
  const cacheKey = `course:${courseId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const url = `https://api.moyklass.com/v1/company/courses?courseId=${encodeURIComponent(courseId)}`;
  const r = await fetch(url, { headers: { "x-access-token": token } });
  if (!r.ok) {
    cache.set(cacheKey, null);
    return null;
  }
  const d = await r.json().catch(() => null);
  let course = null;
  if (Array.isArray(d)) course = d[0];
  else if (Array.isArray(d?.courses)) course = d.courses[0];
  else course = d?.course ?? d?.data ?? d;

  cache.set(cacheKey, course ?? null);
  return course;
}

/** Подробное описание группы → иначе описание программы (как в админке МойКласс) */
function resolveLessonDaysText(classObj, courseObj) {
  const fromClass = pickTextField(classObj, [
    "description",
    "fullDescription",
    "detailDescription"
  ]);
  if (fromClass) return fromClass;

  const fromCourse = pickTextField(courseObj, ["description", "shortDescription"]);
  if (fromCourse) return fromCourse;

  return pickTextField(classObj, ["comment"]);
}

function parseSubscriptionCatalogPayload(d) {
  if (d == null) return null;
  const sub = d.subscription ?? d.data ?? d;
  const name = sub?.name ?? sub?.title;
  if (typeof name === "string" && name.trim()) return name.trim();
  if (Array.isArray(sub) && sub[0]?.name) {
    const n = sub[0].name;
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  return null;
}

/** Вид абонемента (каталог): GET /v1/company/subscriptions/{id} — если группа не пришла */
async function fetchSubscriptionCatalogName(token, subscriptionId, cache) {
  if (subscriptionId == null || subscriptionId === "") return null;
  const n = Number(subscriptionId);
  if (Number.isFinite(n) && n <= 0) return null;

  const key = `sub:${subscriptionId}`;
  if (cache.has(key)) return cache.get(key);

  const url = `https://api.moyklass.com/v1/company/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const r = await fetch(url, { headers: { "x-access-token": token } });
  if (!r.ok) {
    cache.set(key, null);
    return null;
  }
  const name = parseSubscriptionCatalogPayload(await r.json().catch(() => null));
  if (name) {
    cache.set(key, name);
    return name;
  }
  cache.set(key, null);
  return null;
}

/** Порядок: основная группа, затем все classIds из абонемента */
function collectClassIds(merged) {
  const out = [];
  const seen = new Set();
  const add = (id) => {
    if (id == null || id === "") return;
    const num = Number(id);
    if (Number.isFinite(num) && num <= 0) return;
    const k = String(id);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(id);
  };
  add(merged.mainClassId ?? merged.main_class_id);
  if (Array.isArray(merged.classIds)) {
    for (const cid of merged.classIds) add(cid);
  }
  return out;
}

function subscriptionEndDate(s) {
  return s.endDate ?? s.end_date ?? s.dateEnd;
}

/** Склонение числительных: 1 занятие, 2 занятия, 5 занятий */
function pluralRu(n, forms) {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

/** «3 дня», «1 день» для текста напоминаний */
function pluralRuDays(n) {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  let w;
  if (abs > 10 && abs < 20) w = "дней";
  else if (n1 === 1) w = "день";
  else if (n1 > 1 && n1 < 5) w = "дня";
  else w = "дней";
  return `${n} ${w}`;
}

/** Час и минута по Europe/Minsk (иначе на VPS в UTC minute и hour расходятся) */
function getMinskClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Minsk",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  }).formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { hour, minute };
}

/** Сегодня YYYY-MM-DD по календарю Минска */
function todayDateMinsk(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Minsk"
  }).format(now);
}

function utcMidnightParts(yyyyMmDd) {
  const [y, m, d] = String(yyyyMmDd)
    .slice(0, 10)
    .split("-")
    .map((x) => parseInt(x, 10));
  return Date.UTC(y, m - 1, d);
}

/** Сколько полных календарных дней от «сегодня» (Минск) до end_date (UTC-сутки по строке даты) */
function daysUntilEndDateMinsk(endDateStr, now = new Date()) {
  const end = String(endDateStr).slice(0, 10);
  const todayStr = todayDateMinsk(now);
  return Math.round(
    (utcMidnightParts(end) - utcMidnightParts(todayStr)) / 86400000
  );
}

function isJobsRequestAuthorized(req) {
  if (!JOB_SECRET) return false;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  const byHeader = req.headers["x-job-secret"];
  return bearer === JOB_SECRET || byHeader === JOB_SECRET;
}

function pickRemainingVisits(s) {
  if (!s || typeof s !== "object") return null;
  const keys = [
    "remaining",
    "remain",
    "rest",
    "visitsLeft",
    "visitsRemaining",
    "lessonsLeft",
    "lessonLeft",
    "remainingLessons",
    "remainingVisits",
    "visitCount",
    "lessonsCount",
    "lessonCount",
    "count",
    "balance",
    "numberOfClasses",
    "classesLeft",
    "paidVisitsLeft",
    "classesRemains",
    "left"
  ];
  for (const k of keys) {
    const v = s[k];
    if (v != null && v !== "" && !Number.isNaN(Number(v))) {
      return Math.max(0, Math.floor(Number(v)));
    }
  }
  for (const k of Object.keys(s)) {
    if (!/remain|left|visit|lesson|balance|class/i.test(k)) continue;
    if (/end|date|price|time|created|updated|id$/i.test(k)) continue;
    const v = s[k];
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
    if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) {
      return Math.max(0, Math.floor(Number(v)));
    }
  }
  return null;
}

/** Официальная схема МойКласс: visitCount − списанные занятия (visitedCount / stats) */
function computeRemainingLessons(s) {
  if (!s || typeof s !== "object") return null;
  const vc = s.visitCount;
  if (vc == null || vc === "" || Number.isNaN(Number(vc))) {
    return pickRemainingVisits(s);
  }
  const visitedRaw =
    s.visitedCount ?? s.stats?.totalVisited ?? s.statTotalVisits;
  if (visitedRaw == null || visitedRaw === "" || Number.isNaN(Number(visitedRaw))) {
    return pickRemainingVisits(s);
  }
  return Math.max(
    0,
    Math.floor(Number(vc)) - Math.floor(Number(visitedRaw))
  );
}

function formatRemainingLessons(remaining) {
  if (remaining == null || Number.isNaN(Number(remaining))) {
    return "У вас осталось занятий в этом абонементе: —";
  }
  const n = Math.max(0, Math.floor(Number(remaining)));
  const w = pluralRu(n, ["занятие", "занятия", "занятий"]);
  return `У вас осталось в этом абонементе: ${n} ${w}`;
}

function pickGroupTitle(s) {
  const candidates = [
    s.lessonClass?.name,
    s.lessonClass?.title,
    s.subscriptionType?.name,
    s.subscription?.name,
    s.tariff?.name,
    s.product?.name,
    s.group?.name,
    s.class?.name,
    s.lessonClassName,
    s.className,
    s.groupName,
    s.name,
    s.title,
    s.label
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function resolveSubscriptionForDisplay(token, s, cache) {
  let merged = { ...s };
  const detail = await fetchUserSubscriptionDetail(token, s.id);
  if (detail && typeof detail === "object") {
    merged = { ...s, ...detail };
  }

  const remaining = computeRemainingLessons(merged);
  let groupTitle = pickGroupTitle(merged);
  let classObj = null;

  for (const cid of collectClassIds(merged)) {
    classObj = await fetchClassById(token, cid, cache);
    if (classObj) {
      if (!groupTitle && classObj.name) groupTitle = String(classObj.name).trim();
      break;
    }
  }

  if (!groupTitle) {
    for (const cid of collectClassIds(merged)) {
      groupTitle = await fetchClassNameById(token, cid, cache);
      if (groupTitle) break;
    }
  }
  if (!groupTitle) {
    groupTitle = await fetchSubscriptionCatalogName(
      token,
      merged.subscriptionId,
      cache
    );
  }

  let teacher = null;
  let lessonDays = null;
  if (classObj) {
    teacher = await resolveClassTeacherNames(token, classObj, cache);
    const courseId =
      classObj.courseId ?? merged.courseId ?? merged.mainCourseId;
    const courseObj = courseId
      ? await fetchCourseById(token, courseId, cache)
      : null;
    lessonDays = resolveLessonDaysText(classObj, courseObj);
  }

  return {
    merged,
    remaining,
    groupTitle: groupTitle || "—",
    teacher: teacher || "—",
    lessonDays: lessonDays || "—"
  };
}

const SUBSCRIPTIONS_MENU_TEXT = "🎫 Абонименты";
const HELP_MENU_TEXT = "🆘 Помощь";
const RULE_STUDIO_MENU_TEXT = "Правила посещения студии";
const RULE_VISITS_MENU_TEXT =
  "Правила пользования абонементом и отработки";
const LEGACY_HELP_MENU_TEXT = "/help помощь";
const CONTACT_SHARE_LABEL = "📞 Поделится моим номером телефона";

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: SUBSCRIPTIONS_MENU_TEXT }],
      [{ text: RULE_STUDIO_MENU_TEXT }],
      [{ text: RULE_VISITS_MENU_TEXT }],
      [{ text: HELP_MENU_TEXT }]
    ],
    resize_keyboard: true
  };
}

function sharePhoneInlineReplyMarkup() {
  return {
    inline_keyboard: [
      [{ text: CONTACT_SHARE_LABEL, callback_data: "req_phone" }]
    ]
  };
}

/** Нижнее меню + inline-кнопка контакта (как у напоминаний). */
async function promptPhoneCollection(chatId, bodyText) {
  await send(chatId, bodyText, { reply_markup: mainMenuKeyboard() });
  await send(chatId, "📞 Нажмите кнопку ниже:", {
    reply_markup: sharePhoneInlineReplyMarkup()
  });
}

/** Восстановить нижнее меню после одноразовой клавиатуры контакта или inline-only. */
async function ensureMainMenu(chatId) {
  await send(chatId, "\u2060", { reply_markup: mainMenuKeyboard() });
}

function isPhoneLikeText(value) {
  if (typeof value !== "string") return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 15;
}

function isTelegramCommand(text, cmd) {
  if (typeof text !== "string") return false;
  const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^/${escaped}(?:@\\w+)?(?:\\s|$)`, "i");
  return re.test(text.trim());
}

/** callback_data: t_{subscriptionId}_{hour} — id может содержать «_» */
function parseNotifyTimeCallback(data) {
  const m = String(data).match(/^t_(.+)_(\d{1,2})$/);
  if (!m) return null;
  const hour = parseInt(m[2], 10);
  if (Number.isNaN(hour) || hour < 0 || hour > 23) return null;
  return { subId: m[1], hour };
}

function parseNotifyOffCallback(data) {
  const m = String(data).match(/^n_(.+)_off$/);
  return m ? { subId: m[1] } : null;
}

/** Сохранить/обновить абонемент в Supabase (нужно для кнопок напоминаний). */
async function upsertSubscriptionRow(chatId, sourceSub, cache) {
  const subIdStr = String(sourceSub.id);
  const token = await getToken();
  const { merged, remaining, groupTitle } = await resolveSubscriptionForDisplay(
    token,
    sourceSub,
    cache
  );
  const endRaw = subscriptionEndDate(merged);
  if (!endRaw) {
    console.error("SUBSCRIPTIONS UPSERT: нет end_date", subIdStr);
    return false;
  }

  const { data: prevRows, error: prevSelErr } = await supabase
    .from("subscriptions")
    .select("notify_enabled, notify_time")
    .eq("external_id", subIdStr)
    .limit(1);
  if (prevSelErr) dbLogError("subscriptions pre-select", prevSelErr);
  const prev = Array.isArray(prevRows) ? prevRows[0] : null;

  const nameForDb = groupTitle !== "—" ? groupTitle : merged.name ?? null;
  const upsertRow = {
    external_id: subIdStr,
    chat_id: chatId,
    name: nameForDb,
    end_date: endRaw,
    remaining: remaining ?? pickRemainingVisits(merged),
    active: true
  };
  if (prev) {
    if (prev.notify_enabled != null) {
      upsertRow.notify_enabled = prev.notify_enabled;
    }
    if (prev.notify_time != null && prev.notify_time !== "") {
      upsertRow.notify_time = prev.notify_time;
    }
  }

  const { error } = await supabase
    .from("subscriptions")
    .upsert(upsertRow, { onConflict: "external_id" });
  if (error) {
    dbLogError("subscriptions upsert", error);
    return false;
  }
  return true;
}

async function ensureSubscriptionInDb(chatId, subId, cache = new Map()) {
  const subIdStr = String(subId);
  const { data: existing, error: selErr } = await supabase
    .from("subscriptions")
    .select("external_id")
    .eq("external_id", subIdStr)
    .maybeSingle();
  if (selErr) dbLogError("subscriptions ensure select", selErr);
  if (existing?.external_id) return true;

  const token = await getToken();
  const detail = await fetchUserSubscriptionDetail(token, subIdStr);
  if (!detail) return false;
  return upsertSubscriptionRow(chatId, { id: subIdStr, ...detail }, cache);
}

async function upsertUserByChatId(chatId, phone, name) {
  const phoneNorm = String(phone).replace(/\D/g, "");
  const { error } = await supabase.from("users").upsert(
    {
      chat_id: chatId,
      phone: phoneNorm,
      name: name ?? null
    },
    { onConflict: "chat_id" }
  );
  if (error) {
    dbLogError("users upsert", error);
    return false;
  }
  return true;
}

async function getStoredPhoneForChat(chatId) {
  const { data, error } = await supabase
    .from("users")
    .select("phone")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) dbLogError("users select phone", error);
  return data?.phone ? String(data.phone) : null;
}

async function setSubscriptionNotify(chatId, subId, { enabled, hour }) {
  const cache = new Map();
  const ensured = await ensureSubscriptionInDb(chatId, subId, cache);
  if (!ensured) return { ok: false, reason: "ensure" };

  const patch = { notify_enabled: enabled };
  if (hour != null) patch.notify_time = hour;

  const { error } = await supabase
    .from("subscriptions")
    .update(patch)
    .eq("external_id", String(subId));

  if (error) {
    dbLogError("subscriptions notify update", error);
    return { ok: false, reason: "update" };
  }
  return { ok: true };
}

function appendSubscriptionBlock(text, { teacher, lessonDays, remaining, until }) {
  let out = text;
  out += `📌 Абонемент\n`;
  out += `Преподаватель: ${teacher}\n`;
  out += `Дни занятий группы: ${lessonDays}\n`;
  out += `${formatRemainingLessons(remaining)}\n`;
  out += `Абонемент действует до: ${until}\n\n`;
  out += `⏰ Если вам нужно напоминание об окончании Абонемента, выберите удобное время ниже что бы мы могли вам прислать уведомление\n`;
  return out;
}

function notifyTimeButtons(subIdStr) {
  return [
    { text: "🕙 10:00", callback_data: `t_${subIdStr}_10` },
    { text: "🕑 14:00", callback_data: `t_${subIdStr}_14` },
    { text: "🌙 20:00", callback_data: `t_${subIdStr}_20` },
    { text: "🔕 Выкл", callback_data: `n_${subIdStr}_off` }
  ];
}

/** Показать абонементы по id из Supabase (если users не сохранился, но subscriptions есть). */
async function sendSubscriptionsFromStoredIds(chatId, externalIds) {
  const token = await getToken();
  const nameCache = new Map();
  const buttons = [];
  let text = `🎫 Активные абонементы:\n\n`;
  let clientName = null;

  for (const extId of externalIds) {
    const subIdStr = String(extId);
    const detail = await fetchUserSubscriptionDetail(token, subIdStr);
    if (!detail) continue;

    const source = { id: subIdStr, ...detail };
    const { merged, remaining, teacher, lessonDays } =
      await resolveSubscriptionForDisplay(token, source, nameCache);
    const endRaw = subscriptionEndDate(merged);
    if (!endRaw) continue;

    if (!clientName) {
      clientName =
        detail.userName ??
        detail.user?.name ??
        merged.userName ??
        null;
    }

    const until = new Date(endRaw).toLocaleDateString("ru-RU");
    text = appendSubscriptionBlock(text, {
      teacher,
      lessonDays,
      remaining,
      until
    });
    buttons.push(notifyTimeButtons(subIdStr));
    await upsertSubscriptionRow(chatId, source, nameCache);
  }

  if (!buttons.length) return false;

  const header = clientName
    ? `✅ Клиент найден: ${clientName}\n\n`
    : "";
  await send(chatId, header + text, {
    reply_markup: { inline_keyboard: buttons }
  });
  return true;
}

async function sendSubscriptionsByPhone(chatId, phoneDigits, opts = {}) {
  const phone = String(phoneDigits).replace(/\D/g, "");
  const user = await findUser(phone);

  if (!user) {
    await send(chatId, "❌ Пользователь не найден", {
      reply_markup: mainMenuKeyboard()
    });
    return;
  }

  await upsertUserByChatId(chatId, phone, user.name);

  const subs = await getSubs(user.id);
  if (!subs.length) {
    await send(chatId, "❌ Нет активных абонементов", {
      reply_markup: mainMenuKeyboard()
    });
    return;
  }

  const token = await getToken();
  const nameCache = new Map();

  let text = `✅ Клиент найден: ${user.name}\n\n🎫 Активные абонементы:\n\n`;
  const buttons = [];

  for (const s of subs) {
    const { merged, remaining, teacher, lessonDays } =
      await resolveSubscriptionForDisplay(token, s, nameCache);

    const endRaw = subscriptionEndDate(merged);
    const until = new Date(endRaw).toLocaleDateString("ru-RU");

    text = appendSubscriptionBlock(text, {
      teacher,
      lessonDays,
      remaining,
      until
    });

    const subIdStr = String(s.id);
    buttons.push(notifyTimeButtons(subIdStr));
    await upsertSubscriptionRow(chatId, { ...s, id: subIdStr }, nameCache);
  }

  await send(chatId, text, {
    reply_markup: { inline_keyboard: buttons }
  });
  if (opts.restoreMainMenu) {
    await ensureMainMenu(chatId);
  }
}

/** «Абонименты»: телефон из users или уже сохранённые subscriptions. */
async function sendSubscriptionsForChat(chatId) {
  const phone = await getStoredPhoneForChat(chatId);
  if (phone) {
    await sendSubscriptionsByPhone(chatId, phone);
    return;
  }

  const { data: subsRows, error: subsErr } = await supabase
    .from("subscriptions")
    .select("external_id")
    .eq("chat_id", chatId)
    .eq("active", true);
  dbLogError("subscriptions select by chat_id", subsErr);

  const ids = [
    ...new Set(
      (subsRows ?? [])
        .map((r) => r.external_id)
        .filter((id) => id != null && id !== "")
    )
  ];

  if (ids.length) {
    const ok = await sendSubscriptionsFromStoredIds(chatId, ids);
    if (ok) return;
  }

  await promptPhoneCollection(
    chatId,
    "📲 Сначала отправьте номер телефона, чтобы мы смогли найти ваши абонементы"
  );
}

// ================= RULES (SUPABASE) =================
async function fetchRulesConfig() {
  const { data, error } = await supabase
    .from("ruleStudio")
    .select("ruleStudio, ruleVisits")
    .eq("id", 1)
    .maybeSingle();

  if (error) dbLogError("ruleStudio select", error);
  return data;
}

async function sendRuleMessage(chatId, field) {
  const row = await fetchRulesConfig();
  const text =
    field === "studio"
      ? row?.ruleStudio?.trim()
      : row?.ruleVisits?.trim();

  if (!text) {
    await send(
      chatId,
      "⚠️ Текст правил пока не добавлен в базу. Обратитесь к администратору.",
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  await send(chatId, text, { reply_markup: mainMenuKeyboard() });
}

// ================= HELP (SUPABASE) =================
async function createHelpRequest(chatId) {
  const { data, error } = await supabase
    .from("help_requests")
    .insert({ chat_id: chatId })
    .select("id")
    .maybeSingle();

  if (error) {
    dbLogError("help_requests insert", error);
    return null;
  }
  return data?.id ?? null;
}

async function findOpenHelpRequest(chatId) {
  const { data, error } = await supabase
    .from("help_requests")
    .select("id, chat_id, created_at, problem_text")
    .eq("chat_id", chatId)
    .is("problem_text", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    dbLogError("help_requests select open", error);
    return null;
  }
  return Array.isArray(data) ? data[0] ?? null : null;
}

async function closeHelpRequest(id, problemText) {
  const { error } = await supabase
    .from("help_requests")
    .update({ problem_text: problemText })
    .eq("id", id);
  if (error) dbLogError("help_requests update problem_text", error);
  return !error;
}

// ================= WEBHOOK (ВСЁ СЮДА) =================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
  const update = req.body;

  // ================= CALLBACK =================
  if (update.callback_query) {
    const q = update.callback_query;
    const data = q.data || "";
    const callbackChatId = q.message?.chat?.id;

    // Сразу снимаем «часики» на кнопке. Telegram ждёт answerCallbackQuery ~до 30 с;
    // если сначала ходить в Supabase (особенно после простоя), пользователь видит
    // минуту «зависания», хотя webhook уже ответил 200.
    await answerCallbackQuery(q);

    if (data === "req_phone") {
      if (callbackChatId != null) {
        await send(
          callbackChatId,
          "Нажмите кнопку внизу экрана, чтобы отправить контакт:",
          {
            reply_markup: {
              keyboard: [[{ text: CONTACT_SHARE_LABEL, request_contact: true }]],
              resize_keyboard: true,
              one_time_keyboard: true
            }
          }
        );
      }
      return;
    }

    const offParsed = parseNotifyOffCallback(data);
    if (offParsed) {
      const subId = String(offParsed.subId);
      if (callbackChatId == null) return;

      const result = await setSubscriptionNotify(callbackChatId, subId, {
        enabled: false
      });
      if (!result.ok) {
        await send(
          callbackChatId,
          "⚠️ Не удалось отключить напоминание. Откройте «🎫 Абонименты» и попробуйте снова."
        );
        return;
      }
      await send(
        callbackChatId,
        "🔕 Напоминания по этому абонементу отключены."
      );
      return;
    }

    const timeParsed = parseNotifyTimeCallback(data);
    if (timeParsed) {
      const subId = String(timeParsed.subId);
      const selectedTime = timeParsed.hour;
      if (callbackChatId == null) return;

      const { data: current, error: currentErr } = await supabase
        .from("subscriptions")
        .select("notify_enabled, notify_time")
        .eq("external_id", subId)
        .maybeSingle();

      if (currentErr) {
        dbLogError("CALLBACK SELECT", currentErr);
        await send(
          callbackChatId,
          "⚠️ Ошибка при чтении настроек. Попробуйте через минуту или откройте «🎫 Абонименты» снова."
        );
        return;
      }

      if (current?.notify_enabled && Number(current.notify_time) === selectedTime) {
        await send(
          callbackChatId,
          `ℹ️ Уведомление уже включено на ${selectedTime}:00.`
        );
        return;
      }

      const result = await setSubscriptionNotify(callbackChatId, subId, {
        enabled: true,
        hour: selectedTime
      });

      if (!result.ok) {
        console.error("CALLBACK NOTIFY:", result.reason, subId);
        await send(
          callbackChatId,
          "⚠️ Не удалось сохранить время напоминания. Откройте «🎫 Абонименты» ещё раз. Если не помогает — проверьте доступ к таблице subscriptions в Supabase (RLS)."
        );
        return;
      }

      if (current?.notify_enabled && Number.isFinite(Number(current.notify_time))) {
        const prevTime = Number(current.notify_time);
        await send(
          callbackChatId,
          `🔁 Время уведомления изменено: ${prevTime}:00 → ${selectedTime}:00`
        );
      } else {
        await send(
          callbackChatId,
          `🔔 Уведомления об окончании абонемента включены, отправка за 3 дня до окончания в: ${selectedTime}:00`
        );
      }
    }

    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  // ================= START =================
  if (isTelegramCommand(msg.text, "start")) {
    await promptPhoneCollection(
      chatId,
      "📲 Отправьте ваш номер телефона, что бы мы смогли вас найти"
    );
    return;
  }

  // ================= HELP =================
  if (
    msg.text === HELP_MENU_TEXT ||
    msg.text === LEGACY_HELP_MENU_TEXT ||
    isTelegramCommand(msg.text, "help")
  ) {
    const helpRowId = await createHelpRequest(chatId);
    if (helpRowId == null) {
      await send(
        chatId,
        "⚠️ Не удалось создать обращение в базе (проверьте таблицу help_requests и политики RLS в Supabase). Напишите администратору или попробуйте позже.",
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }
    await send(
      chatId,
      "Если у вас возникли проблемы — напишите, что случилось, и мы вам поможем.",
      {
        reply_markup: mainMenuKeyboard()
      }
    );
    return;
  }

  if (msg.text === SUBSCRIPTIONS_MENU_TEXT) {
    await sendSubscriptionsForChat(chatId);
    return;
  }

  if (msg.text === RULE_STUDIO_MENU_TEXT) {
    await sendRuleMessage(chatId, "studio");
    return;
  }

  if (msg.text === RULE_VISITS_MENU_TEXT) {
    await sendRuleMessage(chatId, "visits");
    return;
  }

  // Если пользователь открыл /help — следующее текстовое сообщение считаем описанием проблемы
  if (typeof msg.text === "string" && msg.text.trim()) {
    const openReq = await findOpenHelpRequest(chatId);
    if (openReq?.id) {
      const saved = await closeHelpRequest(openReq.id, msg.text.trim());
      if (saved) {
        await send(
          chatId,
          "✅ Спасибо! Сообщение принято. Мы свяжемся с вами в ближайшее время.",
          {
            reply_markup: mainMenuKeyboard()
          }
        );
      } else {
        await send(
          chatId,
          "⚠️ Не удалось сохранить обращение. Попробуйте ещё раз или напишите администратору.",
          {
            reply_markup: mainMenuKeyboard()
          }
        );
      }
      return;
    }
  }

  let phoneInput = null;
  if (msg.contact?.phone_number) {
    phoneInput = msg.contact.phone_number;
  } else if (isPhoneLikeText(msg.text)) {
    phoneInput = msg.text;
  }

  if (!phoneInput) {
    return;
  }

  await sendSubscriptionsByPhone(chatId, phoneInput, {
    restoreMainMenu: Boolean(msg.contact?.phone_number)
  });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    const chatIdTry =
      req.body?.message?.chat?.id ??
      req.body?.callback_query?.message?.chat?.id;
    if (chatIdTry) {
      await send(
        chatIdTry,
        "⚠️ Не удалось обработать запрос. Попробуйте ещё раз или напишите администратору."
      );
    }
  }
});

// ================= SCHEDULED JOB =================
async function runNotificationsJob() {
  if (isNotificationsJobRunning) {
    return {
      checked_active: 0,
      expired_disabled: 0,
      checked_candidates: 0,
      sent: 0,
      skipped_already_sent: 0,
      skipped_outside_window: 0,
      skipped_parallel_run: 1
    };
  }
  isNotificationsJobRunning = true;

  const now = new Date();
  const { hour, minute } = getMinskClock(now);
  const today = todayDateMinsk(now);

  const stats = {
    checked_active: 0,
    expired_disabled: 0,
    checked_candidates: 0,
    sent: 0,
    skipped_already_sent: 0,
    skipped_outside_window: 0,
    skipped_parallel_run: 0
  };

  try {
    console.log("JOB Minsk:", hour, minute, "date", today);

    // Авто-отключение завершённых абонементов выполняем каждую минуту:
    // это не зависит от времени напоминания.
    const { data: activeSubs, error: activeSelErr } = await supabase
      .from("subscriptions")
      .select("external_id, end_date")
      .eq("active", true);

    if (activeSelErr) {
      dbLogError("subscriptions select active for expire check", activeSelErr);
    } else if (activeSubs?.length) {
      stats.checked_active = activeSubs.length;
      for (const s of activeSubs) {
        const diffDays = daysUntilEndDateMinsk(s.end_date, now);
        if (diffDays <= 0) {
          const { error: expErr } = await supabase
            .from("subscriptions")
            .update({ notify_enabled: false, active: false })
            .eq("external_id", s.external_id);
          dbLogError(`subscriptions expire ${s.external_id}`, expErr);
          if (!expErr) {
            stats.expired_disabled += 1;
            console.log("ИСТЁК (авто off):", s.external_id);
          }
        }
      }
    }

    // Отправляем только в точное начало часа, чтобы не было повторов
    // при частом запуске scheduler (раз в минуту/несколько раз в минуту).
    if (minute !== 0) return stats;

    const { data: subs, error: selErr } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("active", true)
      .eq("notify_enabled", true)
      .eq("notify_time", hour);

    if (selErr) {
      console.error("CRON select subscriptions:", selErr);
      return stats;
    }

    if (!subs || subs.length === 0) {
      console.log(
        "JOB: нет абонементов с notify_enabled и notify_time=",
        hour
      );
      return stats;
    }

    // Дополнительная защита: если в таблице есть дубли строк по external_id,
    // отправляем только одно уведомление на абонемент.
    const uniqueByExternalId = new Map();
    for (const s of subs) {
      const k = String(s.external_id);
      if (!uniqueByExternalId.has(k)) uniqueByExternalId.set(k, s);
    }
    const uniqueSubs = [...uniqueByExternalId.values()];

    /** По chat_id: в МойКласс у одного клиента может быть несколько активных абонементов —
     * все с одним notify_time дали бы N отдельных сообщений. Шлём одно сообщение на чат в день. */
    const byChat = new Map();
    for (const s of uniqueSubs) {
      const extId = String(s.external_id);
      const diffDays = daysUntilEndDateMinsk(s.end_date, now);

      if (diffDays <= 0) continue;

      if (diffDays < 1 || diffDays > 3) {
        stats.skipped_outside_window += 1;
        console.log("SKIP (вне окна 1–3 дня):", extId, diffDays);
        continue;
      }

      const chKey = String(s.chat_id);
      if (!byChat.has(chKey)) byChat.set(chKey, []);
      byChat.get(chKey).push({ s, extId, diffDays });
    }

    let subsInWindow = 0;
    for (const arr of byChat.values()) subsInWindow += arr.length;
    stats.checked_candidates = subsInWindow;
    console.log(
      "JOB: чатов в окне",
      byChat.size,
      "абонементов:",
      subsInWindow,
      "(строк в выборке:",
      subs.length,
      ") notify_time=",
      hour
    );
    if (subsInWindow === 0) {
      console.log(
        "JOB: напоминания не отправлены — ни один абонемент не попадает в окно 1–3 дня до окончания (см. SKIP вне окна выше)"
      );
    }

    for (const [chKey, items] of byChat) {
      const chatId = items[0].s.chat_id;
      const dailyKey = `${today}:chat:${chKey}`;
      if (sentNotificationKeys.has(dailyKey)) {
        stats.skipped_already_sent += 1;
        continue;
      }

      const { data: log, error: logErr } = await supabase
        .from("notifications_log")
        .select("id")
        .eq("chat_id", chatId)
        .eq("sent_date", today)
        .limit(1);

      if (logErr) {
        console.error("notifications_log select by chat:", logErr);
        continue;
      }

      if (Array.isArray(log) && log.length > 0) {
        stats.skipped_already_sent += 1;
        sentNotificationKeys.add(dailyKey);
        console.log("SKIP (уже отправляли чату):", chKey);
        continue;
      }

      const primaryExtId = items[0].extId;
      const logPayload = {
        chat_id: chatId,
        subscription_id: primaryExtId,
        sent_date: today,
        notify_time: hour
      };
      const { data: reserveRow, error: reserveErr } = await supabase
        .from("notifications_log")
        .insert(logPayload)
        .select("id")
        .maybeSingle();

      if (reserveErr) {
        if (isUniqueViolation(reserveErr)) {
          stats.skipped_already_sent += 1;
          sentNotificationKeys.add(dailyKey);
          console.log("SKIP (уникальный индекс / гонка по чату):", chKey);
          continue;
        }
        dbLogError(`notifications_log reserve chat ${chKey}`, reserveErr);
        console.error(
          "JOB: Telegram не отправлен — выполните scripts/notifications_log_policies.sql в Supabase"
        );
        continue;
      }

      if (reserveRow?.id == null) {
        dbLogError(
          `notifications_log reserve no id chat ${chKey}`,
          new Error("insert returned no id")
        );
        continue;
      }

      let body = "⏰ Напоминание\n";
      if (items.length === 1) {
        const { s, diffDays } = items[0];
        const title = s.name || "Абонемент";
        body += `${title}\nДо окончания абонемента: ${pluralRuDays(diffDays)}`;
      } else {
        for (const { s, diffDays } of items) {
          const title = s.name || "Абонемент";
          body += `• ${title} — ${pluralRuDays(diffDays)}\n`;
        }
        body = body.replace(/\n+$/, "");
      }

      await send(chatId, body, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔕 Отключить напоминания",
                callback_data: `n_${primaryExtId}_off`
              }
            ]
          ]
        }
      });

      console.log(
        "ОТПРАВЛЕНО чату:",
        chKey,
        "абонементов в сообщении:",
        items.length
      );
      stats.sent += 1;
      sentNotificationKeys.add(dailyKey);
    }
  } catch (e) {
    console.error("JOB ERROR:", e);
    throw e;
  } finally {
    isNotificationsJobRunning = false;
  }
  return stats;
}

app.post("/jobs/check-notifications", async (req, res) => {
  if (!JOB_SECRET) {
    return res
      .status(500)
      .json({ ok: false, error: "JOB_SECRET is not configured" });
  }

  if (!isJobsRequestAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const stats = await runNotificationsJob();
    return res.status(200).json({ ok: true, ...stats });
  } catch {
    return res.status(500).json({ ok: false, error: "Job failed" });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Bot started on http://0.0.0.0:${PORT}`)
);

setBotCommands().catch((err) => {
  console.error("setBotCommands ERROR:", err);
});
