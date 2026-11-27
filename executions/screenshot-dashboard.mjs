import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const baseUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:4174";
const outputPath = process.argv[2] || "tmp/dashboard-screenshot.png";
const pagePath = process.env.SCREENSHOT_PATH || "/dashboard.html";
const [viewportWidth, viewportHeight] = (process.env.SCREENSHOT_VIEWPORT || "1440x1020")
  .split("x")
  .map((value) => Number(value));
const shouldSeed = process.env.SCREENSHOT_SEED !== "false";

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function seedDashboard() {
  await api("/api/reset-demo", { method: "POST" });

  await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      sessionId: "screenshot-tenant",
      message: "The kitchen sink is leaking and water is getting into the cabinet.",
    }),
  });
  await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      sessionId: "screenshot-tenant",
      message: "Yes, it is actively dripping right now.",
    }),
  });
  await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      sessionId: "screenshot-tenant",
      message: "Please use my saved access notes for this repair.",
    }),
  });
  await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      sessionId: "screenshot-tenant",
      message: "I have sent 3 photos of the leak, the cabinet and the wider kitchen.",
    }),
  });

  const data = await api("/api/requests");
  const request = data.requests[0];
  if (!request) return;

  await api(`/api/requests/${request.id}/dispatch`, { method: "POST" });
  const dispatched = await api("/api/requests");
  const updated = dispatched.requests.find((item) => item.id === request.id);
  const firstDispatch = updated?.contractorDispatches?.[0];
  if (firstDispatch) {
    await api(`/api/requests/${request.id}/contractor-response`, {
      method: "POST",
      body: JSON.stringify({
        dispatchId: firstDispatch.id,
        outcome: "accept",
        quoteAmount: 520,
        eta: "Today, 3:30pm",
        contractorNote: "Available and can attend within the quoted window.",
      }),
    });
  }
}

await mkdir("tmp", { recursive: true });
if (shouldSeed) await seedDashboard();

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: viewportWidth || 1440, height: viewportHeight || 1020 },
  deviceScaleFactor: 1,
});
await page.goto(`${baseUrl}${pagePath}`, { waitUntil: "networkidle" });
await page.screenshot({ path: outputPath, fullPage: false });
await browser.close();

console.log(outputPath);
