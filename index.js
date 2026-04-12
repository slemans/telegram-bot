import express from "express";
import { createClient } from "@supabase/supabase-js";
import cron from "node-cron";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ================= TELEGRAM =================
async function send(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra })
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

// ================= HELPERS =================
const today = () => new Date().toISOString().split("T")[0];

const hourNow = () => new Date().getHours();

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  // START
  if (msg.text === "/start") {
    return send(chatId, "📲 Отправьте контакт", {
      reply_markup: {
        keyboard: [[{ text: "📞 Отправить контакт", request_contact: true }]],
        resize_keyboard: true
      }
    });
  }

  // CONTACT
  if (!msg.contact) return;

  const phone = msg.contact.phone_number.replace(/\D/g, "");

  const user = await findUser(phone);
  if (!user) return send(chatId, "❌ Не найден");

  const subs = await getSubs(user.id);

  let text = `✅ ${user.name}\n\n🎫 Абонементы:\n`;

  const buttons = [];

  for (const s of subs) {
    text += `• ${s.name}\n`;

    buttons.push([
      { text: "🕙 10:00", callback_data: `t_${s.id}_10` },
      { text: "🕑 14:00", callback_data: `t_${s.id}_14` },
      { text: "🌙 20:00", callback_data: `t_${s.id}_20` }
    ]);
  }

  await send(chatId, text, {
    reply_markup: { inline_keyboard: buttons }
  });
});

// ================= CALLBACK =================
app.post("/callback", async (req, res) => {
  res.sendStatus(200);

  const q = req.body.callback_query;
  if (!q) return;

  const [_, subId, time] = q.data.split("_");

  await supabase.from("subscriptions").update({
    notify_enabled: true,
    notify_time: parseInt(time)
  }).eq("external_id", subId);

  await send(q.message.chat.id, `🔔 Уведомления включены: ${time}:00`);
});

// ================= CRON =================
cron.schedule("0 * * * *", async () => {
  const hour = hourNow();
  const date = today();

  const { data: subs } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("active", true)
    .eq("notify_enabled", true)
    .eq("notify_time", hour);

  if (!subs) return;

  for (const s of subs) {
    const { data: log } = await supabase
      .from("notifications_log")
      .select("*")
      .eq("subscription_id", s.id)
      .eq("sent_date", date)
      .eq("notify_time", hour)
      .single();

    if (log) continue;

    const left = Math.ceil(
      (new Date(s.end_date) - new Date()) / 86400000
    );

    await send(
      s.chat_id,
      `⏰ Напоминание\n${s.name}\nОсталось: ${left} дней`
    );

    await supabase.from("notifications_log").insert({
      subscription_id: s.id,
      sent_date: date,
      notify_time: hour
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Bot started"));
