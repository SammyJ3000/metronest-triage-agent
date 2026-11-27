import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialSession, getTopVendorsForCategory, processTenantMessage } from "./triage-engine.mjs";

// This suite exercises the offline rules; it must never spend API credits.
delete process.env.OPENAI_API_KEY;
delete process.env.METRONEST_DEMO_TEXT_PHOTOS;

const jamieProfile = {
  id: "jamie-example",
  name: "Jamie Example",
  address: "Flat 2, 14 Example Street, Demo Town",
  accessNotes: "Usually home after 2pm on weekdays. Contractor should message before arrival.",
};
const demoProfile = {
  name: "Jamie Example",
  address: "Flat 2, 14 Example Street",
  accessNotes: "Usually home after 2pm. Message before arrival.",
};
const telegramOptions = { source: "Telegram", tenantProfile: demoProfile };

// Walks the power cut conversation that used to loop, through to a complete report.
async function completePowerCutReport() {
  const steps = [];
  let turn = await processTenantMessage(createInitialSession("power-loop"), "i have an issue", telegramOptions);
  steps.push(turn);
  for (const message of ["the pwoer is out", "no", "yeah just message me before", "I will send 3 photos"]) {
    turn = await processTenantMessage(turn.session, message, telegramOptions);
    steps.push(turn);
  }
  for (let index = 0; index < 3; index += 1) {
    turn = await processTenantMessage(turn.session, "", { ...telegramOptions, photoCount: 1 });
  }
  return { steps, final: turn };
}

test("a leaking sink reported in steps becomes a ready plumbing work order", async () => {
  let result = await processTenantMessage(createInitialSession("test"), "Hi, my name is Jamie Example. The kitchen sink is leaking badly and water is getting into the cabinet.");
  assert.equal(result.classification.category, "Plumbing");
  assert.equal(result.classification.urgency, "High");

  for (const message of ["Flat 2, 14 Example Street", "Yes it is actively dripping right now", "The plumber can enter, I will be home after 2pm"]) {
    result = await processTenantMessage(result.session, message);
  }
  for (let index = 0; index < 3; index += 1) {
    result = await processTenantMessage(result.session, "", { photoCount: 1, source: "Telegram" });
  }

  assert.equal(result.request.completeness, "Ready");
  assert.equal(result.request.vendor.name, "RapidPipe Plumbing");
  assert.equal(result.request.dispatchPlan.mode, "Auto-contact recommended");
  assert.equal(result.request.roughPrice.label, "£260-£700");
  assert.equal(result.request.photoCount, 3);
  assert.match(result.request.drafts.vendor, /Flat 2/i);
});

test("top plumbers are returned in rank order", () => {
  assert.deepEqual(getTopVendorsForCategory("Plumbing", 3).map((vendor) => vendor.name), [
    "RapidPipe Plumbing",
    "Northline Plumbing Co.",
    "Apex Drainage & Leak Detection",
  ]);
});

test("saved access notes are offered but never treated as approval", async () => {
  let result = await processTenantMessage(createInitialSession("profile-test"), "The bathroom tap is leaking badly", { tenantProfile: jamieProfile });
  result = await processTenantMessage(result.session, "Yes, it is leaking right now", { tenantProfile: jamieProfile });

  assert.equal(result.request.accessPermission, "");
  assert.ok(result.missingFields.includes("accessPermission"));
  assert.match(result.reply, /Can you confirm whether we should use those/i);

  result = await processTenantMessage(result.session, "Yeah just make sure the contractor messages me before", { tenantProfile: jamieProfile });
  assert.equal(result.request.accessPermission, "Yeah just make sure the contractor messages me before");
  assert.ok(!result.missingFields.includes("accessPermission"));
  assert.ok(result.missingFields.includes("photos"));
  assert.match(result.reply, /send 3 photos/i);
});

