import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretIntake, applyInterpretation } from "./llm-intake.mjs";
import { createInitialSession, processTenantMessage, mergeWorkOrder } from "./triage-engine.mjs";

// Every call here uses a mocked fetch or a mocked interpreter: no key, no network, no credits.
const parsed = {
  fields: { tenantName: null, address: null, issueDescription: "The electrical supply is off throughout the flat.", activeRisk: null },
  access: { action: "unchanged", evidence: null },
  nextQuestion: "activeRisk",
  reply: "Sorry about the power, Jamie. Is there any active danger at the moment?",
  needsHumanReview: false,
};
const profile = { name: "Jamie Example", address: "Flat 2, 14 Example Street", accessNotes: "Usually home after 2pm" };
const options = { source: "Telegram", tenantProfile: profile, interpretIntake: async () => parsed };

const firstTurn = () => processTenantMessage(createInitialSession("llm-test"), "everything's gone off", options);

test("the request uses store: false and a strict JSON schema", async () => {
  let requestBody;
  const mockFetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(parsed) }] }],
    }));
  };
  const result = await interpretIntake({ latestMessage: "everything's gone off", photosReceived: 0 }, { apiKey: "test-only", fetchImpl: mockFetch });
  assert.deepEqual(result, parsed);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(requestBody.text.format.schema.additionalProperties, false);
});

test("provider errors, incomplete or empty output and timeouts fall back to rules", async () => {
  for (const fetchImpl of [
    async () => new Response("unauthorised", { status: 401 }),
    async () => new Response(JSON.stringify({ status: "incomplete", output: [] })),
    async () => new Response(JSON.stringify({ status: "completed", output: [] })),
    async () => { throw new Error("timeout"); },
  ]) {
    assert.equal(await interpretIntake({}, { apiKey: "test-only", fetchImpl }), null);
  }
});

test("no API key means no call is made", async () => {
  let called = false;
  assert.equal(await interpretIntake({}, { apiKey: "", fetchImpl: async () => { called = true; } }), null);
  assert.equal(called, false);
});

test("a model turn fills fields and sets the next question", async () => {
  const turn = await firstTurn();
  assert.equal(turn.session.replyMode, "llm");
  assert.equal(turn.classification.category, "Electrical");
  assert.equal(turn.reply, parsed.reply);
  assert.equal(turn.session.lastAskedField, "activeRisk");
  assert.equal(turn.request.accessPermission, "");
  assert.equal(turn.request.photoCount, 0);
});

test("access changes need evidence from the latest message and the right question", () => {
  const fields = { savedAccessNotes: profile.accessNotes, accessPermission: "", photoCount: 0 };
  const affirmative = { ...parsed, fields: {}, access: { action: "confirm_saved", evidence: "yes" } };
  assert.equal(applyInterpretation(fields, affirmative, "yes", "activeRisk"), false);
  assert.equal(fields.accessPermission, "");
  assert.equal(applyInterpretation(fields, affirmative, "yes", "accessPermission"), true);
  assert.match(fields.accessPermission, /Tenant approved saved access/);
  assert.equal(applyInterpretation(fields, { ...affirmative, access: { action: "allow", evidence: "You can enter" } }, "what?", "accessPermission"), false);
  applyInterpretation(fields, { ...affirmative, access: { action: "deny", evidence: "Don't enter without me" } }, "Don't enter without me", "accessPermission");
  assert.match(fields.accessPermission, /No entry permission/);
  applyInterpretation(fields, { ...affirmative, access: { action: "clear", evidence: "Cancel my permission" } }, "Cancel my permission", "photos");
  assert.equal(fields.accessPermission, "");
});

test("the model cannot claim photos, invent access or declare the report complete", async () => {
  const turn = await firstTurn();
  const fakeCompletion = await processTenantMessage(turn.session, "I sent three photos", {
    ...options,
    interpretIntake: async () => ({
      ...parsed,
      fields: { tenantName: null, address: null, issueDescription: null, activeRisk: "No immediate danger reported", photoCount: 3 },
      access: { action: "allow", evidence: "You may enter" },
      nextQuestion: "none",
      reply: "All done, the contractor is booked.",
    }),
  });
  assert.equal(fakeCompletion.request.photoCount, 0);
  assert.equal(fakeCompletion.request.accessPermission, "");
  assert.notEqual(fakeCompletion.request.completeness, "Ready");
  assert.notEqual(fakeCompletion.reply, "All done, the contractor is booked.");
});

test("a request for a person hands the chat to the manager", async () => {
  const turn = await firstTurn();
  const handoff = await processTenantMessage(turn.session, "Can I speak to a person?", {
    ...options, interpretIntake: async () => ({ ...parsed, needsHumanReview: true, nextQuestion: "none" }),
  });
  assert.equal(handoff.request.status, "Needs manager review");
  assert.ok(handoff.request.conversation.length);
});

test("a later intake update keeps a confirmed contractor and its dispatches", () => {
  const existing = { id: "one", status: "Contractor confirmed", createdAt: "original", contractorDispatches: [{ id: "dispatch" }], confirmedContractor: { vendor: { name: "Approved vendor" } } };
  const merged = mergeWorkOrder(existing, { id: "one", status: "Ready for approval", createdAt: "new", summary: "Updated notes" });
  assert.equal(merged.status, "Contractor confirmed");
  assert.equal(merged.summary, "Updated notes");
  assert.deepEqual(merged.confirmedContractor, existing.confirmedContractor);
  assert.deepEqual(merged.contractorDispatches, existing.contractorDispatches);
});
