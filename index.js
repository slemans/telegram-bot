import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// =======================
// ENV
// =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// =======================
// SUPABASE
// =======================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("🚀 Bot started");

// =======================
// TELEGRAM
// =======================
async function sendMessage(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...extra,
    }),
  });
}

async function answerCallbackQuery(id, text = "OK") {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: id,
      text,
    }),
  });
}

// =======================
// MOYKCLASS API
// =======================
async function getToken() {
  const res = await fetch(
    "https://api.moyklass.com/v1/company/auth/getToken",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: MOYK_API_KEY }),
    }
  );

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
      headers: { "x-access-token": token },
    }
  );

  const data = await res.json();
  return data.users?.[0] || null;
}

// =======================
// 🔥 АБОНЕМЕНТЫ (ГЛАВНОЕ)
// =======================
async function getSubscriptions(userId) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}&statusId=2&limit=100`,
    {
      headers: { "x-access-token": token },
    }
  );

  const data = await res.json();
  const subs = data.subscriptions || [];

  return subs
    .map((s) => ({
      id: s.id,
      className: s.name || "Абонемент",
      endDate: s.endDate,
      visitCount: s.visitCount,
      visitedCount: s.visitedCount,
    }))
    .filter((s) => {
      if (s.visitCount == null) return true;
      return (s.visitCount - (s.visitedCount || 0)) > 0;
    });
}

// =======================
// SUPABASE SAVE
// =======================
async function saveReminder(r) {
  await supabase.from("reminders").insert([r]);
}

// =======================
// WEBHOOK
// =======================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const update = req.body;

  // ================= CALLBACK =================
  if (update.callback_query) {
    const q = update.callback_query;
    const chatId = q.message.chat.id;
    const data = q.data;

    await answerCallbackQuery(q.id);

    if (data.startsWith("reminder_yes")) {
      const subId = data.split(":")[1];

      await sendMessage(chatId, "Выберите время:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "10:00", callback_data: `time_10:${subId}` },
              { text: "14:00", callback_data: `time_14:${subId}` },
              { text: "20:00", callback_data: `time_20:${subId}` },
            ],
          ],
        },
      });
    }

    if (data.startsWith("time_")) {
      const hour = Number(data.split(":")[0].replace("time_", ""));
      const subId = data.split(":")[1];

      await saveReminder({
        chat_id: chatId,
        subscription_id: subId,
        notify_hour: hour,
        active: true,
        end_date: new Date().toISOString(),
        class_name: "Абонемент",
      });

      await sendMessage(chatId, "✅ Напоминание включено");
    }

    return;
  }

  // ================= MESSAGE =================
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text;
  const contact = msg.contact;

  // /start
  if (text === "/start") {
    await sendMessage(chatId, "Отправьте контакт", {
      reply_markup: {
        keyboard: [
          [{ text: "📱 Отправить контакт", request_contact: true }],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  // CONTACT
  if (contact) {
    const phone = normalizePhone(contact.phone_number);

    const user = await findUserByPhone(phone);

    if (!user) {
      await sendMessage(chatId, "❌ Пользователь не найден");
      return;
    }

    const subs = await getSubscriptions(user.id);

    // ❌ НЕТ АБОНЕМЕНТОВ
    if (!subs.length) {
      await sendMessage(chatId, "❌ У клиента нет активных абонементов");
      return;
    }

    // ✅ ЕСТЬ АБОНЕМЕНТЫ
    for (const sub of subs) {
      await sendMessage(
        chatId,
        `🎫 ${sub.className}\n📅 до: ${sub.endDate}`
      );

      await sendMessage(chatId, "Включить уведомления?", {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔔 Да",
                callback_data: `reminder_yes:${sub.id}`,
              },
              {
                text: "❌ Нет",
                callback_data: `reminder_no:${sub.id}`,
              },
            ],
          ],
        },
      });
    }

    return;
  }
});

const { data, error } = await supabase
  .from("reminders")
  .insert([
    {
      chat_id: 123,
      subscription_id: 1,
      notify_hour: 10,
      active: true,
      class_name: "test"
    }
  ]);

console.log(data, error);

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT);
