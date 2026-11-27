import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialSession, processTenantMessage } from "./triage-engine.mjs";

// Starts its own server on a free port with a temporary store, so demo data is never touched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let directory;
let child;
let base;
let request;

async function call(url, method = "GET", payload) {
  const response = await fetch(`${base}${url}`, {
    method, headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, data: await response.json() };
}

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "metronest-test-"));
  const storePath = path.join(directory, "store.json");
  const result = await processTenantMessage(createInitialSession("regression"), "My sink is leaking badly. Water is actively dripping now. The contractor can enter after 2pm.", {
    tenantProfile: { name: "Test Tenant", address: "Flat 2, 14 Example Street" },
    photoCount: 3,
    llm: false,
  });
  assert.equal(result.request.completeness, "Ready");
  request = result.request;
  await writeFile(storePath, JSON.stringify({
    sessions: {}, requests: [request], activity: [],
    landlordSettings: { autoAcceptUrgent: false, autoAcceptLimit: 650, reviewRoutineQuotes: true },
  }));
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: "0", METRONEST_STORE_PATH: storePath, METRONEST_LLM_ENABLED: "false", METRONEST_DEMO_TEXT_PHOTOS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.on("error", reject);
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("health check and dashboard are served", async () => {
  assert.equal((await call("/api/health")).data.service, "metronest");
  assert.match((await fetch(`${base}/dashboard`)).headers.get("content-type"), /text\/html/);
});

test("a quote limit below £100 is refused", async () => {
  assert.equal((await call("/api/settings", "PATCH", { autoAcceptLimit: -1 })).status, 400);
});

test("only one of two simultaneous contractor confirmations succeeds", async () => {
  const route = `/api/requests/${request.id}`;
  const outreach = await call(`${route}/dispatch`, "POST");
  assert.equal(outreach.data.request.contractorDispatches.length, 3);
  const [first, second] = outreach.data.request.contractorDispatches;
  assert.equal((await call(`${route}/confirm-contractor`, "POST", { dispatchId: first.id })).status, 409);
  assert.equal((await call(`${route}/contractor-response`, "POST", { dispatchId: first.id, outcome: "accept", quoteAmount: -3 })).status, 400);
  await call(`${route}/contractor-response`, "POST", { dispatchId: first.id, outcome: "accept", quoteAmount: 520, eta: "Today" });
  await call(`${route}/contractor-response`, "POST", { dispatchId: second.id, outcome: "accept", quoteAmount: 610, eta: "Today" });

  const confirmations = await Promise.all([
    call(`${route}/confirm-contractor`, "POST", { dispatchId: first.id }),
    call(`${route}/confirm-contractor`, "POST", { dispatchId: second.id }),
  ]);
  assert.deepEqual(confirmations.map((item) => item.status).sort(), [200, 409]);
  const current = (await call("/api/requests")).data.requests[0];
  assert.equal(current.contractorDispatches.filter((item) => item.status === "Confirmed").length, 1);
  assert.equal(current.contractorDispatches.filter((item) => item.status === "Unsuccessful").length, 2);
  assert.equal((await call(`${route}/dispatch`, "POST")).status, 409);
});

test("resolved jobs are not counted as open, urgent or ready", async () => {
  await call(`/api/requests/${request.id}`, "PATCH", { status: "Resolved" });
  const summary = (await call("/api/requests")).data.summary;
  assert.equal(summary.open, 0);
  assert.equal(summary.urgent, 0);
  assert.equal(summary.ready, 0);
});

test("a web chat report stops at the photo step when photos are only mentioned", async () => {
  let reply;
  for (const message of [
    "The kitchen sink is leaking and water is getting into the cabinet.",
    "Yes, it is actively dripping right now.",
    "Please use my saved access notes for this repair.",
    "I have sent 3 photos of the leak, the cabinet and the wider kitchen.",
  ]) {
    reply = await call("/api/chat", "POST", { sessionId: "web-photos", message });
    assert.equal(reply.status, 200);
  }
  assert.equal(reply.data.request.source, "Web chat");
  assert.equal(reply.data.request.photoCount, 0);
  assert.deepEqual(reply.data.missingFields, ["photos"]);
  assert.equal((await call(`/api/requests/${reply.data.request.id}/dispatch`, "POST")).status, 409);
});