test("an access answer earlier in the chat is recovered from history", async () => {
  const session = createInitialSession("recovery-test");
  session.tenantProfile = jamieProfile;
  session.fields = {
    ...session.fields,
    tenantName: "Jamie Example",
    address: "Flat 2, 14 Example Street, Demo Town",
    issueDescription: "Hey I have an issue in the house Some water is dripping under the sink",
    activeRisk: "Active risk reported",
    savedAccessNotes: jamieProfile.accessNotes,
  };
  const now = new Date().toISOString();
  session.messages = [
    { id: "one", role: "tenant", text: "Some water is dripping under the sink", timestamp: now },
    { id: "two", role: "bot", text: "Can you confirm whether we should use those for this repair?", timestamp: now },
    { id: "three", role: "tenant", text: "Yeah just make sure the contractor messages me before", timestamp: now },
    { id: "four", role: "bot", text: "Can you confirm whether we should use those for this repair?", timestamp: now },
  ];

  const result = await processTenantMessage(session, "What", { tenantProfile: jamieProfile, source: "Telegram" });
  assert.equal(result.request.accessPermission, "Yeah just make sure the contractor messages me before");
  assert.ok(!result.missingFields.includes("accessPermission"));
  assert.match(result.reply, /send 3 photos/i);
});

test("the power cut chat moves forward instead of repeating a question", async () => {
  const { steps, final } = await completePowerCutReport();
  const [opener, issue, risk, access, promise] = steps;

  assert.equal(opener.request.issueDescription, "");
  assert.equal(opener.session.lastAskedField, "issueDescription");
  assert.equal(issue.classification.category, "Electrical");
  assert.equal(issue.classification.urgency, "High");
  assert.equal(issue.session.lastAskedField, "activeRisk");
  assert.match(risk.request.activeRisk, /no active immediate danger/);
  assert.equal(risk.request.accessPermission, "");
  assert.equal(risk.session.lastAskedField, "accessPermission");
  assert.equal(access.session.lastAskedField, "photos");
  assert.equal(access.request.accessPermission, "yeah just message me before");
  assert.equal(promise.request.photoCount, 0);
  assert.notEqual(promise.request.completeness, "Ready");
  assert.equal(final.request.completeness, "Ready");
  assert.equal(final.request.photoCount, 3);

  const acknowledgement = await processTenantMessage(final.session, "thanks", telegramOptions);
  assert.notEqual(acknowledgement.reply, final.reply);
});

test("a yes to the risk question does not approve access, and confusion goes to a person", async () => {
  let result = await processTenantMessage(createInitialSession("short-replies"), "the power is out", telegramOptions);
  result = await processTenantMessage(result.session, "yes", telegramOptions);
  assert.match(result.request.activeRisk, /Active risk reported/);
  assert.equal(result.request.accessPermission, "", "Yes to risk must not approve saved access");
  result = await processTenantMessage(result.session, "why do you need access?", telegramOptions);
  assert.equal(result.request.accessPermission, "");
  result = await processTenantMessage(result.session, "I don't understand", telegramOptions);
  assert.equal(result.request.status, "Needs manager review");
  assert.ok(result.request.conversation.length);
  assert.match(result.reply, /property manager to review/);
});

test("a tenant who cannot take photos is flagged for manager review", async () => {
  const { final } = await completePowerCutReport();
  let result = await processTenantMessage(final.session, "thank you", telegramOptions);
  result.session.fields.photoCount = 0;
  result.session.fields.photos = [];
  result.session.lastAskedField = "photos";
  result = await processTenantMessage(result.session, "I can't take photos", telegramOptions);
  assert.equal(result.request.photoCount, 0);
  assert.equal(result.request.status, "Needs manager review");
});

test("an old chat saved before the parser fix is replayed and unblocked", async () => {
  const legacy = createInitialSession("legacy-power-loop");
  legacy.fields.issueDescription = "i have an issue";
  legacy.messages = [
    { role: "tenant", text: "i have an issue" },
    { role: "bot", text: "Is there anything active happening right now?" },
    { role: "tenant", text: "the pwoer is out" },
    { role: "bot", text: "Is there anything active happening right now?" },
    { role: "tenant", text: "no" },
    { role: "bot", text: "Is there anything active happening right now?" },
  ];
  const repaired = await processTenantMessage(legacy, "hello?", telegramOptions);
  assert.equal(repaired.classification.category, "Electrical");
  assert.match(repaired.request.activeRisk, /no active immediate danger/);
  assert.equal(repaired.session.lastAskedField, "accessPermission");
  assert.equal(repaired.request.accessPermission, "");
  assert.doesNotMatch(repaired.request.issueDescription, /i have an issue/);
});

