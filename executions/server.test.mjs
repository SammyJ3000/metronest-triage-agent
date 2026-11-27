import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialSession, processTenantMessage } from "./triage-engine.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(tmpdir(), "metronest-test-"));
const storePath = path.join(directory, "store.json");
let child;
try {
  const result = await processTenantMessage(createInitialSession("regression"), "My sink is leaking badly. Water is actively dripping now. The contractor can enter after 2pm.", {
    tenantProfile: { name: "Test Tenant", address: "Flat 2, 14 Example Street" },
    photoCount: 3,
    llm: false,
  });
  assert.equal(result.request.completeness, "Ready");
  await writeFile(storePath, JSON.stringify({
    sessions: {}, requests: [result.request], activity: [],
    landlordSettings: { autoAcceptUrgent: false, autoAcceptLimit: 650, reviewRoutineQuotes: true },
  }));
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: root, env: { ...process.env, PORT: "0", METRONEST_STORE_PATH: storePath, METRONEST_LLM_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.on("error", reject);
  });
  const call = async (url, method = "GET", payload) => {
    const response = await fetch(`${base}${url}`, {
      method, headers: { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await call("/api/health")).data.service, "metronest");
  assert.match((await fetch(`${base}/dashboard`)).headers.get("content-type"), /text\/html/);
  assert.equal((await call("/api/settings", "PATCH", { autoAcceptLimit: -1 })).status, 400);
  const route = `/api/requests/${result.request.id}`;
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
  await call(route, "PATCH", { status: "Resolved" });
  const summary = (await call("/api/requests")).data.summary;
  assert.equal(summary.open, 0);
  assert.equal(summary.urgent, 0);
  assert.equal(summary.ready, 0);
  console.log("Server regression tests passed (isolated store).");
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
