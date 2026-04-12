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
// SUPABASE INIT
// =======================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("🚀 Bot started");

// =======================
// TELEGRAM
// =======================
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
    console.error("sendMessage error:", e);
  }
}

async function answerCallbackQuery(id, text) {
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
// MOYKLASS (без изменений)
// =======================
async function getToken() {
  const res = await fetch("https://api.moyklass.com/v1/company/auth/getToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: MOYK_API_KEY }),
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
      headers: { "x-access-token": token },
    }
  );

  const data = await res.json();
  return data.users?.[0] || null;
}

// =======================
// SUPABASE HELPERS
// =======================

// сохранить reminder
async function saveReminder(data) {
  const { error } = await supabase.from("reminders").insert([data]);
  if (error) console.error("Supabase insert error:", error);
}

// получить reminders
async function getReminders() {
  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("active", true);

  if (error) {
    console.error(error);
    return [];
  }

  return data;
}

// отключить reminder
async function disableReminder(id) {
  await supabase.from("reminders").update({ active: false }).eq("id", id);
}

// =======================
// CRON (каждую минуту)
// =======================
setInterval(async () => {
  const reminders = await getReminders();
  const now = new Date();

  for (const r of reminders) {
    const end = new Date(r.end_date);
    const notifyAt = new Date(end);
    notifyAt.setDate(notifyAt.getDate() - 2);
    notifyAt.setHours(r.notify_hour, 0, 0, 0);

    if (Math.abs(now - notifyAt) < 60000) {
      await sendMessage(
        r.chat_id,
        `⏰ Абонемент "${r.class_name}" скоро закончится (${end.toLocaleDateString()})`
      );
    }
  }
}, 60000);

// =======================
// WEBHOOK
// =======================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const update = req.body;

  // ===== CALLBACKS =====
  if (update.callback_query) {
    const q = update.callback_query;
    const chatId = q.message.chat.id;
    const data = q.data;

    await answerCallbackQuery(q.id, "ok");

    // включение reminder
    if (data.startsWith("reminder_yes")) {
      const subId = data.split(":")[1];

      await sendMessage(chatId, "Выберите время: 10 / 14 / 20");

      return;
    }

    if (data.startsWith("reminder_time_")) {
      const hour = Number(data.replace("reminder_time_", "").split(":")[0]);

      const subId = data.split(":")[1];

      await saveReminder({
        chat_id: chatId,
        subscription_id: subId,
        class_name: "Абонемент",
        notify_hour: hour,
        end_date: new Date().toISOString(),
        active: true,
      });

      await sendMessage(chatId, "✅ Напоминание включено");
      return;
    }

    return;
  }

  // ===== MESSAGE =====
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text;
  const contact = msg.contact;

  // /start
  if (text === "/start") {
    await sendMessage(
      chatId,
      "Нажмите кнопку и отправьте контакт",
      {
        reply_markup: {
          keyboard: [
            [{ text: "📱 Отправить контакт", request_contact: true }],
          ],
          resize_keyboard: true,
        },
      }
    );
    return;
  }

  // контакт
  if (contact) {
    const phone = normalizePhone(contact.phone_number);

    const user = await findUserByPhone(phone);

    if (!user) {
      await sendMessage(chatId, "Пользователь не найден");
      return;
    }

    await sendMessage(chatId, `Привет ${user.name}`);

    await sendMessage(chatId, "Включить напоминание?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Да", callback_data: "reminder_yes:1" },
            { text: "Нет", callback_data: "reminder_no:1" },
          ],
        ],
      },
    });

    return;
  }
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT);
