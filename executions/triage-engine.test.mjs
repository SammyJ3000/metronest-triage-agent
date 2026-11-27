import assert from "node:assert/strict";
import { createInitialSession, getTopVendorsForCategory, processTenantMessage } from "./triage-engine.mjs";

// This suite exercises the offline fallback; it must never spend API credits.
delete process.env.OPENAI_API_KEY;

let session = createInitialSession("test");
let result = await processTenantMessage(session, "Hi, my name is Jamie Example. The kitchen sink is leaking badly and water is getting into the cabinet.");
session = result.session;
assert.equal(result.classification.category, "Plumbing");
assert.equal(result.classification.urgency, "High");

result = await processTenantMessage(session, "Flat 2, 14 Example Street");
session = result.session;
result = await processTenantMessage(session, "Yes it is actively dripping right now");
session = result.session;
result = await processTenantMessage(session, "The plumber can enter, I will be home after 2pm");
session = result.session;
result = await processTenantMessage(session, "", { photoCount: 1, source: "Telegram" });
session = result.session;
result = await processTenantMessage(session, "", { photoCount: 1, source: "Telegram" });
session = result.session;
result = await processTenantMessage(session, "", { photoCount: 1, source: "Telegram" });

assert.equal(result.request.completeness, "Ready");
assert.equal(result.request.vendor.name, "RapidPipe Plumbing");
assert.equal(result.request.dispatchPlan.mode, "Auto-contact recommended");
assert.equal(result.request.roughPrice.label, "£260-£700");
assert.equal(result.request.photoCount, 3);
assert.match(result.request.drafts.vendor, /Flat 2/i);

const plumbers = getTopVendorsForCategory("Plumbing", 3);
assert.deepEqual(plumbers.map((vendor) => vendor.name), [
  "RapidPipe Plumbing",
  "Northline Plumbing Co.",
  "Apex Drainage & Leak Detection",
]);

let profileSession = createInitialSession("profile-test");
let profileResult = await processTenantMessage(profileSession, "The bathroom tap is leaking badly", {
  tenantProfile: {
    id: "jamie-example",
    name: "Jamie Example",
    address: "Flat 2, 14 Example Street, Demo Town",
    accessNotes: "Usually home after 2pm on weekdays. Contractor should message before arrival.",
  },
});
profileSession = profileResult.session;
profileResult = await processTenantMessage(profileSession, "Yes, it is leaking right now", {
  tenantProfile: {
    id: "jamie-example",
    name: "Jamie Example",
    address: "Flat 2, 14 Example Street, Demo Town",
    accessNotes: "Usually home after 2pm on weekdays. Contractor should message before arrival.",
  },
});

assert.equal(profileResult.request.accessPermission, "");
assert.ok(profileResult.missingFields.includes("accessPermission"));
assert.match(profileResult.reply, /Can you confirm whether we should use those/i);

profileResult = await processTenantMessage(profileResult.session, "Yeah just make sure the contractor messages me before", {
  tenantProfile: {
    id: "jamie-example",
    name: "Jamie Example",
    address: "Flat 2, 14 Example Street, Demo Town",
    accessNotes: "Usually home after 2pm on weekdays. Contractor should message before arrival.",
  },
});

assert.equal(profileResult.request.accessPermission, "Yeah just make sure the contractor messages me before");
assert.ok(!profileResult.missingFields.includes("accessPermission"));
assert.ok(profileResult.missingFields.includes("photos"));
assert.match(profileResult.reply, /send 3 photos/i);

const recoveredSession = createInitialSession("recovery-test");
recoveredSession.tenantProfile = {
  id: "jamie-example",
  name: "Jamie Example",
  address: "Flat 2, 14 Example Street, Demo Town",
  accessNotes: "Usually home after 2pm on weekdays. Contractor should message before arrival.",
};
recoveredSession.fields = {
  ...recoveredSession.fields,
  tenantName: "Jamie Example",
  address: "Flat 2, 14 Example Street, Demo Town",
  issueDescription: "Hey I have an issue in the house Some water is dripping under the sink",
  activeRisk: "Active risk reported",
  savedAccessNotes: "Usually home after 2pm on weekdays. Contractor should message before arrival.",
};
recoveredSession.messages = [
  {
    id: "one",
    role: "tenant",
    text: "Some water is dripping under the sink",
    timestamp: new Date().toISOString(),
  },
  {
    id: "two",
    role: "bot",
    text: "Can you confirm whether we should use those for this repair?",
    timestamp: new Date().toISOString(),
  },
  {
    id: "three",
    role: "tenant",
    text: "Yeah just make sure the contractor messages me before",
    timestamp: new Date().toISOString(),
  },
  {
    id: "four",
    role: "bot",
    text: "Can you confirm whether we should use those for this repair?",
    timestamp: new Date().toISOString(),
  },
];

