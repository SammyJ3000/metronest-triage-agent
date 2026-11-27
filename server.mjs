import http from "node:http";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./executions/env.mjs";
import { llmStatus } from "./executions/llm-intake.mjs";
import {
  createInitialSession,
  processTenantMessage,
  getVendors,
  getTopVendorsForCategory,
  resetSession,
  mergeWorkOrder,
} from "./executions/triage-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(__dirname, ".env"));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = process.env.METRONEST_STORE_PATH || path.join(DATA_DIR, "maintenance-store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const TENANT_DIRECTORY_PATH = path.join(__dirname, "resources", "tenant-directory.json");

const defaultLandlordSettings = {
  autoAcceptUrgent: false,
  autoAcceptLimit: 650,
  reviewRoutineQuotes: true,
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function ensureStore() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(STORE_PATH)) {
    await writeStore({
      sessions: {},
      requests: [],
      landlordSettings: defaultLandlordSettings,
      activity: [
        {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          type: "system",
          text: "Demo workspace initialized.",
        },
      ],
    });
  }
}

async function readStore() {
  await ensureStore();
  const store = JSON.parse(await readFile(STORE_PATH, "utf8"));
  store.landlordSettings = { ...defaultLandlordSettings, ...(store.landlordSettings || {}) };
  return store;
}

async function writeStore(store) {
  const temporary = `${STORE_PATH}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`);
  await rename(temporary, STORE_PATH);
}

async function parseJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function loadTenantDirectory() {
  if (!existsSync(TENANT_DIRECTORY_PATH)) return [];
  return JSON.parse(await readFile(TENANT_DIRECTORY_PATH, "utf8"));
}

async function getDefaultTenantProfile() {
  const tenants = await loadTenantDirectory();
  return tenants.find((tenant) => tenant.demoDefault) || tenants[0] || null;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function notFound(res) {
  sendError(res, 404, "Not found");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : ["/dashboard", "/dashboard/"].includes(url.pathname) ? "/dashboard.html" : url.pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) || !existsSync(filePath) || !(await stat(filePath)).isFile()) {
    notFound(res);
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": contentTypes[ext] || "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
}

function summarizeRequests(requests) {
  const active = requests.filter((request) => request.status !== "Resolved");
  const open = active.length;
  const urgent = active.filter((request) => ["Emergency", "High"].includes(request.urgency)).length;
  const ready = active.filter((request) => ["Needs manager review", "Ready for approval", "Awaiting landlord quote review", "Quote ready for landlord"].includes(request.status)).length;
  const pending = active.filter((request) => request.completeness !== "Ready").length;
  return { open, urgent, ready, pending, total: requests.length };
}

async function handleChat(req, res) {
  const payload = await parseJson(req);
  const message = String(payload.message || "").trim();
  const sessionId = String(payload.sessionId || "demo-tenant");

  if (!message) {
    sendError(res, 400, "Message is required");
    return;
  }

  const store = await readStore();
  const session = store.sessions[sessionId] || createInitialSession(sessionId);
  const result = await processTenantMessage(session, message, {
    tenantProfile: await getDefaultTenantProfile(),
  });

  store.sessions[sessionId] = result.session;

  if (result.request) {
    const existingIndex = store.requests.findIndex((request) => request.id === result.request.id);
    if (existingIndex >= 0) {
      store.requests[existingIndex] = mergeWorkOrder(store.requests[existingIndex], result.request);
    } else {
      store.requests.unshift(result.request);
    }

    store.activity.unshift({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: "request",
      text: `${result.request.urgency} ${result.request.category.toLowerCase()} work order created for ${result.request.address || "unknown address"}.`,
    });
  }

  await writeStore(store);
  sendJson(res, 200, result);
}

async function handleRequests(req, res) {
  const store = await readStore();
  sendJson(res, 200, {
    requests: store.requests,
    summary: summarizeRequests(store.requests),
    landlordSettings: store.landlordSettings,
    activity: store.activity.slice(0, 12),
  });
}

