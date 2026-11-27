// Runs the intake eval cases through the real model, one conversation per case.
//
//   npm run eval:intake            uses OPENAI_API_KEY; skips cleanly without one
//   npm run eval:intake -- --rules runs the same cases on the rules fallback, no key needed
//
// Each case is a fictional tenant conversation. The checks are on what the app decides
// (category, urgency, access, photo count, completeness), not on the wording of replies.
// Replies are printed so a person can read them.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../../executions/env.mjs";
import { createInitialSession, processTenantMessage } from "../../executions/triage-engine.mjs";
import { loadTenantDirectory } from "../../executions/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
await loadEnv(path.join(root, ".env"));
// Photos only ever count as real attachments in these cases.
delete process.env.METRONEST_DEMO_TEXT_PHOTOS;

const rulesOnly = process.argv.includes("--rules");
if (!rulesOnly && !process.env.OPENAI_API_KEY?.trim()) {
  console.log("Skipped: OPENAI_API_KEY is not set. Run with --rules to check the cases against the rules fallback.");
  process.exit(0);
}
if (!rulesOnly && process.env.METRONEST_LLM_ENABLED === "false") {
  console.log("Skipped: METRONEST_LLM_ENABLED is false.");
  process.exit(0);
}

const cases = JSON.parse(await readFile(path.join(here, "cases.json"), "utf8"));
const tenants = await loadTenantDirectory(path.join(root, "resources", "tenant-directory.json"));
const tenantProfile = tenants.find((tenant) => tenant.demoDefault) || tenants[0];

function check(result, expect) {
  const { request, session } = result;
  const actual = {
    category: result.classification.category,
    urgency: result.classification.urgency,
    lastAskedField: session.lastAskedField,
    accessPermission: request.accessPermission,
    issueDescription: request.issueDescription,
    photoCount: request.photoCount,
    completeness: request.completeness,
    status: request.status,
    activeRiskSet: Boolean(request.activeRisk),
  };
  return Object.entries(expect)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key, value]) => `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
}

let failed = 0;
let run = 0;
for (const item of cases) {
  if (rulesOnly && item.modelOnly) continue;
  run += 1;
  let session = createInitialSession(`eval-${item.id}`);
  let result;
  const problems = [];
  console.log(`\n${item.id}: ${item.note}`);
  for (const message of item.messages) {
    result = await processTenantMessage(session, message, { source: "Telegram", tenantProfile, llm: rulesOnly ? false : undefined });
    session = result.session;
    console.log(`  tenant: ${message}`);
    console.log(`  reply (${session.replyMode}): ${result.reply}`);
    if (!rulesOnly && session.replyMode !== "llm") problems.push("the model was not used for every turn (check the fallback line above)");
  }
  problems.push(...check(result, item.expect));
  if (problems.length) {
    failed += 1;
    console.log(`  FAIL\n${problems.map((problem) => `    ${problem}`).join("\n")}`);
  } else {
    console.log("  pass");
  }
}

console.log(`\n${run - failed} of ${run} cases passed (${rulesOnly ? "rules fallback" : `model ${process.env.OPENAI_MODEL || "default"}`}).`);
process.exitCode = failed ? 1 : 0;
