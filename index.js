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

/** Склонение числительных: 1 занятие, 2 занятия, 5 занятий */
function pluralRu(n, forms) {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
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

  // ================= TEXT =================
  let text = `✅ Клиент найден: ${user.name}\n\n🎫 Активные абонементы:\n\n`;

  const buttons = [];

  for (const s of subs) {
   const groupTitle = subscriptionGroupTitle(s);
    const until = new Date(s.endDate).toLocaleDateString("ru-RU");

    text += `📌 Название группы: ${groupTitle}\n`;
    text += `   ${formatRemainingLessons(s.remaining)}\n`;
    text += `   Действует до: ${until}\n\n`;

    buttons.push([
      { text: "🕙 10:00", callback_data: `t_${s.id}_10` },
      { text: "🕑 14:00", callback_data: `t_${s.id}_14` },
      { text: "🌙 20:00", callback_data: `t_${s.id}_20` }
    ]);

    // сохраняем
    const { data, error } = await supabase
    .from("subscriptions")
    .upsert({
      external_id: s.id,
      chat_id: chatId,
      name: s.name,
      end_date: s.endDate,
      remaining: s.remaining,
      active: true
    }, {
      onConflict: "external_id"
    })
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