async function handleSettingsPatch(req, res) {
  const payload = await parseJson(req);
  if (!Number.isFinite(Number(payload.autoAcceptLimit)) || Number(payload.autoAcceptLimit) < 100) {
    return sendError(res, 400, "Quote limit must be at least £100.");
  }
  const store = await readStore();
  store.landlordSettings = {
    ...store.landlordSettings,
    autoAcceptUrgent: Boolean(payload.autoAcceptUrgent),
    autoAcceptLimit: Number(payload.autoAcceptLimit || store.landlordSettings.autoAcceptLimit),
    reviewRoutineQuotes: payload.reviewRoutineQuotes !== false,
  };
  await writeStore(store);
  sendJson(res, 200, { landlordSettings: store.landlordSettings });
}

async function handleRequestPatch(req, res, requestId) {
  const payload = await parseJson(req);
  const store = await readStore();
  const request = store.requests.find((item) => item.id === requestId);
  if (!request) {
    notFound(res);
    return;
  }

  if (payload.status) request.status = String(payload.status);
  if (payload.vendorId) {
    const vendor = getVendors().find((item) => item.id === payload.vendorId);
    if (vendor) request.vendor = vendor;
  }
  request.updatedAt = new Date().toISOString();

  store.activity.unshift({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "status",
    text: `${request.reference} moved to ${request.status}.`,
  });

  await writeStore(store);
  sendJson(res, 200, { request });
}

function buildContractorMessage(request, vendor) {
  return `WhatsApp to ${vendor.name}: Maintenance request ${request.reference}: ${request.urgency} ${request.category.toLowerCase()} issue at ${request.address || "address pending"}. Tenant notes: ${request.issueDescription || "No detail provided"}. Active risk: ${request.activeRisk || "Not confirmed"}. Photos: ${request.photoStatus || "Not provided"}. Access: ${request.accessPermission || "Confirm with tenant"}. Please reply with accept/decline, ETA, and quote.`;
}

async function handleDispatchContractors(req, res, requestId) {
  const store = await readStore();
  const request = store.requests.find((item) => item.id === requestId);
  if (!request) {
    notFound(res);
    return;
  }

  const urgent = ["Emergency", "High"].includes(request.urgency);
  if (request.confirmedContractor || request.status === "Resolved") {
    return sendError(res, 409, "This job is already confirmed or resolved.");
  }
  if (request.completeness !== "Ready") {
    return sendError(res, 409, "Collect the tenant's details, photos and access approval before preparing outreach.");
  }
  if (request.contractorDispatches?.length) return sendJson(res, 200, { request });
  const vendors = getTopVendorsForCategory(request.category, 3);

  if (!urgent && store.landlordSettings.reviewRoutineQuotes) {
    request.status = "Awaiting landlord quote review";
  } else {
    request.status = "Contractors contacted";
  }

  const existingVendorIds = new Set((request.contractorDispatches || []).map((dispatch) => dispatch.vendor.id));
  const newDispatches = vendors
    .filter((vendor) => !existingVendorIds.has(vendor.id))
    .map((vendor) => ({
      id: randomUUID(),
      vendor,
      channel: "WhatsApp",
      status: urgent || !store.landlordSettings.reviewRoutineQuotes ? "Contacted" : "Prepared",
      quoteAmount: null,
      eta: "",
      contractorNote: "",
      message: buildContractorMessage(request, vendor),
      contactedAt: urgent || !store.landlordSettings.reviewRoutineQuotes ? new Date().toISOString() : null,
      respondedAt: null,
    }));

  request.contractorDispatches = [...(request.contractorDispatches || []), ...newDispatches];
  request.updatedAt = new Date().toISOString();

  store.activity.unshift({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "dispatch",
    text: urgent
      ? `${request.reference}: simulated WhatsApp contact to top ${newDispatches.length} ${request.category.toLowerCase()} contractors.`
      : `${request.reference}: prepared ${newDispatches.length} WhatsApp contractor quote requests for landlord review.`,
  });

  await writeStore(store);
  sendJson(res, 200, { request });
}

