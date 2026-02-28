// index.js

// Load .env only in local dev, not on Railway
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

// ----- Environment variables -----
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PPLX_API_KEY = process.env.PPLX_API_KEY;
const SERVER_URL = process.env.SERVER_URL; // e.g. https://your-app.up.railway.app

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}
if (!PPLX_API_KEY) {
  console.error("Missing PPLX_API_KEY env var");
  process.exit(1);
}
if (!SERVER_URL) {
  console.error("Missing SERVER_URL env var (Railway public URL)");
  process.exit(1);
}

// ----- Telegram bot setup (webhook, no polling) -----
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Webhook path is unique per bot
const WEBHOOK_PATH = `/webhook/${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = `${SERVER_URL}${WEBHOOK_PATH}`;

// Set webhook at startup
bot
  .setWebHook(WEBHOOK_URL)
  .then(() => console.log("Telegram webhook set:", WEBHOOK_URL))
  .catch((err) => {
    console.error("Failed to set Telegram webhook:", err);
    process.exit(1);
  });

// ----- Express app -----
const app = express();
app.use(express.json());

// Telegram will POST updates to this route
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Simple health check
app.get("/", (req, res) => {
  res.send("Telegram + Perplexity bot is running");
});

// ----- Bot behavior -----
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  // Basic /start
  if (text === "/start") {
    await bot.sendMessage(
      chatId,
      "Hi! Send me a question and I’ll ask Perplexity for an answer."
    );
    return;
  }

  // Ignore empty messages
  if (!text.trim()) {
    await bot.sendMessage(chatId, "Please send some text.");
    return;
  }

  // Call Perplexity API
  try {
    await bot.sendChatAction(chatId, "typing");

    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PPLX_API_KEY}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "You are a helpful Telegram assistant." },
          { role: "user", content: text },
        ],
      }),
    });

    if (!response.ok) {
      console.error("Perplexity API error:", await response.text());
      await bot.sendMessage(
        chatId,
        "Sorry, I had an issue talking to the AI. Try again later."
      );
      return;
    }

    const data = await response.json();
    const answer =
      data.choices?.[0]?.message?.content?.trim() ||
      "I couldn't generate a response.";

    await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error handling message:", err);
    await bot.sendMessage(
      chatId,
      "Sorry, something went wrong while processing your message."
    );
  }
});

// ----- Start server on Railway-assigned port -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Webhook URL:", WEBHOOK_URL);
});
