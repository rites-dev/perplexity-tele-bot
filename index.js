// index.js

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

// ----- Environment variables -----
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PPLX_API_KEY = process.env.PPLX_API_KEY;
const SERVER_URL = process.env.SERVER_URL; // e.g. https://your-app.up.railway.app

// Directory for persistent files (Railway Volume mounted at /data)
const DATA_DIR = process.env.DATA_DIR || "/data";

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}
if (!PPLX_API_KEY) {
  console.error("Missing PPLX_API_KEY env var");
  process.exit(1);
}
if (!SERVER_URL) {
  console.error("Missing SERVER_URL env var (your Railway public URL)");
  process.exit(1);
}

// Ensure data directory exists (best-effort)
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  console.log("DATA_DIR ready at:", DATA_DIR);
} catch (err) {
  console.error("Failed to prepare DATA_DIR:", err);
}

// Log vars (without exposing secrets)
console.log("TELEGRAM_BOT_TOKEN present?", !!TELEGRAM_BOT_TOKEN);
console.log("PPLX_API_KEY present?", !!PPLX_API_KEY);
console.log("SERVER_URL:", SERVER_URL);

// ----- Express app -----
const app = express();
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Simple save route to test file writes:
// POST /save { "filename": "test.json", "data": { "foo": "bar" } }
app.post("/save", (req, res) => {
  const { filename, data } = req.body || {};
  if (!filename || !data) {
    return res.status(400).json({ error: "filename and data are required" });
  }

  const filePath = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    console.log("Saved file:", filePath);
    return res.status(200).json({ ok: true, path: filePath });
  } catch (err) {
    console.error("Error writing file:", err);
    return res.status(500).json({ error: "failed to write file" });
  }
});

// Webhook config
const WEBHOOK_PATH = `/webhook/${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = `${SERVER_URL}${WEBHOOK_PATH}`;

console.log("Webhook will be set to:", WEBHOOK_URL);

// Root check
app.get("/", (req, res) => {
  res.send("Telegram + Perplexity bot is running");
});

// Telegram sends updates here
app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    const update = req.body;

    console.log("Incoming Telegram update:", JSON.stringify(update));

    if (!update.message || !update.message.text) {
      return res.sendStatus(200);
    }

    const chatId = update.message.chat.id;
    const text = update.message.text.trim();

    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "Hi! Send me a question and I'll ask Perplexity for you."
      );
      return res.sendStatus(200);
    }

    if (!text) {
      await sendTelegramMessage(chatId, "Please send some text.");
      return res.sendStatus(200);
    }

    await sendChatAction(chatId, "typing");

    const answer = await askPerplexity(text);
    await sendTelegramMessage(chatId, answer);

    // Example: log each question to a file in /data
    try {
      const logFile = path.join(DATA_DIR, "messages.log");
      const line = `[${new Date().toISOString()}] chat:${chatId} text:${JSON.stringify(
        text
      )}\n`;
      fs.appendFileSync(logFile, line, "utf8");
    } catch (err) {
      console.error("Failed to append to log file:", err);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error in webhook handler:", err);
    res.sendStatus(500);
  }
});

// ----- Telegram helper functions -----

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error("sendMessage error:", data);
  }
}

async function sendChatAction(chatId, action) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`;
  const body = {
    chat_id: chatId,
    action,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error("sendChatAction error:", data);
  }
}

// ----- Perplexity helper -----

async function askPerplexity(prompt) {
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PPLX_API_KEY}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "You are a helpful Telegram assistant." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Perplexity API error:", res.status, text);
      return "Sorry, I had an issue talking to the AI. Try again later.";
    }

    const data = await res.json();
    const answer =
      data.choices?.[0]?.message?.content?.trim() ||
      "I couldn't generate a response.";
    return answer;
  } catch (err) {
    console.error("Error calling Perplexity:", err);
    return "Sorry, something went wrong while contacting the AI.";
  }
}

// ----- Webhook setup (non-blocking) -----

async function ensureWebhook() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: WEBHOOK_URL }),
    });
    const data = await res.json();
    console.log("setWebhook response:", data);
  } catch (err) {
    console.error("Failed to set Telegram webhook:", err);
  }
}

// ----- Start server -----

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Webhook URL:", WEBHOOK_URL);
  console.log("Data directory:", DATA_DIR);
  ensureWebhook();
});