async function handleContractorResponse(req, res, requestId) {
  const payload = await parseJson(req);
  const store = await readStore();
  const request = store.requests.find((item) => item.id === requestId);
  const dispatch = request?.contractorDispatches?.find((item) => item.id === payload.dispatchId);

  if (!request || !dispatch) {
    notFound(res);
    return;
  }

  if (request.confirmedContractor || request.status === "Resolved" || !["Contacted", "Prepared", "Accepted"].includes(dispatch.status)) {
    return sendError(res, 409, "This contractor request is already closed.");
  }
  if (!["accept", "decline"].includes(payload.outcome)) {
    return sendError(res, 400, "Choose accept or decline.");
  }
  if (payload.outcome === "accept" && (!Number.isFinite(Number(payload.quoteAmount)) || Number(payload.quoteAmount) <= 0)) {
    return sendError(res, 400, "An accepted quote must have a positive amount.");
  }
  const accepted = payload.outcome === "accept";
  dispatch.status = accepted ? "Accepted" : "Declined";
  dispatch.quoteAmount = accepted ? Number(payload.quoteAmount || 0) : null;
  dispatch.eta = accepted ? String(payload.eta || "Awaiting ETA") : "";
  dispatch.contractorNote = String(payload.contractorNote || "");
  dispatch.respondedAt = new Date().toISOString();

  const urgent = ["Emergency", "High"].includes(request.urgency);
  const canAutoAccept =
    accepted &&
    urgent &&
    store.landlordSettings.autoAcceptUrgent &&
    dispatch.quoteAmount > 0 &&
    dispatch.quoteAmount <= store.landlordSettings.autoAcceptLimit;

  if (canAutoAccept) {
    confirmDispatch(request, dispatch, "Auto-confirmed");
  } else if (accepted) {
    request.status = "Quote ready for landlord";
  } else if ((request.contractorDispatches || []).every((item) => item.status === "Declined")) {
    request.status = "No contractor accepted";
  }

  request.updatedAt = new Date().toISOString();
  store.activity.unshift({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "contractor",
    text: `${dispatch.vendor.name} ${accepted ? `accepted ${request.reference} at £${dispatch.quoteAmount}` : `declined ${request.reference}`}.`,
  });

  await writeStore(store);
  sendJson(res, 200, { request });
}

async function handleConfirmContractor(req, res, requestId) {
  const payload = await parseJson(req);
  const store = await readStore();
  const request = store.requests.find((item) => item.id === requestId);
  const dispatch = request?.contractorDispatches?.find((item) => item.id === payload.dispatchId);

  if (!request || !dispatch) {
    notFound(res);
    return;
  }

  if (request.confirmedContractor || request.status === "Resolved") {
    return sendError(res, 409, "This job is already confirmed or resolved.");
  }
  if (dispatch.status !== "Accepted" || !(dispatch.quoteAmount > 0)) {
    return sendError(res, 409, "The contractor must accept and provide a quote before confirmation.");
  }
  confirmDispatch(request, dispatch, "Landlord confirmed");
  request.updatedAt = new Date().toISOString();

  store.activity.unshift({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "confirm",
    text: `${request.reference}: ${dispatch.vendor.name} confirmed and other contractor requests closed.`,
  });

  await writeStore(store);
  sendJson(res, 200, { request });
}

function confirmDispatch(request, dispatch, confirmationMode) {
  request.confirmedContractor = {
    dispatchId: dispatch.id,
    vendor: dispatch.vendor,
    quoteAmount: dispatch.quoteAmount,
    eta: dispatch.eta,
    confirmationMode,
    confirmedAt: new Date().toISOString(),
  };
  request.status = "Contractor confirmed";
  request.contractorDispatches = (request.contractorDispatches || []).map((item) => {
    if (item.id === dispatch.id) return { ...item, status: "Confirmed" };
    if (["Contacted", "Prepared", "Accepted"].includes(item.status)) return { ...item, status: "Unsuccessful" };
    return item;
  });
}

async function handleReset(req, res) {
  const store = await readStore();
  store.sessions["demo-tenant"] = resetSession("demo-tenant");
  store.activity.unshift({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "system",
    text: "Tenant chat simulator reset.",
  });
  await writeStore(store);
  sendJson(res, 200, { session: store.sessions["demo-tenant"] });
}

async function handleResetDemo(req, res) {
  const store = {
    sessions: {},
    requests: [],
    landlordSettings: defaultLandlordSettings,
    activity: [
      {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: "system",
        text: "Demo data cleared.",
      },
    ],
  };
  await writeStore(store);
  sendJson(res, 200, { ok: true });
}

