import { createInitialSession, processTenantMessage } from "./triage-engine.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.mjs";
import { llmStatus } from "./llm-intake.mjs";
import { createStore, loadTenantDirectory, logActivity, upsertRequest } from "./store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STORE_PATH = path.join(ROOT, "data", "maintenance-store.json");
const TENANT_DIRECTORY_PATH = path.join(ROOT, "resources", "tenant-directory.json");
const POLL_TIMEOUT_SECONDS = 25;
const TYPING_REFRESH_MS = 4000;
const RETRY_DELAY_MS = 3000;

await loadEnv(path.join(ROOT, ".env"));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MIN_REPLY_DELAY_MS = Number(process.env.TELEGRAM_MIN_REPLY_DELAY_MS || 1400);
const MAX_REPLY_DELAY_MS = Number(process.env.TELEGRAM_MAX_REPLY_DELAY_MS || 3200);

if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Add it to your shell or .env before running npm run telegram.");
  process.exit(1);
}

const { read: readStore, write: writeStore } = createStore(STORE_PATH, () => ({ sessions: {}, requests: [], activity: [] }));

async function findTenantProfile(chatId) {
  const tenants = await loadTenantDirectory(TENANT_DIRECTORY_PATH);
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
      timeout: POLL_TIMEOUT_SECONDS,
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
      // The typing indicator is cosmetic: a failed refresh must not interrupt the reply.
      const typing = setInterval(() => {
        telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      }, TYPING_REFRESH_MS);
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
      if (result.request) upsertRequest(latest, result.request);
      logActivity(latest, "telegram", `Telegram intake updated for chat ${chatId}.`);
      await writeStore(latest);

      await sendHumanReply(chatId, result.reply);
    }
  } catch (error) {
    console.error(error.message);
    await sleep(RETRY_DELAY_MS);
  }
}
