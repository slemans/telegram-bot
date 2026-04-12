import express from "express";
import { createClient } from "@supabase/supabase-js";

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ================= SAFETY CHECK =================
const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

// ================= APP =================
const app = express();
app.use(express.json());

// ================= TELEGRAM =================
async function sendMessage(chatId, text, extra = {}) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...extra,
      }),
    });
  } catch (e) {
    console.error("Telegram error:", e);
  }
}

// ================= MOYKASS =================
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

async function findUser(phone) {
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

async function getSubs(userId) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}&statusId=2`,
    {
      headers: { "x-access-token": token },
    }
  );

  const data = await res.json();
  return data.subscriptions || [];
}

// ================= HELPERS =================
const daysLeft = (date) =>
  Math.ceil((new Date(date) - new Date()) / (1000 * 60 * 60 * 24));

// ================= REMINDERS =================
async function saveReminder(chatId, sub) {
  if (!supabase) return;

  try {
    await supabase.from("reminders").upsert({
      chat_id: chatId,
      subscription_id: sub.id,
      class_name: sub.name,
      end_date: sub.endDate,
      active: true,
    });
  } catch (e) {
    console.error("Supabase insert error:", e);
  }
}

// ================= CHECK NOTIFICATIONS =================
async function checkNotifications() {
  if (!supabase) return;

  const { data } = await supabase
    .from("reminders")
    .select("*")
    .eq("active", true);

  if (!data) return;

  for (const r of data) {
    const left = daysLeft(r.end_date);

    if (left > 3) continue;

    await sendMessage(
      r.chat_id,
      `⏰ Абонемент "${r.class_name}" заканчивается через ${left} дн.`
    );
  }
}

setInterval(() => {
  checkNotifications().catch(console.error);
}, 60 * 60 * 1000);

// ================= WEBHOOK =================
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
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }

  // CONTACT ONLY
  if (!msg.contact) return;

  const phone = normalizePhone(msg.contact.phone_number);

  const user = await findUser(phone);

  if (!user) {
    return sendMessage(chatId, "❌ Пользователь не найден");
  }

  const subs = await getSubs(user.id);

  if (!subs.length) {
    return sendMessage(chatId, "❌ У вас нет активных абонементов");
  }

  let text = `✅ Клиент найден: ${user.name}\n\n🎫 Активные абонементы:\n`;

  for (const s of subs) {
    text += `
• ${s.name}
- Осталось: ${s.visitCount ?? "?"}
- Действует до: ${new Date(s.endDate).toLocaleDateString("ru-RU")}
`;

    await saveReminder(chatId, s);
  }

  text += `\n🔔 Уведомления включены`;

  await sendMessage(chatId, text);
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Bot started on port", PORT);
});
