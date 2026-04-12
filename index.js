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
// SAFE SUPABASE INIT
// =======================
let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log("✅ Supabase initialized");
} else {
  console.log("❌ Supabase not initialized (ENV missing)");
}

// =======================
// MEMORY (fallback)
// =======================
const reminderJobs = new Map();
const availableSubscriptions = new Map();

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
// MOYKASS
// =======================
async function getToken() {
  const res = await fetch(
    "https://api.moyklass.com/v1/company/auth/getToken",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: MOYK_API_KEY })
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
// HELPERS
// =======================
function formatDate(d) {
  if (!d) return "не указана";
  return new Date(d).toLocaleDateString("ru-RU");
}

// =======================
// WEBHOOK
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const msg = req.body.message;
  const cb = req.body.callback_query;

  // =======================
  // CALLBACKS
  // =======================
  if (cb) {
    const chatId = cb.message.chat.id;
    const data = cb.data;

    await answerCallbackQuery(cb.id, "OK");

    if (data === "ping") {
      await sendMessage(chatId, "pong");
    }

    return;
  }

  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text;
  const contact = msg.contact;

  // =======================
  // START
  // =======================
  if (text === "/start") {
    await sendMessage(
      chatId,
      "Отправь контакт кнопкой ниже",
      {
        reply_markup: {
          keyboard: [
            [{ text: "📱 Отправить контакт", request_contact: true }]
          ],
          resize_keyboard: true
        }
      }
    );
    return;
  }

  // =======================
  // HELP
  // =======================
  if (text === "/help") {
    await sendMessage(
      chatId,
      "📞 Поддержка: @admin"
    );
    return;
  }

  // =======================
  // CONTACT CHECK
  // =======================
  if (!contact) {
    await sendMessage(chatId, "Отправь контакт через кнопку");
    return;
  }

  const phone = normalizePhone(contact.phone_number || "");

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

  let textMsg = `✅ ${user.name}\n\nАбонементы:\n`;

  for (const s of subs) {
    textMsg += `\n• ${s.mainClassId || "Без группы"}\n`;
    textMsg += `  до: ${formatDate(s.endDate)}\n`;
  }

  await sendMessage(chatId, textMsg);

  // save for reminders
  for (const s of subs) {
    const key = `${chatId}:${s.id}`;
    availableSubscriptions.set(key, s);

    await sendMessage(chatId,
      `Включить напоминание для абонемента ${s.id}?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Да", callback_data: "ping" },
              { text: "Нет", callback_data: "ping" }
            ]
          ]
        }
      }
    );
  }
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server started on port", PORT);
});
