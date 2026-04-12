import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// ===================== ENV =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===================== APP =====================
const app = express();
app.use(express.json());

// ===================== TELEGRAM =====================
async function sendMessage(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra })
  });
}

// ===================== MOYKASS =====================
async function getToken() {
  const res = await fetch("https://api.moyklass.com/v1/company/auth/getToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: MOYK_API_KEY })
  });

  const data = await res.json();
  return data.accessToken;
}

async function findUser(phone) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/users?phone=${phone}&limit=1`,
    {
      headers: { "x-access-token": token }
    }
  );

  const data = await res.json();
  return data.users?.[0];
}

async function getSubs(userId) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}&statusId=2`,
    {
      headers: { "x-access-token": token }
    }
  );

  const data = await res.json();
  return data.subscriptions || [];
}

// ===================== HELPERS =====================
const daysLeft = (date) =>
  Math.ceil((new Date(date) - new Date()) / 86400000);

// ===================== CHECK NOTIFICATIONS =====================
async function checkNotifications() {
  const { data } = await supabase
    .from("reminders")
    .select("*")
    .eq("active", true);

  if (!data) return;

  for (const r of data) {
    const left = daysLeft(r.end_date);

    // ❗ защита от дубля
    const { data: sent } = await supabase
      .from("sent_notifications")
      .select("*")
      .eq("reminder_id", r.id)
      .eq("days_left", left)
      .single();

    if (sent) continue;

    if (left === 3 || left === 2 || left === 1 || left === 0) {
      await sendMessage(
        r.chat_id,
        `⏰ Абонемент "${r.class_name}" заканчивается через ${left} дней`
      );

      await supabase.from("sent_notifications").insert({
        reminder_id: r.id,
        days_left: left
      });
    }
  }
}

// запускаем 1 раз в час
setInterval(() => {
  checkNotifications().catch(console.error);
}, 60 * 60 * 1000);

// ===================== WEBHOOK =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  // START
  if (msg.text === "/start") {
    return sendMessage(chatId, "📲 Отправьте контакт", {
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

  if (!user) {
    return sendMessage(chatId, "❌ Пользователь не найден");
  }

  const subs = await getSubs(user.id);

  if (!subs.length) {
    return sendMessage(chatId, "❌ Нет активных абонементов");
  }

  let text = `✅ Клиент найден: ${user.name}\n\n🎫 Активные абонементы:\n`;

  for (const s of subs) {
    text += `
• ${s.name}
- Действует до: ${new Date(s.endDate).toLocaleDateString("ru-RU")}
`;

    await supabase.from("reminders").upsert({
      chat_id: chatId,
      subscription_id: s.id,
      class_name: s.name,
      end_date: s.endDate,
      active: true
    });
  }

  await sendMessage(chatId, text);
});

// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Bot started"));
