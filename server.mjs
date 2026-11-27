import http from "node:http";
import { stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./executions/env.mjs";
import { llmStatus } from "./executions/llm-intake.mjs";
import { activityEntry, createStore, loadTenantDirectory, logActivity, upsertRequest } from "./executions/store.mjs";
import {
  createInitialSession,
  processTenantMessage,
  getVendors,
  getTopVendorsForCategory,
  resetSession,
} from "./executions/triage-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(__dirname, ".env"));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const STORE_PATH = process.env.METRONEST_STORE_PATH || path.join(__dirname, "data", "maintenance-store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const TENANT_DIRECTORY_PATH = path.join(__dirname, "resources", "tenant-directory.json");
// If the port is taken, try the next ones up to this many times.
const PORT_ATTEMPTS = 20;
const ACTIVITY_SHOWN = 12;
const URGENT_LEVELS = ["Emergency", "High"];
const OPEN_DISPATCH_STATUSES = ["Contacted", "Prepared", "Accepted"];
// Largest JSON request body the API accepts. Real requests are a few hundred bytes.
const MAX_BODY_BYTES = 1024 * 1024;

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

function emptyStore(firstActivity) {
  return {
    sessions: {},
    requests: [],
    landlordSettings: defaultLandlordSettings,
    activity: [activityEntry("system", firstActivity)],
  };
}

const storeFile = createStore(STORE_PATH, () => emptyStore("Demo workspace initialized."));
const writeStore = storeFile.write;

async function readStore() {
  const data = await storeFile.read();
  data.landlordSettings = { ...defaultLandlordSettings, ...(data.landlordSettings || {}) };
  return data;
}

const isUrgent = (request) => URGENT_LEVELS.includes(request.urgency);

class BodyTooLargeError extends Error {}

// Reads the request body up to MAX_BODY_BYTES. Anything bigger is refused with 413;
// the rest of the upload is drained and discarded so the response can still be sent.
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
      req.resume();
      reject(new BodyTooLargeError());
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseJson(req) {
  const body = await readBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function getDefaultTenantProfile() {
  const tenants = await loadTenantDirectory(TENANT_DIRECTORY_PATH);
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
  const urgent = active.filter(isUrgent).length;
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
    upsertRequest(store, result.request);
    logActivity(store, "request", `${result.request.urgency} ${result.request.category.toLowerCase()} work order created for ${result.request.address || "unknown address"}.`);
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
    activity: store.activity.slice(0, ACTIVITY_SHOWN),
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
  logActivity(store, "status", `${request.reference} moved to ${request.status}.`);

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

  const urgent = isUrgent(request);
  if (request.confirmedContractor || request.status === "Resolved") {
    return sendError(res, 409, "This job is already confirmed or resolved.");
  }
  if (request.completeness !== "Ready") {
    return sendError(res, 409, "Collect the tenant's details, photos and access approval before preparing outreach.");
  }
  // Outreach is prepared once per job; a second call returns what is already there.
  if (request.contractorDispatches?.length) return sendJson(res, 200, { request });
  const vendors = getTopVendorsForCategory(request.category, 3);
  const contactNow = urgent || !store.landlordSettings.reviewRoutineQuotes;
  request.status = contactNow ? "Contractors contacted" : "Awaiting landlord quote review";

  request.contractorDispatches = vendors.map((vendor) => ({
    id: randomUUID(),
    vendor,
    channel: "WhatsApp",
    status: contactNow ? "Contacted" : "Prepared",
    quoteAmount: null,
    eta: "",
    contractorNote: "",
    message: buildContractorMessage(request, vendor),
    contactedAt: contactNow ? new Date().toISOString() : null,
    respondedAt: null,
  }));
  request.updatedAt = new Date().toISOString();

  const count = request.contractorDispatches.length;
  logActivity(store, "dispatch", urgent
    ? `${request.reference}: simulated WhatsApp contact to top ${count} ${request.category.toLowerCase()} contractors.`
    : `${request.reference}: prepared ${count} WhatsApp contractor quote requests for landlord review.`);

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

  if (request.confirmedContractor || request.status === "Resolved" || !OPEN_DISPATCH_STATUSES.includes(dispatch.status)) {
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

  const canAutoAccept =
    accepted &&
    isUrgent(request) &&
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
  logActivity(store, "contractor", `${dispatch.vendor.name} ${accepted ? `accepted ${request.reference} at £${dispatch.quoteAmount}` : `declined ${request.reference}`}.`);

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
  logActivity(store, "confirm", `${request.reference}: ${dispatch.vendor.name} confirmed and other contractor requests closed.`);

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
    if (OPEN_DISPATCH_STATUSES.includes(item.status)) return { ...item, status: "Unsuccessful" };
    return item;
  });
}

async function handleReset(req, res) {
  const store = await readStore();
  store.sessions["demo-tenant"] = resetSession("demo-tenant");
  logActivity(store, "system", "Tenant chat simulator reset.");
  await writeStore(store);
  sendJson(res, 200, { session: store.sessions["demo-tenant"] });
}

async function handleResetDemo(req, res) {
  await writeStore(emptyStore("Demo data cleared."));
  sendJson(res, 200, { ok: true });
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
    if (error instanceof BodyTooLargeError) return sendError(res, 413, "Request body is too large.");
    console.error(error);
    sendError(res, error instanceof SyntaxError ? 400 : 500, error instanceof SyntaxError ? "Invalid JSON request." : "Couldn't complete the request. Please try again.");
  }
}

await storeFile.ensure();
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
    if (error.code === "EADDRINUSE" && attempts < PORT_ATTEMPTS) {
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