test("a new report opener starts fresh and leaves the old report unchanged", async () => {
  const { final } = await completePowerCutReport();
  const oldReport = structuredClone(final.session);
  const oldSnapshot = JSON.stringify(oldReport);
  for (const opener of ["I have an issue", "hi, i have a problem", "I have another issue", "start again"]) {
    const fresh = await processTenantMessage(oldReport, opener, telegramOptions);
    assert.notEqual(fresh.session.requestId, oldReport.requestId);
    assert.equal(fresh.request.issueDescription, "");
    assert.equal(fresh.request.activeRisk, "");
    assert.equal(fresh.request.accessPermission, "");
    assert.equal(fresh.request.photoCount, 0);
    assert.equal(fresh.session.lastAskedField, "issueDescription");
    assert.match(fresh.reply, /What's the problem/);
    assert.doesNotMatch(fresh.reply, /saved|access|home|photos/i);
    assert.equal(fresh.request.tenantName, "Jamie Example");
  }
  assert.equal(JSON.stringify(oldReport), oldSnapshot, "Previous report must remain unchanged");

  const continued = await processTenantMessage(oldReport, "It is still the same problem", telegramOptions);
  assert.equal(continued.session.requestId, oldReport.requestId);
});

test("a category alone is not accepted as the issue description", async () => {
  let result = await processTenantMessage(createInitialSession("issue-first"), "I have an issue", telegramOptions);
  result = await processTenantMessage(result.session, "it's an electrical problem", telegramOptions);
  assert.equal(result.session.lastAskedField, "issueDescription");
  assert.equal(result.request.issueDescription, "");
  assert.doesNotMatch(result.reply, /saved|access|home/i);
  result = await processTenantMessage(result.session, "the power is out in the kitchen", telegramOptions);
  assert.equal(result.classification.category, "Electrical");
  assert.equal(result.session.lastAskedField, "activeRisk");
});

test("an unknown tenant is asked for the issue first", async () => {
  const result = await processTenantMessage(createInitialSession("unknown-tenant"), "I have an issue", { llm: false });
  assert.equal(result.session.lastAskedField, "issueDescription");
  assert.match(result.reply, /What's the problem/);
});

// Web chat has no attachments, so a report sent there should stop at the photo step.
async function webChatAtPhotoStep() {
  let result = await processTenantMessage(createInitialSession("web-photos"), "The kitchen sink is leaking and water is getting into the cabinet.", { tenantProfile: jamieProfile });
  for (const message of ["Yes, it is actively dripping right now.", "Please use my saved access notes for this repair."]) {
    result = await processTenantMessage(result.session, message, { tenantProfile: jamieProfile });
  }
  assert.equal(result.session.lastAskedField, "photos");
  return result.session;
}

test("web chat does not count photos the tenant only mentions in text", async () => {
  const result = await processTenantMessage(await webChatAtPhotoStep(), "I have sent 3 photos of the leak, the cabinet and the wider kitchen.", { tenantProfile: jamieProfile });
  assert.equal(result.request.photoCount, 0);
  assert.equal(result.request.completeness, "Needs info");
  assert.deepEqual(result.missingFields, ["photos"]);
});

test("the demo text photo shortcut counts them only when switched on, and never for Telegram", async (t) => {
  process.env.METRONEST_DEMO_TEXT_PHOTOS = "1";
  t.after(() => { delete process.env.METRONEST_DEMO_TEXT_PHOTOS; });

  const web = await processTenantMessage(await webChatAtPhotoStep(), "I have sent 3 photos of the leak, the cabinet and the wider kitchen.", { tenantProfile: jamieProfile });
  assert.equal(web.request.photoCount, 3);
  assert.equal(web.request.photoStatus, "3 photos noted");
  assert.equal(web.request.completeness, "Ready");

  const telegram = await processTenantMessage(await webChatAtPhotoStep(), "I have sent 3 photos", { tenantProfile: jamieProfile, source: "Telegram" });
  assert.equal(telegram.request.photoCount, 0);
});
