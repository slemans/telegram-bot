import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TIME_OPTIONS = [10, 14, 20];

// =======================
// Telegram
// =======================
async function sendMessage(chatId, text, extra = {}) {
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

async function answerCallbackQuery(id, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: id,
      text
    })
  });
}

// =======================
// Moyklass API
// =======================
async function getToken() {
  const res = await fetch("https://api.moyklass.com/v1/company/auth/getToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: MOYK_API_KEY })
  });

  const data = await res.json();
  return data.accessToken;
}

function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

async function findUserByPhone(phone) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/users?phone=${phone}&limit=1`,
    {
      headers: { "x-access-token": token }
    }
  );

  const data = await res.json();
  return data.users?.[0] || null;
}

async function getSubscriptions(userId) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}&statusId=2&limit=100`,
    {
      headers: { "x-access-token": token }
    }
  );

  const data = await res.json();
  return data.subscriptions || [];
}

// =======================
// Supabase DB
// =======================
async function saveReminder(reminder) {
  await supabase.from("reminders").upsert(reminder);
}

async function getReminders() {
  const { data } = await supabase.from("reminders").select("*");
  return data || [];
}

async function updateNextNotify(id, nextTs) {
  await supabase
    .from("reminders")
    .update({ next_notify_ts: nextTs })
    .eq("id", id);
}

async function disableReminder(chatId, subId) {
  await supabase
    .from("reminders")
    .update({ active: false })
    .eq("chat_id", chatId)
    .eq("subscription_id", subId);
}

// =======================
// Helpers
// =======================
function formatDate(date) {
  if (!date) return "не указана";
  return new Date(date).toLocaleDateString("ru-RU");
}

// =======================
// REMINDERS ENGINE
// =======================
async function processReminders() {
  const reminders = await getReminders();
  const now = Date.now();

  for (const r of reminders) {
    if (!r.active) continue;
    if (now < r.next_notify_ts) continue;

    await sendMessage(
      r.chat_id,
      `⏰ Абонемент "${r.class_name}" заканчивается ${formatDate(r.end_date)}`
    );

    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(r.notify_hour || 10, 0, 0, 0);

    await updateNextNotify(r.id, next.getTime());
  }
}

setInterval(() => {
  processReminders().catch(console.error);
}, 60 * 60 * 1000);

// =======================
// WEBHOOK
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const { message, callback_query } = req.body;

  // ================= CALLBACK =================
  if (callback_query) {
    const chatId = callback_query.message.chat.id;
    const data = callback_query.data;

    const [action, subId] = data.split(":");

    if (action === "disable") {
      await disableReminder(chatId, subId);
      await answerCallbackQuery(callback_query.id, "Отключено");
      return;
    }

    return;
  }

  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text;
  const contact = message.contact;

  // ================= START =================
  if (text === "/start") {
    await sendMessage(chatId, "Отправь контакт 📱", {
      reply_markup: {
        keyboard: [[{ text: "📲 Отправить контакт", request_contact: true }]],
        resize_keyboard: true
      }
    });
    return;
  }

  // ================= CONTACT CHECK =================
  if (!contact) {
    await sendMessage(chatId, "Нужно отправить контакт кнопкой");
    return;
  }

  const phone = normalizePhone(contact.phone_number);
  const user = await findUserByPhone(phone);

  if (!user) {
    await sendMessage(chatId, "Пользователь не найден");
    return;
  }

  const subs = await getSubscriptions(user.id);

  if (!subs.length) {
    await sendMessage(chatId, "Нет активных абонементов");
    return;
  }

  await sendMessage(chatId, `✅ Найден: ${user.name}`);

  for (const sub of subs) {
    const reminder = {
      chat_id: chatId,
      subscription_id: sub.id,
      class_name: sub.name || "Абонемент",
      end_date: sub.endDate,
      notify_hour: 10,
      next_notify_ts: Date.now() + 10000,
      active: true
    };

    await saveReminder(reminder);

    await sendMessage(
      chatId,
      `📌 ${sub.name}\nДействует до: ${formatDate(sub.endDate)}\n\nВключить уведомления?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Отключить", callback_data: `disable:${sub.id}` }]
          ]
        }
      }
    );
  }
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