async function handleTelegramWebhook(req, res) {
  const update = await parseJson(req);
  const message = update?.message?.text || update?.message?.caption || "";
  const chatId = update?.message?.chat?.id;
  const photoCount = update?.message?.photo?.length ? 1 : 0;

  if ((!message && !photoCount) || !chatId) {
    sendJson(res, 200, { ok: true, ignored: true });
    return;
  }

  if (message.trim().startsWith("/start")) {
    sendJson(res, 200, {
      method: "sendMessage",
      chat_id: chatId,
      text: "Hi, you are through to MetroNest maintenance. Tell me what has happened and I will get the right details over to the property manager.",
    });
    return;
  }

  const store = await readStore();
  const sessionId = `telegram-${chatId}`;
  const session = store.sessions[sessionId] || createInitialSession(sessionId);
  const tenantProfile = await getDefaultTenantProfile();
  const result = await processTenantMessage(session, message, {
    tenantName: tenantProfile?.name || update.message.from?.first_name,
    tenantProfile,
    source: "Telegram",
    photoCount,
  });

  store.sessions[sessionId] = result.session;
  if (result.request) {
    const existingIndex = store.requests.findIndex((request) => request.id === result.request.id);
    if (existingIndex >= 0) store.requests[existingIndex] = mergeWorkOrder(store.requests[existingIndex], result.request);
    else store.requests.unshift(result.request);
  }
  await writeStore(store);

  sendJson(res, 200, {
    method: "sendMessage",
    chat_id: chatId,
    text: result.reply,
  });
}

async function router(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: true, service: "metronest", llm: llmStatus() });
    if (req.method === "POST" && url.pathname === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && url.pathname === "/api/reset-chat") return await handleReset(req, res);
    if (req.method === "POST" && url.pathname === "/api/reset-demo") return await handleResetDemo(req, res);
    if (req.method === "GET" && url.pathname === "/api/requests") return await handleRequests(req, res);
    if (req.method === "PATCH" && url.pathname === "/api/settings") return await handleSettingsPatch(req, res);
    if (req.method === "GET" && url.pathname === "/api/vendors") return sendJson(res, 200, { vendors: getVendors() });
    if (req.method === "POST" && url.pathname === "/api/telegram/webhook") return await handleTelegramWebhook(req, res);

    const requestMatch = url.pathname.match(/^\/api\/requests\/([^/]+)$/);
    if (requestMatch && req.method === "PATCH") return await handleRequestPatch(req, res, requestMatch[1]);

    const dispatchMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/dispatch$/);
    if (dispatchMatch && req.method === "POST") return await handleDispatchContractors(req, res, dispatchMatch[1]);

    const responseMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/contractor-response$/);
    if (responseMatch && req.method === "POST") return await handleContractorResponse(req, res, responseMatch[1]);

    const confirmMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/confirm-contractor$/);
    if (confirmMatch && req.method === "POST") return await handleConfirmContractor(req, res, confirmMatch[1]);

    if (req.method === "GET") return await serveStatic(req, res);
    notFound(res);
  } catch (error) {
    console.error(error);
    sendError(res, error instanceof SyntaxError ? 400 : 500, error instanceof SyntaxError ? "Invalid JSON request." : "Couldn't complete the request. Please try again.");
  }
}

await ensureStore();
// Serialize dashboard mutations so simultaneous approvals cannot overwrite each other.
let mutationQueue = Promise.resolve();
const server = http.createServer((req, res) => {
  if (["POST", "PATCH", "DELETE"].includes(req.method)) {
    mutationQueue = mutationQueue.then(() => router(req, res));
  } else {
    router(req, res);
  }
});

function listen(port, attempts = 0) {
  const onError = (error) => {
    server.removeListener("listening", onListening);
    if (error.code === "EADDRINUSE" && attempts < 20) {
      listen(port + 1, attempts + 1);
      return;
    }
    throw error;
  };
  const onListening = () => {
    server.removeListener("error", onError);
    console.log(`MetroNest Maintenance Agent running at http://${HOST}:${server.address().port}`);
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, HOST);
}

listen(PORT);
