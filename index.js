import "dotenv/config";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import * as cron from "node-cron";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !BOT_TOKEN || !MOYK_API_KEY) {
  console.error(
    "Задайте в .env: SUPABASE_URL, SUPABASE_KEY, BOT_TOKEN, MOYK_API_KEY"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

function parseClassApiPayload(d) {
  if (d == null) return null;
  if (Array.isArray(d)) {
    const row = d[0];
    if (row && typeof row.name === "string" && row.name.trim()) {
      return row.name.trim();
    }
    return null;
  }
  if (typeof d.name === "string" && d.name.trim()) return d.name.trim();
  if (typeof d.class?.name === "string" && d.class.name.trim()) {
    return d.class.name.trim();
  }
  if (d.data != null) return parseClassApiPayload(d.data);
  if (d.classes != null) return parseClassApiPayload(d.classes);
  return null;
}

/** Группа (Class): GET /v1/company/classes/{id} или список ?classId= (см. OpenAPI МойКласс) */
async function fetchClassNameById(token, classId, cache) {
  if (classId == null || classId === "") return null;
  const n = Number(classId);
  if (Number.isFinite(n) && n <= 0) return null;

  const cacheKey = `class:${classId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const headers = { "x-access-token": token };

  const byPath = `https://api.moyklass.com/v1/company/classes/${encodeURIComponent(classId)}`;
  let r = await fetch(byPath, { headers });
  let name = null;
  if (r.ok) {
    name = parseClassApiPayload(await r.json().catch(() => null));
  }

  if (!name) {
    const byQuery = `https://api.moyklass.com/v1/company/classes?classId=${encodeURIComponent(classId)}`;
    r = await fetch(byQuery, { headers });
    if (r.ok) {
      name = parseClassApiPayload(await r.json().catch(() => null));
    }
  }

  if (name) {
    cache.set(cacheKey, name);
    return name;
  }
  cache.set(cacheKey, null);
  return null;
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

async function resolveSubscriptionForDisplay(token, s, nameCache) {
  let merged = { ...s };
  const detail = await fetchUserSubscriptionDetail(token, s.id);
  if (detail && typeof detail === "object") {
    merged = { ...s, ...detail };
  }

  const remaining = computeRemainingLessons(merged);
  let groupTitle = pickGroupTitle(merged);

  if (!groupTitle) {
    for (const cid of collectClassIds(merged)) {
      groupTitle = await fetchClassNameById(token, cid, nameCache);
      if (groupTitle) break;
    }
  }
  if (!groupTitle) {
    groupTitle = await fetchSubscriptionCatalogName(
      token,
      merged.subscriptionId,
      nameCache
    );
  }

  return {
    merged,
    remaining,
    groupTitle: groupTitle || "—"
  };
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

    const cancelMatch = data.match(/^n_(.+)_off$/);
    if (cancelMatch) {
      const subId = cancelMatch[1];
      const { error } = await supabase
        .from("subscriptions")
        .update({ notify_enabled: false })
        .eq("external_id", subId);

      console.log("NOTIFY OFF:", subId, error);
      await answerCallbackQuery(q, "Напоминания отключены");
      await send(
        q.message.chat.id,
        "🔕 Напоминания по этому абонементу отключены."
      );
      return;
    }

    const parts = data.split("_");
    if (parts[0] === "t" && parts.length >= 3) {
      const subId = parts[1];
      const time = parts[2];

      const { error } = await supabase
        .from("subscriptions")
        .update({
          notify_enabled: true,
          notify_time: parseInt(time, 10)
        })
        .eq("external_id", subId);

      console.log("CALLBACK UPDATE:", error);

      await answerCallbackQuery(q, `Включено: ${time}:00`);
      await send(q.message.chat.id, `🔔 Уведомления об окончании абонимента включено, будет отправлена за 3 дня до кончания в: ${time}:00`);
    } else {
      await answerCallbackQuery(q);
    }

    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  // ================= START =================
  if (msg.text === "/start") {
    return send(chatId, "📲 Отправьте ваш номер телефона, что бы мы смогли вас найти", {
      reply_markup: {
        keyboard: [
          [{ text: "📞 Поделится моим номером телефона", request_contact: true }]
        ],
        resize_keyboard: true
      }
    });
  }

  // ================= CONTACT =================
  if (!msg.contact) return;

  const phone = msg.contact.phone_number.replace(/\D/g, "");

  const user = await findUser(phone);

  if (!user) {
    return send(chatId, "❌ Пользователь не найден");
  } else {
    // ===== USERS SAVE =====
    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("chat_id", chatId)
      .maybeSingle();
    
    if (!existingUser) {
      const { error } = await supabase
        .from("users")
        .insert({
          chat_id: chatId,
          phone,
          name: user.name
        });
    
      console.log("USER INSERT:", error);
    }
  }

  const subs = await getSubs(user.id);

  if (!subs.length) {
    return send(chatId, "❌ Нет активных абонементов");
  }

  const token = await getToken();
  const nameCache = new Map();

  // ================= TEXT =================
  let text = `✅ Клиент найден: ${user.name}\n\n🎫 Активные абонементы:\n\n`;

  const buttons = [];

  for (const s of subs) {
    const { merged, remaining, groupTitle } = await resolveSubscriptionForDisplay(
      token,
      s,
      nameCache
    );

    const endRaw = subscriptionEndDate(merged);
    const until = new Date(endRaw).toLocaleDateString("ru-RU");

    text += `📌 Абонемент\n`;
    text += `Название группы где вы занимаетесь: ${groupTitle}\n`;
    text += `${formatRemainingLessons(remaining)}\n`;
    text += `Абонемент действует до: ${until}\n\n`;
    text += `⏰ Если вам нужно напоминание об окончании Абонемента, выберите удобное время ниже что бы мы могли вам прислать уведомление\n`;

    const subId = s.id;

    buttons.push([
      { text: "🕙 10:00", callback_data: `t_${subId}_10` },
      { text: "🕑 14:00", callback_data: `t_${subId}_14` },
      { text: "🌙 20:00", callback_data: `t_${subId}_20` },
      { text: "🔕 Выкл", callback_data: `n_${subId}_off` }
    ]);

    const nameForDb =
      groupTitle !== "—" ? groupTitle : merged.name ?? null;

    const { data, error } = await supabase
      .from("subscriptions")
      .upsert(
        {
          external_id: subId,
          chat_id: chatId,
          name: nameForDb,
          end_date: endRaw,
          remaining: remaining ?? pickRemainingVisits(merged),
          active: true
        },
        {
          onConflict: "external_id"
        }
      )
      .select();

    console.log("SUPABASE:", data, error);
  }

  await send(chatId, text, {
    reply_markup: { inline_keyboard: buttons }
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

// ================= CRON =================
cron.schedule("* * * * *", async () => {
  try {
    const now = new Date();
    const { hour, minute } = getMinskClock(now);
    const today = todayDateMinsk(now);

    console.log("CRON Minsk:", hour, minute, "date", today);

    // Авто-отключение завершённых абонементов выполняем каждую минуту:
    // это не зависит от времени напоминания.
    const { data: activeSubs, error: activeSelErr } = await supabase
      .from("subscriptions")
      .select("external_id, end_date")
      .eq("active", true);

    if (activeSelErr) {
      dbLogError("subscriptions select active for expire check", activeSelErr);
    } else if (activeSubs?.length) {
      for (const s of activeSubs) {
        const diffDays = daysUntilEndDateMinsk(s.end_date, now);
        if (diffDays <= 0) {
          const { error: expErr } = await supabase
            .from("subscriptions")
            .update({ notify_enabled: false, active: false })
            .eq("external_id", s.external_id);
          dbLogError(`subscriptions expire ${s.external_id}`, expErr);
          if (!expErr) console.log("ИСТЁК (авто off):", s.external_id);
        }
      }
    }

    // первые 15 минут часа по Минску (после рестарта не пропустить слот)
    if (minute > 14) return;

    const { data: subs, error: selErr } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("active", true)
      .eq("notify_enabled", true)
      .eq("notify_time", hour);

    if (selErr) {
      console.error("CRON select subscriptions:", selErr);
      return;
    }

    if (!subs || subs.length === 0) {
      return;
    }

    console.log("CRON кандидатов:", subs.length, "notify_time=", hour);

    for (const s of subs) {
      const diffDays = daysUntilEndDateMinsk(s.end_date, now);

      if (diffDays <= 0) continue;

      if (diffDays < 1 || diffDays > 3) {
        console.log("SKIP (вне окна 1–3 дня):", s.external_id, diffDays);
        continue;
      }

      const { data: log, error: logErr } = await supabase
        .from("notifications_log")
        .select("*")
        .eq("subscription_id", s.external_id)
        .eq("sent_date", today)
        .maybeSingle();

      if (logErr) {
        console.error("notifications_log select:", logErr);
        continue;
      }

      if (log) {
        console.log("SKIP (уже отправляли):", s.external_id);
        continue;
      }

      const title = s.name || "Абонемент";
      const body = `⏰ Напоминание\n${title}\nДо окончания абонемента: ${pluralRuDays(diffDays)}`;

      await send(s.chat_id, body, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔕 Отключить напоминания",
                callback_data: `n_${s.external_id}_off`
              }
            ]
          ]
        }
      });

      console.log("ОТПРАВЛЕНО:", s.external_id, "diffDays=", diffDays);

      const { error: insErr } = await supabase
        .from("notifications_log")
        .upsert({
          subscription_id: s.external_id,
          sent_date: today,
          notify_time: hour
        }, { onConflict: "subscription_id,sent_date" });

      if (insErr) {
        console.error("notifications_log insert:", insErr, s.external_id);
      }
    }
  } catch (e) {
    console.error("CRON ERROR:", e);
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Bot started on http://0.0.0.0:${PORT}`)
);
