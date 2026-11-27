import { readFileSync } from "node:fs";

const fieldNames = ["tenantName", "address", "issueDescription", "activeRisk"];
const questionFields = [...fieldNames, "accessPermission", "photos", "none"];
const accessActions = ["unchanged", "confirm_saved", "arrange", "allow", "deny", "clear"];
const nullableText = { type: ["string", "null"] };
const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    fields: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(fieldNames.map((field) => [field, nullableText])),
      required: fieldNames,
    },
    access: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: accessActions },
        evidence: nullableText,
      },
      required: ["action", "evidence"],
    },
    nextQuestion: { type: "string", enum: questionFields },
    reply: { type: "string" },
    needsHumanReview: { type: "boolean" },
  },
  required: ["fields", "access", "nextQuestion", "reply", "needsHumanReview"],
};

// The system prompt lives in prompts/intake.md so it can be read and edited as plain text.
const instructions = readFileSync(new URL("../prompts/intake.md", import.meta.url), "utf8").trimEnd();

const DEFAULT_MODEL = "gpt-4.1-mini";
const TIMEOUT_MS = 15000;
const MAX_OUTPUT_TOKENS = 1400;
const MAX_FIELD_CHARS = 4000;
const MAX_REPLY_CHARS = 1200;

let lastCall = { status: "not_used", checkedAt: null };

export function llmStatus() {
  return {
    configured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    enabled: process.env.METRONEST_LLM_ENABLED !== "false",
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    ...lastCall,
  };
}

export async function interpretIntake(context, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey?.trim() || process.env.METRONEST_LLM_ENABLED === "false") return null;
  try {
    const response = await (options.fetchImpl || fetch)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs || TIMEOUT_MS),
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        store: false,
        instructions,
        input: JSON.stringify(context),
        max_output_tokens: MAX_OUTPUT_TOKENS,
        text: { format: { type: "json_schema", name: "maintenance_intake", strict: true, schema } },
      }),
    });
    if (!response.ok) {
      // Status only: provider payloads may contain private request information.
      throw new Error(`HTTP_${response.status}`);
    }
    const result = await response.json();
    if (result.status !== "completed") throw new Error("INCOMPLETE_RESPONSE");
    const text = result.output?.flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text").map((item) => item.text).join("");
    const parsed = JSON.parse(text || "{}");
    validateInterpretation(parsed);
    lastCall = { status: "connected", checkedAt: new Date().toISOString() };
    return parsed;
  } catch (error) {
    const code = /^(HTTP_\d+|INCOMPLETE_RESPONSE|INVALID_OUTPUT)$/.test(error.message)
      ? error.message : "CONNECTION_OR_RESPONSE_ERROR";
    lastCall = { status: "fallback", checkedAt: new Date().toISOString(), error: code };
    console.warn(`LLM intake fallback: ${code}`);
    return null;
  }
}

function validateInterpretation(value) {
  const validText = (text) => text === null || (typeof text === "string" && text.length <= MAX_FIELD_CHARS);
  if (!value || !value.fields || fieldNames.some((field) => !validText(value.fields[field]))
      || !accessActions.includes(value.access?.action) || !validText(value.access?.evidence)
      || !questionFields.includes(value.nextQuestion)
      || typeof value.reply !== "string" || !value.reply.trim() || value.reply.length > MAX_REPLY_CHARS
      || typeof value.needsHumanReview !== "boolean") {
    throw new Error("INVALID_OUTPUT");
  }
}

export function applyInterpretation(fields, interpretation, message, previousQuestion) {
  for (const field of fieldNames) {
    const value = interpretation.fields[field]?.trim();
    if (value) fields[field] = value;
  }
  const { action, evidence } = interpretation.access;
  if (action === "unchanged" || !evidence?.trim() || !message.includes(evidence.trim())) return false;
  const shortAnswer = /^(yes|yeah|yep|ok|okay|sure|fine|no|nope|sounds good|go ahead|that's fine)[.! ,]*$/i.test(evidence.trim());
  if (shortAnswer && previousQuestion !== "accessPermission") return false;
  if (/^(why|what|how|when|who|where)\b/i.test(evidence.trim())) return false;
  if (action === "confirm_saved") {
    if (!fields.savedAccessNotes || previousQuestion !== "accessPermission") return false;
    fields.accessPermission = `Tenant approved saved access notes for this repair: ${fields.savedAccessNotes}`;
  } else if (action === "clear") {
    fields.accessPermission = "";
  } else {
    const label = { arrange: "Arrange a time with tenant", allow: "Tenant access instruction", deny: "No entry permission" }[action];
    fields.accessPermission = `${label}: ${evidence.trim()}`;
  }
  return true;
}