const recoveredResult = await processTenantMessage(recoveredSession, "What", {
  tenantProfile: recoveredSession.tenantProfile,
  source: "Telegram",
});

assert.equal(recoveredResult.request.accessPermission, "Yeah just make sure the contractor messages me before");
assert.ok(!recoveredResult.missingFields.includes("accessPermission"));
assert.match(recoveredResult.reply, /send 3 photos/i);

const demoProfile = {
  name: "Jamie Example",
  address: "Flat 2, 14 Example Street",
  accessNotes: "Usually home after 2pm. Message before arrival.",
};
const telegramOptions = { source: "Telegram", tenantProfile: demoProfile };
let loop = await processTenantMessage(createInitialSession("power-loop"), "i have an issue", telegramOptions);
assert.equal(loop.request.issueDescription, "");
assert.equal(loop.session.lastAskedField, "issueDescription");
loop = await processTenantMessage(loop.session, "the pwoer is out", telegramOptions);
assert.equal(loop.classification.category, "Electrical");
assert.equal(loop.classification.urgency, "High");
assert.equal(loop.session.lastAskedField, "activeRisk");
loop = await processTenantMessage(loop.session, "no", telegramOptions);
assert.match(loop.request.activeRisk, /no active immediate danger/);
assert.equal(loop.request.accessPermission, "");
assert.equal(loop.session.lastAskedField, "accessPermission");
loop = await processTenantMessage(loop.session, "yeah just message me before", telegramOptions);
assert.equal(loop.session.lastAskedField, "photos");
assert.equal(loop.request.accessPermission, "yeah just message me before");
loop = await processTenantMessage(loop.session, "I will send 3 photos", telegramOptions);
assert.equal(loop.request.photoCount, 0);
assert.notEqual(loop.request.completeness, "Ready");
for (let index = 0; index < 3; index += 1) {
  loop = await processTenantMessage(loop.session, "", { ...telegramOptions, photoCount: 1 });
}
assert.equal(loop.request.completeness, "Ready");
assert.equal(loop.request.photoCount, 3);
const acknowledgement = await processTenantMessage(loop.session, "thanks", telegramOptions);
assert.notEqual(acknowledgement.reply, loop.reply);

let shortReply = await processTenantMessage(createInitialSession("short-replies"), "the power is out", telegramOptions);
shortReply = await processTenantMessage(shortReply.session, "yes", telegramOptions);
assert.match(shortReply.request.activeRisk, /Active risk reported/);
assert.equal(shortReply.request.accessPermission, "", "Yes to risk must not approve saved access");
shortReply = await processTenantMessage(shortReply.session, "why do you need access?", telegramOptions);
assert.equal(shortReply.request.accessPermission, "");
shortReply = await processTenantMessage(shortReply.session, "I don't understand", telegramOptions);
assert.equal(shortReply.request.status, "Needs manager review");
assert.ok(shortReply.request.conversation.length);
assert.match(shortReply.reply, /property manager to review/);

let cannotTakePhotos = await processTenantMessage(loop.session, "thank you", telegramOptions);
cannotTakePhotos.session.fields.photoCount = 0;
cannotTakePhotos.session.fields.photos = [];
cannotTakePhotos.session.lastAskedField = "photos";
cannotTakePhotos = await processTenantMessage(cannotTakePhotos.session, "I can't take photos", telegramOptions);
assert.equal(cannotTakePhotos.request.photoCount, 0);
assert.equal(cannotTakePhotos.request.status, "Needs manager review");

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

// A natural new-report opener must start with the issue, even in an old chat.
const oldReport = structuredClone(loop.session);
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
let vague = await processTenantMessage(createInitialSession("issue-first"), "I have an issue", telegramOptions);
vague = await processTenantMessage(vague.session, "it's an electrical problem", telegramOptions);
assert.equal(vague.session.lastAskedField, "issueDescription");
assert.equal(vague.request.issueDescription, "");
assert.doesNotMatch(vague.reply, /saved|access|home/i);
vague = await processTenantMessage(vague.session, "the power is out in the kitchen", telegramOptions);
assert.equal(vague.classification.category, "Electrical");
assert.equal(vague.session.lastAskedField, "activeRisk");
const unknownTenant = await processTenantMessage(createInitialSession("unknown-tenant"), "I have an issue", { llm: false });
assert.equal(unknownTenant.session.lastAskedField, "issueDescription");
assert.match(unknownTenant.reply, /What's the problem/);

console.log("triage-engine tests passed");
