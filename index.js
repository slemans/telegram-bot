import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// =====================
// ENV
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// =====================
// INIT
// =====================
const app = express();
app.use(express.json());

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// =====================
// TELEGRAM HELPERS
// =====================
async function sendMessage(chatId, text, extra = {}) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...extra
    })
  });
}

async function answerCallback(id, text) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: id,
      text
    })
  });
}

// =====================
// MOYKASS
// =====================
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
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}&statusId=2`,
    {
      headers: { "x-access-token": token }
    }
  );

  const data = await res.json();
  const subs = data.subscriptions || [];

  return subs.map(s => {
    const remaining =
      s.visitCount != null && s.visitedCount != null
        ? Math.max(0, s.visitCount - s.visitedCount)
        : null;

    return {
      id: s.id,
      name: s.name || "Абонемент",
      endDate: s.endDate,
      remaining,
      visitCount: s.visitCount
    };
  });
}

// =====================
// DATE HELPERS
// =====================
function formatDate(date) {
  return new Date(date).toLocaleDateString("ru-RU");
}

function daysLeft(date) {
  return Math.ceil((new Date(date) - new Date()) / (1000 * 60 * 60 * 24));
}

// =====================
// REMINDER CHECK (every hour)
// =====================
async function checkReminders() {
  const now = new Date();

  const { data: reminders } = await supabase
    .from("reminders")
    .select("*")
    .eq("active", true);

  if (!reminders) return;

  for (const r of reminders) {
    const left = daysLeft(r.end_date);

    // ❗ за 3 дня
    if (left === 3) {
      await sendMessage(
        r.chat_id,
        `⏰ Напоминание!\nАбонемент "${r.class_name}" закончится через 3 дня (${formatDate(r.end_date)})`
      );
    }

    // ❗ каждый день после старта уведомлений
    if (left <= 3 && left >= 0) {
      await sendMessage(
        r.chat_id,
        `⚠️ Абонемент "${r.class_name}" скоро закончится (${formatDate(r.end_date)})`
      );
    }
  }
}

setInterval(() => {
  checkReminders().catch(console.error);
}, 60 * 60 * 1000);

// =====================
// WEBHOOK
// =====================
app.post(`/webhook`, async (req, res) => {
  res.sendStatus(200);

  const msg = req.body.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  // =====================
  // START
  // =====================
  if (msg.text === "/start") {
    await sendMessage(
      chatId,
      "📲 Отправьте контакт для проверки абонементов",
      {
        reply_markup: {
          keyboard: [
            [{ text: "📞 Отправить контакт", request_contact: true }]
          ],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
    return;
  }

  // =====================
  // CONTACT
  // =====================
  if (!msg.contact) return;

  const phone = normalizePhone(msg.contact.phone_number);
  const user = await findUserByPhone(phone);

  if (!user) {
    await sendMessage(chatId, "❌ Пользователь не найден");
    return;
  }

  const subs = await getSubscriptions(user.id);

  if (!subs.length) {
    await sendMessage(chatId, "❌ У вас нет активных абонементов");
    return;
  }

  let text = `✅ Клиент найден: ${user.name}\n\n🎫 Активные абонементы:\n`;

  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];

    text += `
${i + 1}. ${s.name}
- Осталось занятий: ${
      s.remaining != null ? `${s.remaining} (из ${s.visitCount})` : "безлимит"
    }
- Действует до: ${formatDate(s.endDate)}
`;
    
    // сохраняем в Supabase
    await supabase.from("reminders").upsert({
      chat_id: chatId,
      subscription_id: s.id,
      class_name: s.name,
      end_date: s.endDate,
      active: true
    });
  }

  await sendMessage(chatId, text);

  await sendMessage(chatId, "🔔 Включить уведомления? Они будут приходить за 3 дня до окончания.");
});

// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Bot started on port", PORT);
});
