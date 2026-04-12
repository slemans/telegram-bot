import express from "express";
import mysql from "mysql2/promise";

// =======================
// CONFIG
// =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

const app = express();
app.use(express.json());

// =======================
// DB INIT
// =======================
let db;

async function initDB() {
  try {
    db = await mysql.createPool({
      host: "vh114.hoster.by",
      user: "autocutb_fraudancebot",
      password: "icf.RCi{5Kzd",
      database: "autocutb_fraudancebot",
      waitForConnections: true,
      connectionLimit: 5
    });

    await db.execute("SELECT 1");
    console.log("✅ DB connected");
  } catch (err) {
    console.error("❌ DB ERROR:", err.message);
  }
}

await initDB();

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
// MOYKLASS
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

// =======================
// SUBSCRIPTIONS
// =======================
async function getSubscriptions(userId) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}&limit=100`,
    {
      headers: { "x-access-token": token }
    }
  );

  const data = await res.json();
  const now = new Date();

  return (data.subscriptions || [])
    .map(sub => {
      const end = new Date(sub.endDate);

      if (end < now) return null;

      let remaining = null;
      if (sub.visitCount != null && sub.visitedCount != null) {
        remaining = Math.max(0, sub.visitCount - sub.visitedCount);
      }

      return {
        id: sub.id,
        className: sub.name || "Абонемент",
        endDate: sub.endDate,
        remaining
      };
    })
    .filter(Boolean);
}

function formatDate(date) {
  return new Date(date).toLocaleDateString("ru-RU");
}

// =======================
// REMINDERS (DB)
// =======================
async function saveReminder(chatId, sub, hour, notifyTs) {
  await db.execute(
    `INSERT INTO reminders 
    (chat_id, subscription_id, class_name, end_date, notify_hour, next_notify_ts, active)
    VALUES (?, ?, ?, ?, ?, ?, true)
    ON DUPLICATE KEY UPDATE
    notify_hour = VALUES(notify_hour),
    next_notify_ts = VALUES(next_notify_ts),
    active = true`,
    [chatId, sub.id, sub.className, sub.endDate, hour, notifyTs]
  );
}

async function disableReminder(chatId, subId) {
  await db.execute(
    `UPDATE reminders SET active = false WHERE chat_id = ? AND subscription_id = ?`,
    [chatId, subId]
  );
}

async function processReminders() {
  const [rows] = await db.execute(
    `SELECT * FROM reminders WHERE active = true`
  );

  const now = Date.now();

  for (const r of rows) {
    if (now < r.next_notify_ts) continue;

    await sendMessage(
      r.chat_id,
      `⏰ Абонемент "${r.class_name}" заканчивается ${formatDate(r.end_date)}`
    );

    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(r.notify_hour, 0, 0, 0);

    await db.execute(
      `UPDATE reminders SET next_notify_ts = ? WHERE id = ?`,
      [next.getTime(), r.id]
    );
  }
}

// =======================
// CRON ENDPOINT
// =======================
app.get("/run-reminders", async (req, res) => {
  await processReminders();
  res.send("OK");
});

// =======================
// WEBHOOK
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const msg = req.body.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  if (msg.text === "/start") {
    await sendMessage(
      chatId,
      "Отправь свой контакт 👇",
      {
        reply_markup: {
          keyboard: [[{ text: "📱 Отправить контакт", request_contact: true }]],
          resize_keyboard: true
        }
      }
    );
    return;
  }

  if (!msg.contact) {
    await sendMessage(chatId, "❌ Отправь контакт кнопкой");
    return;
  }

  if (msg.contact.user_id !== msg.from.id) {
    await sendMessage(chatId, "❌ Только свой контакт");
    return;
  }

  const phone = normalizePhone(msg.contact.phone_number);
  const user = await findUserByPhone(phone);

  if (!user) {
    await sendMessage(chatId, "❌ Не найден");
    return;
  }

  const subs = await getSubscriptions(user.id);

  if (!subs.length) {
    await sendMessage(chatId, "❌ Нет активных абонементов");
    return;
  }

  let text = `✅ Найден: ${user.name}\n\n`;

  subs.forEach(s => {
    text += `🎫 ${s.className}
- Осталось: ${s.remaining ?? "безлимит"}
- До: ${formatDate(s.endDate)}\n\n`;
  });

  await sendMessage(chatId, text);

  for (const sub of subs) {
    await sendMessage(
      chatId,
      `Включить напоминание для "${sub.className}"?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Да", callback_data: `on:${sub.id}` },
              { text: "Нет", callback_data: `off:${sub.id}` }
            ]
          ]
        }
      }
    );
  }
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server started");
});
