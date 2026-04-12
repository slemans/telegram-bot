import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// =======================
// ENV
// =======================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;

// =======================
// DEBUG (очень важно на Render)
// =======================
console.log("SUPABASE_URL:", SUPABASE_URL);
console.log("SUPABASE_KEY:", SUPABASE_ANON_KEY ? "OK" : "MISSING");

// =======================
// Supabase init
// =======================
let supabase = null;

if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
  console.log("❌ Supabase not initialized (ENV missing)");
}

// =======================
// Telegram helper
// =======================
async function sendMessage(chatId, text) {
  if (!BOT_TOKEN) return;

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}

// =======================
// Test Supabase route
// =======================
app.get("/test-db", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase not configured" });
  }

  const { data, error } = await supabase.from("reminders").select("*");

  if (error) {
    return res.status(500).json({ error });
  }

  res.json({ data });
});

// =======================
// Telegram webhook
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const message = req.body.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text;

  if (text === "/start") {
    await sendMessage(chatId, "Бот работает ✅ Supabase подключен");
    return;
  }

  if (text === "/db") {
    if (!supabase) {
      await sendMessage(chatId, "❌ Supabase не подключен");
      return;
    }

    const { data, error } = await supabase.from("reminders").select("*");

    if (error) {
      await sendMessage(chatId, "❌ Ошибка базы: " + error.message);
      return;
    }

    await sendMessage(chatId, `📦 записей: ${data.length}`);
    return;
  }

  await sendMessage(chatId, "Напиши /start или /db");
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server started on port", PORT);
});
