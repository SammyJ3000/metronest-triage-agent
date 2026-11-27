import {
  createInitialSession,
  processTenantMessage,
  mergeWorkOrder,
} from "./triage-engine.mjs";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.mjs";
import { llmStatus } from "./llm-intake.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const STORE_PATH = path.join(DATA_DIR, "maintenance-store.json");
const TENANT_DIRECTORY_PATH = path.join(ROOT, "resources", "tenant-directory.json");

await loadEnv(path.join(ROOT, ".env"));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MIN_REPLY_DELAY_MS = Number(process.env.TELEGRAM_MIN_REPLY_DELAY_MS || 1400);
const MAX_REPLY_DELAY_MS = Number(process.env.TELEGRAM_MAX_REPLY_DELAY_MS || 3200);

if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Add it to your shell or .env before running npm run telegram.");
  process.exit(1);
}

async function ensureStore() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(STORE_PATH)) {
    await writeStore({ sessions: {}, requests: [], activity: [] });
  }
}

async function readStore() {
  await ensureStore();
  return JSON.parse(await readFile(STORE_PATH, "utf8"));
}

async function writeStore(store) {
  const temporary = `${STORE_PATH}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`);
  await rename(temporary, STORE_PATH);
}

async function loadTenantDirectory() {
  if (!existsSync(TENANT_DIRECTORY_PATH)) return [];
  return JSON.parse(await readFile(TENANT_DIRECTORY_PATH, "utf8"));
}

async function findTenantProfile(chatId) {
  const tenants = await loadTenantDirectory();
  const chatIdText = String(chatId);
  return tenants.find((tenant) => (tenant.telegramChatIds || []).map(String).includes(chatIdText))
    || tenants.find((tenant) => tenant.demoDefault)
    || null;
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function sendHumanReply(chatId, text) {
  await telegram("sendChatAction", {
    chat_id: chatId,
    action: "typing",
  });
  await sleep(replyDelay(text));
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
  });
}

function replyDelay(text) {
  const readingTime = Math.min(1600, String(text).length * 18);
  const jitter = Math.floor(Math.random() * (MAX_REPLY_DELAY_MS - MIN_REPLY_DELAY_MS + 1));
  return MIN_REPLY_DELAY_MS + jitter + readingTime;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let offset = 0;
console.log("Telegram polling bot is running. Keep the dashboard open with npm run dev.");
console.log(`Conversation mode: ${llmStatus().configured && llmStatus().enabled ? "OpenAI" : "rules (OpenAI not configured)"}`);

while (true) {
  try {
    const updates = await telegram("getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message"],
    });

    for (const update of updates.result || []) {
      offset = update.update_id + 1;
      const text = update.message?.text || update.message?.caption || "";
      const chatId = update.message?.chat?.id;
      const photoCount = update.message?.photo?.length ? 1 : 0;
      if ((!text && !photoCount) || !chatId) continue;

      if (text.trim().startsWith("/start")) {
        const store = await readStore();
        store.sessions[`telegram-${chatId}`] = createInitialSession(`telegram-${chatId}`);
        await writeStore(store);
        const profile = await findTenantProfile(chatId);
        await sendHumanReply(
          chatId,
          `Hi${profile?.name ? ` ${profile.name.split(" ")[0]}` : ""}, you're through to MetroNest maintenance. What's happened? I'll get the details over to your property manager.`
        );
        continue;
      }

      const store = await readStore();
      const sessionId = `telegram-${chatId}`;
      const session = store.sessions[sessionId] || createInitialSession(sessionId);
      const tenantProfile = await findTenantProfile(chatId);
      await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
      const typing = setInterval(() => {
        telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      }, 4000);
      let result;
      try {
        result = await processTenantMessage(session, text, {
          tenantName: tenantProfile?.name || update.message.from?.first_name,
          tenantProfile,
          source: "Telegram",
          photoCount,
        });
      } finally {
        clearInterval(typing);
      }

      // Model requests may take seconds; merge into the latest dashboard state.
      const latest = await readStore();
      latest.sessions[sessionId] = result.session;
      if (result.request) {
        const existingIndex = latest.requests.findIndex((request) => request.id === result.request.id);
        if (existingIndex >= 0) latest.requests[existingIndex] = mergeWorkOrder(latest.requests[existingIndex], result.request);
        else latest.requests.unshift(result.request);
      }
      latest.activity.unshift({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: "telegram",
        text: `Telegram intake updated for chat ${chatId}.`,
      });
      await writeStore(latest);

      await sendHumanReply(chatId, result.reply);
    }
  } catch (error) {
    console.error(error.message);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
