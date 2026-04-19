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
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...extra
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

async function findUser(phone) {
  const token = await getToken();

  const r = await fetch(
    `https://api.moyklass.com/v1/company/users?phone=${phone}&limit=1`,
    { headers: { "x-access-token": token } }
  );

  const d = await r.json();
  return d.users?.[0];
}

async function getSubs(userId) {
  const token = await getToken();

  const r = await fetch(
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}&statusId=2`,
    { headers: { "x-access-token": token } }
  );

  const d = await r.json();
  return d.subscriptions || [];
}

/** Полная карточка абонемента (список часто без остатка и названия группы) */
async function fetchUserSubscriptionDetail(token, subscriptionId) {
  const url = `https://api.moyklass.com/v1/company/userSubscriptions/${subscriptionId}`;
  const r = await fetch(url, { headers: { "x-access-token": token } });
  if (!r.ok) return null;
  const d = await r.json();
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
    name = parseClassApiPayload(await r.json());
  }

  if (!name) {
    const byQuery = `https://api.moyklass.com/v1/company/classes?classId=${encodeURIComponent(classId)}`;
    r = await fetch(byQuery, { headers });
    if (r.ok) {
      name = parseClassApiPayload(await r.json());
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
  const name = parseSubscriptionCatalogPayload(await r.json());
  if (name) {
    cache.set(key, name);
    return name;
  }
  cache.set(key, null);
  return null;
}


/** Группа (Class) в МойКласс: GET /v1/company/classes/{classId} */
async function fetchClassNameById(token, classId, cache) {
  if (classId == null || classId === "") return null;
  if (cache.has(`class:${classId}`)) return cache.get(`class:${classId}`);

  const url = `https://api.moyklass.com/v1/company/classes/${encodeURIComponent(classId)}`;
  const r = await fetch(url, { headers: { "x-access-token": token } });
  if (!r.ok) {
    cache.set(`class:${classId}`, null);
    return null;
  }
  const d = await r.json();
  const name = d.name ?? d.class?.name;
  if (typeof name === "string" && name.trim()) {
    const t = name.trim();
    cache.set(`class:${classId}`, t);
    return t;
  }
  cache.set(`class:${classId}`, null);
  return null;
}

function lessonClassIdFrom(s) {
  return (
    s.lessonClassId ??
    s.lesson_class_id ??
    s.lessonClass?.id ??
    s.classId ??
    s.class_id
  );
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
    return "Осталось занятий: —";
  }
  const n = Math.max(0, Math.floor(Number(remaining)));
  const w = pluralRu(n, ["занятие", "занятия", "занятий"]);
  return `Осталось: ${n} ${w}`;
}


/** Название группы / занятия из ответа МойКласс (разные схемы полей) */
function subscriptionGroupTitle(s) {
  const fromNested =
    s.lessonClass?.name ||
    s.lessonClass?.title ||
    s.group?.name ||
    s.class?.name;
  const flat =
    s.lessonClassName ||
    s.className ||
    s.groupName ||
    s.name;
  return (typeof fromNested === "string" && fromNested) ||
    (typeof flat === "string" && flat) ||
    "—";
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

  const update = req.body;

  // ================= CALLBACK =================
  if (update.callback_query) {
    const q = update.callback_query;

    const [_, subId, time] = q.data.split("_");

    const { error } = await supabase
      .from("subscriptions")
      .update({
        notify_enabled: true,
        notify_time: parseInt(time)
      })
      .eq("external_id", subId);

    console.log("CALLBACK UPDATE:", error);
    
    await send(q.message.chat.id, `🔔 Уведомления включены: ${time}:00`);

    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  // ================= START =================
  if (msg.text === "/start") {
    return send(chatId, "📲 Отправьте контакт", {
      reply_markup: {
        keyboard: [
          [{ text: "📞 Отправить контакт", request_contact: true }]
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


    text += `📌 Название группы: ${groupTitle}\n`;
    text += `   ${formatRemainingLessons(remaining)}\n`;
    text += `   Действует до: ${until}\n\n`;

    const subId = s.id;

    buttons.push([
      { text: "🕙 10:00", callback_data: `t_${subId}_10` },
      { text: "🕑 14:00", callback_data: `t_${subId}_14` },
      { text: "🌙 20:00", callback_data: `t_${subId}_20` }
    ]);

    const nameForDb =
      groupTitle !== "—" ? groupTitle : merged.name ?? null;


    // сохраняем
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
});

// ================= CRON =================
cron.schedule("* * * * *", async () => {
  const now = new Date();

  const hour = parseInt(
    now.toLocaleString("en-US", {
      timeZone: "Europe/Minsk",
      hour: "2-digit",
      hour12: false
    })
  );

  const minute = now.getMinutes();

  console.log("CRON:", hour, minute);

  // окно 10 минут (чтобы не пропускало после рестарта)
  if (minute > 10) return;

  const today = new Date().toISOString().split("T")[0];

  const { data: subs } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("active", true)
    .eq("notify_enabled", true)
    .eq("notify_time", hour);

  if (!subs || subs.length === 0) {
    console.log("Нет подписок для отправки");
    return;
  }

  for (const s of subs) {
    const end = new Date(s.end_date);
    const diffDays = Math.ceil((end - now) / 86400000);

    // ❗ только за 3 дня
    if (diffDays !== 3) {
      console.log("SKIP (не 3 дня):", s.external_id, diffDays);
      continue;
    }

    // ❗ уже отправляли сегодня?
    const { data: log } = await supabase
      .from("notifications_log")
      .select("*")
      .eq("subscription_id", s.external_id)
      .eq("sent_date", today)
      .eq("notify_time", hour)
      .maybeSingle();

    if (log) {
      console.log("SKIP (уже отправляли):", s.external_id);
      continue;
    }

    // ✅ отправка
    await send(
      s.chat_id,
      `⏰ Напоминание\n${s.name}\nЗаканчивается через 3 дня`
    );

    console.log("ОТПРАВЛЕНО:", s.external_id);

    // ✅ лог
    await supabase.from("notifications_log").insert({
      subscription_id: s.external_id,
      sent_date: today,
      notify_time: hour
    });

    // ❗ если уже истёк → отключаем
    if (diffDays <= 0) {
      await supabase
        .from("subscriptions")
        .update({ notify_enabled: false, active: false })
        .eq("external_id", s.external_id);

      console.log("ОТКЛЮЧЕНО:", s.external_id);
    }
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Bot started on http://0.0.0.0:${PORT}`)
);
