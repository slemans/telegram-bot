import express from "express";
import dns from "dns";

dns.setDefaultResultOrder("ipv4first"); // 🔥 FIX Render + Telegram

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

const TIME_OPTIONS = [10, 14, 20];

// =======================
// MEMORY STORAGE
// =======================
const reminderJobs = new Map();
const availableSubscriptions = new Map();

// =======================
// SAFE TELEGRAM REQUEST
// =======================
async function tgFetch(url, body) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);

    return res;
  } catch (e) {
    console.log("❌ Telegram fetch error:", e.message);
    return null;
  }
}

async function sendMessage(chatId, text, extra = {}) {
  await tgFetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function answerCallbackQuery(id, text) {
  await tgFetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    callback_query_id: id,
    text
  });
}

// =======================
// MOYK CLASS API
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
// DATE HELPERS
// =======================
function formatDate(d) {
  if (!d) return "не указана";
  return new Date(d).toLocaleDateString("ru-RU");
}

function formatIso(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function getNextDayHour(hour) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

// =======================
// REMINDER LOOP
// =======================
setInterval(async () => {
  const now = Date.now();

  for (const [key, r] of reminderJobs.entries()) {
    if (!r.active) continue;
    if (now < r.nextNotifyTs) continue;

    await sendMessage(
      r.chatId,
      `⏰ Абонемент "${r.className}" скоро закончится (${formatDate(r.endDate)})`
    );

    r.nextNotifyTs = getNextDayHour(r.notifyHour || 10).getTime();
    reminderJobs.set(key, r);
  }
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

    const [action, id] = data.split(":");
    const key = `${chatId}:${id}`;

    const sub = availableSubscriptions.get(key);
    const reminder = reminderJobs.get(key);

    if (!sub && action !== "disable_yes") {
      return answerCallbackQuery(callback_query.id, "Не найдено");
    }

    if (action === "reminder_yes") {
      await sendMessage(chatId, `Выберите время:`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "10:00", callback_data: `set_10:${id}` },
              { text: "14:00", callback_data: `set_14:${id}` },
              { text: "20:00", callback_data: `set_20:${id}` }
            ]
          ]
        }
      });

      return answerCallbackQuery(callback_query.id, "OK");
    }

    if (action.startsWith("set_")) {
      const hour = Number(action.split("_")[1]);

      reminderJobs.set(key, {
        chatId,
        className: sub.className,
        endDate: sub.endDate,
        notifyHour: hour,
        nextNotifyTs: getNextDayHour(hour).getTime(),
        active: true
      });

      await sendMessage(chatId, `✅ Установлено на ${hour}:00`);
      return answerCallbackQuery(callback_query.id, "Готово");
    }

    if (action === "reminder_no") {
      await sendMessage(chatId, "Ок, без уведомлений");
      return answerCallbackQuery(callback_query.id, "OK");
    }

    return;
  }

  // ================= MESSAGE =================
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text;
  const contact = message.contact;

  if (text === "/start") {
    await sendMessage(chatId, "Отправь контакт");
    return;
  }

  if (!contact) {
    await sendMessage(chatId, "Нужен контакт");
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
    await sendMessage(chatId, "Нет абонементов");
    return;
  }

  await sendMessage(chatId, `Клиент: ${user.name}`);

  for (const s of subs) {
    const key = `${chatId}:${s.id}`;

    availableSubscriptions.set(key, {
      id: s.id,
      className: s.name || "Без названия",
      endDate: s.endDate
    });

    await sendMessage(chatId, `Абонемент: ${s.name}`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔔 Напомнить", callback_data: `reminder_yes:${s.id}` },
            { text: "❌ Нет", callback_data: `reminder_no:${s.id}` }
          ]
        ]
      }
    });
  }
});

// =======================
app.listen(3000, () => {
  console.log("🚀 Bot started");
});
