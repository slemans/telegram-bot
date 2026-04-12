import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// ENV
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// DEBUG
console.log("SUPABASE_URL:", SUPABASE_URL);
console.log("SUPABASE_KEY:", SUPABASE_KEY ? "OK" : "MISSING");

// Supabase init
const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

if (!supabase) {
  console.log("❌ Supabase not initialized");
}

// Telegram
const BOT_TOKEN = process.env.BOT_TOKEN;

async function sendMessage(chatId, text) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
}

// TEST INSERT
async function saveReminder(data) {
  if (!supabase) return;

  const { error, data: result } = await supabase
    .from("reminders")
    .insert([data]);

  console.log("SUPABASE INSERT:", result, error);
}

// WEBHOOK
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const message = req.body.message;
  if (!message) return;

  const chatId = message.chat.id;

  if (message.text === "/start") {
    await sendMessage(chatId, "Бот работает");

    // TEST SAVE
    await saveReminder({
      chat_id: chatId,
      class_name: "test",
      notify_hour: 10,
      active: true,
    });

    await sendMessage(chatId, "Запись в Supabase отправлена");
  }
});

const { data, error } = await supabase
  .from("reminders")
  .insert([
    {
      chat_id: 123,
      class_name: "TEST",
      notify_hour: 10,
      active: true
    }
  ])
  .select();

console.log("DATA:", data);
console.log("ERROR:", error);

// PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Bot started on port", PORT);
});
