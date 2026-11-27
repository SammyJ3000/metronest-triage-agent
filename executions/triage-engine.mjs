import { randomUUID } from "node:crypto";
import { interpretIntake, applyInterpretation } from "./llm-intake.mjs";

const VENDORS = [
  {
    id: "rapidpipe",
    name: "RapidPipe Plumbing",
    trade: "Plumbing",
    rank: 1,
    response: "Same-day emergency response",
    contact: "+44 7700 900101",
    email: "dispatch@rapidpipe.example",
    whatsapp: "+44 7700 900101",
    coverage: "Central Manchester",
    approvedUntil: "2026-12-31",
    compliance: "Gas Safe registered, public liability insured",
    calloutFee: 145,
  },
  {
    id: "northline-plumbing",
    name: "Northline Plumbing Co.",
    trade: "Plumbing",
    rank: 2,
    response: "Licensed residential repairs",
    contact: "+44 7700 900102",
    email: "jobs@northlineplumbing.example",
    whatsapp: "+44 7700 900102",
    coverage: "Manchester north and city centre",
    approvedUntil: "2026-10-15",
    compliance: "Public liability insured, approved leak response",
    calloutFee: 125,
  },
  {
    id: "apex-drainage",
    name: "Apex Drainage & Leak Detection",
    trade: "Plumbing",
    rank: 3,
    response: "Leak tracing and urgent drainage",
    contact: "+44 7700 900103",
    email: "dispatch@apexdrainage.example",
    whatsapp: "+44 7700 900103",
    coverage: "Greater Manchester",
    approvedUntil: "2026-11-20",
    compliance: "Drainage specialist, emergency cover approved",
    calloutFee: 165,
  },
  {
    id: "brightspark",
    name: "BrightSpark Electrical",
    trade: "Electrical",
    rank: 1,
    response: "Priority electrical faults",
    contact: "+44 7700 900201",
    email: "jobs@brightspark.example",
    whatsapp: "+44 7700 900201",
    coverage: "Central Manchester",
    approvedUntil: "2026-09-30",
    compliance: "NICEIC approved contractor, insured",
    calloutFee: 155,
  },
  {
    id: "volthouse",
    name: "VoltHouse Electrical",
    trade: "Electrical",
    rank: 2,
    response: "Residential safety faults",
    contact: "+44 7700 900202",
    email: "service@volthouse.example",
    whatsapp: "+44 7700 900202",
    coverage: "Manchester and Salford",
    approvedUntil: "2026-08-31",
    compliance: "NICEIC domestic installer, insured",
    calloutFee: 135,
  },
  {
    id: "safe-current",
    name: "Safe Current Contractors",
    trade: "Electrical",
    rank: 3,
    response: "After-hours electrical response",
    contact: "+44 7700 900203",
    email: "priority@safecurrent.example",
    whatsapp: "+44 7700 900203",
    coverage: "Greater Manchester",
    approvedUntil: "2026-12-01",
    compliance: "Emergency electrical response approved",
    calloutFee: 180,
  },
  {
    id: "coolair",
    name: "CoolAir HVAC",
    trade: "HVAC",
    rank: 1,
    response: "Heating and cooling repairs",
    contact: "+44 7700 900301",
    email: "service@coolair.example",
    whatsapp: "+44 7700 900301",
    coverage: "Manchester and Stockport",
    approvedUntil: "2026-07-31",
    compliance: "F-Gas certified, insured",
    calloutFee: 140,
  },
  {
    id: "safelock",
    name: "SafeLock Locksmiths",
    trade: "Locksmith",
    rank: 1,
    response: "Lockouts and entry issues",
    contact: "+44 7700 900401",
    email: "help@safelock.example",
    whatsapp: "+44 7700 900401",
    coverage: "Central Manchester",
    approvedUntil: "2026-12-31",
    compliance: "DBS checked locksmith, insured",
    calloutFee: 120,
  },
  {
    id: "allfix",
    name: "AllFix Handyman",
    trade: "General",
    rank: 1,
    response: "General maintenance",
    contact: "+44 7700 900501",
    email: "team@allfix.example",
    whatsapp: "+44 7700 900501",
    coverage: "Manchester and Salford",
    approvedUntil: "2026-10-01",
    compliance: "General maintenance approved supplier",
    calloutFee: 95,
  },
];

const REQUIRED_FIELDS = ["issueDescription", "tenantName", "address", "activeRisk", "accessPermission", "photos"];
const MIN_PHOTOS = 3;

const categoryRules = [
  ["Plumbing", ["sink", "tap", "toilet", "leak", "water", "pipe", "drain", "shower", "bath", "flood"]],
  ["Electrical", ["power", "electric", "light", "sparking", "switch", "outlet", "breaker", "smoke alarm"]],
  ["HVAC", ["aircon", "air conditioning", "heater", "heating", "cooling", "ac ", "vent"]],
  ["Locksmith", ["lock", "key", "door won", "locked", "garage remote"]],
  ["Appliance", ["oven", "dishwasher", "washing machine", "dryer", "fridge", "stove"]],
];

const riskWords = ["flood", "leaking", "leak", "water", "sparking", "smoke", "burning", "no power", "locked out", "burst", "overflow"];
const emergencyWords = ["flood", "burst", "sparking", "smoke", "fire", "locked out", "ceiling collapse", "sewage", "overflow"];
const highWords = ["leaking", "water damage", "no hot water", "no power", "power is out", "power cut", "power outage", "urgent", "asap", "worse"];

export function getVendors() {
  return VENDORS;
}

export function getTopVendorsForCategory(category, limit = 3) {
  const exact = VENDORS
    .filter((vendor) => vendor.trade === category)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);

  if (exact.length) return exact;
  return VENDORS
    .filter((vendor) => vendor.trade === "General")
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

export function createInitialSession(sessionId) {
  return {
    id: sessionId,
    requestId: randomUUID(),
    messages: [],
    fields: {
      tenantName: "",
      address: "",
      issueDescription: "",
      activeRisk: "",
      accessPermission: "",
      savedAccessNotes: "",
      photoStatus: "No photos provided",
      photoCount: 0,
      photos: [],
    },
    status: "Collecting details",
    source: "Web chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function resetSession(sessionId) {
  return createInitialSession(sessionId);
}

export function mergeWorkOrder(existing, incoming) {
  if (!existing) return incoming;
  const intakeStatuses = ["Waiting for tenant", "Ready for approval", "Needs manager review"];
  return {
    ...existing,
    ...incoming,
    createdAt: existing.createdAt,
    status: intakeStatuses.includes(existing.status) ? incoming.status : existing.status,
    contractorDispatches: existing.contractorDispatches || [],
    ...(existing.confirmedContractor ? { confirmedContractor: existing.confirmedContractor } : {}),
  };
}

export async function processTenantMessage(session, message, options = {}) {
  const normalized = message.trim();
  // A new-report opener must not inherit an old repair's risk, access or photos.
  if (session.fields.issueDescription && startsNewReport(normalized)) {
    const profile = session.tenantProfile;
    session = createInitialSession(session.id);
    session.tenantProfile = profile;
  }
  const next = structuredClone(session);
  applyTenantProfile(next, options.tenantProfile || next.tenantProfile);
  recoverConversationFields(next);
  const photoCount = Number(options.photoCount || 0);
  const messageText = normalized || (photoCount ? `[${photoCount} photo${photoCount === 1 ? "" : "s"} attached]` : "");

  next.messages.push({
    id: randomUUID(),
    role: "tenant",
    text: messageText,
    timestamp: new Date().toISOString(),
  });

  next.source = options.source || next.source || "Web chat";
  const expectedField = !next.fields.issueDescription ? "issueDescription"
    : next.lastAskedField || inferAskedField(session.messages.at(-1)?.text) || getMissingFields(next.fields)[0] || "";
  const trustedFields = structuredClone(next.fields);
  const previousFields = JSON.stringify(next.fields);
  mergeExtractedFields(next.fields, messageText, { ...options, photoCount, expectedField });
  recoverAccessPermissionFromHistory(next.fields, next.messages);
  const interpreter = options.interpretIntake || interpretIntake;
  const interpretation = options.llm === false ? null : await interpreter({
    latestMessage: normalized,
    previousQuestion: expectedField,
    fields: { ...trustedFields, photos: undefined, photoCount: next.fields.photoCount, photoStatus: next.fields.photoStatus },
    photosReceived: next.fields.photoCount,
    photosRequired: MIN_PHOTOS,
    conversation: next.messages.slice(-24).map(({ role, text }) => ({ role, text: text.slice(0, 4000) })),
  });
  if (interpretation) {
    // Keep attachment counts and workflow state outside the model's writable fields.
    next.fields = {
      ...trustedFields,
      photos: next.fields.photos,
      photoCount: next.fields.photoCount,
      photoStatus: next.fields.photoStatus,
    };
    applyInterpretation(next.fields, interpretation, normalized, expectedField);
  }
  if (isVagueIssue(next.fields.issueDescription)) next.fields.issueDescription = "";
  next.replyMode = interpretation ? "llm" : "rules";

  const classification = classifyIssue(interpretation ? next.fields.issueDescription : `${next.fields.issueDescription} ${normalized}`);
  const missingFields = getMissingFields(next.fields);
  const isReady = missingFields.length === 0;
  const stalled = session.messages.some((item) => item.role === "bot")
    && missingFields[0] === expectedField && !photoCount && JSON.stringify(next.fields) === previousFields;
  next.unansweredTurns = stalled ? Number(next.unansweredTurns || 0) + 1 : 0;
  const cannotProvide = /\b(can'?t|cannot|unable|not possible|don'?t have|won'?t)\b/i.test(normalized);
  next.needsHumanReview = Boolean(interpretation?.needsHumanReview)
    || (!isReady && (next.unansweredTurns >= 2 || (expectedField === "photos" && cannotProvide)));

  let reply;
  if (next.needsHumanReview) {
    next.status = "Needs manager review";
    reply = "Sorry, I'm not picking this up properly. I've flagged your messages for the property manager to review, so you don't need to keep answering the same question. No contractor has been booked.";
    if (session.needsHumanReview) reply = "I've added that to the notes for your property manager. They'll need to review this before a visit is arranged.";
  } else if (isReady) {
    next.status = "Ready for manager review";
    reply = session.status === "Ready for manager review"
      ? "Thanks, I've added that to your report. It's awaiting your property manager's review; no visit has been confirmed yet."
      : buildConfirmationReply(classification);
  } else {
    next.status = "Collecting details";
    reply = buildQuestionReply(next.fields, missingFields, classification);
    if (stalled && session.messages.length) reply = buildClarificationReply(missingFields[0], next.fields);
  }
  next.lastAskedField = isReady ? "" : missingFields[0];
  if (interpretation && !next.needsHumanReview && !isReady
      && (next.fields.issueDescription || interpretation.nextQuestion === "issueDescription")
      && missingFields.includes(interpretation.nextQuestion)) {
    const lastReply = session.messages.filter((item) => item.role === "bot").at(-1)?.text;
    if (interpretation.reply.trim() !== lastReply) {
      reply = interpretation.reply.trim();
      next.lastAskedField = interpretation.nextQuestion;
    }
  }

  next.messages.push({
    id: randomUUID(),
    role: "bot",
    text: reply,
    timestamp: new Date().toISOString(),
  });
  next.updatedAt = new Date().toISOString();

  const request = buildWorkOrder(next, classification, isReady);
  if (next.needsHumanReview) {
    request.status = "Needs manager review";
    request.recommendedAction = "Review the tenant's messages and follow up directly to collect the missing details.";
    request.conversation = next.messages.map(({ role, text }) => ({ role, text }));
  }
  return {
    session: next,
    reply,
    request,
    missingFields,
    classification,
  };
}

function applyTenantProfile(session, tenantProfile) {
  if (!tenantProfile) return;
  session.tenantProfile = {
    id: tenantProfile.id,
    name: tenantProfile.name,
    building: tenantProfile.building,
    unit: tenantProfile.unit,
    address: tenantProfile.address,
    landlord: tenantProfile.landlord,
    propertyManager: tenantProfile.propertyManager,
    accessNotes: tenantProfile.accessNotes,
  };
  if (!session.fields.tenantName) session.fields.tenantName = tenantProfile.name || "";
  if (!session.fields.address) session.fields.address = tenantProfile.address || "";
  if (!session.fields.savedAccessNotes) session.fields.savedAccessNotes = tenantProfile.accessNotes || "";
}

function normalizeIssueText(text) {
  return String(text).toLowerCase()
    .replace(/\bpwoer\b/g, "power")
    .replace(/\belectrcity\b|\belectricty\b/g, "electricity")
    .replace(/\belectricity\b/g, "electric power")
    .replace(/\bno electric power\b/g, "no power")
    .replace(/\b(?:lights?|power) (?:has gone|went|gone) out\b/g, "power is out");
}

function startsNewReport(text) {
  return /^(?:(?:hi|hello|hey)[,! ]+)?(?:i|we)(?: have| have got|'ve got| got) (?:an? |another )(?:new |different |maintenance )?(?:issue|problem|repair)(?:[.!? ]|$)/i.test(text)
    || /^(?:new (?:issue|problem|repair|report)|start (?:again|over)|report (?:a |another )?(?:new )?(?:issue|problem))[.!?: ]*$/i.test(text);
}

function isVagueIssue(text) {
  return /^(?:(?:it'?s|it is|i have|there'?s)\s+)?(?:(?:an?|the)\s+)?(?:electrical|plumbing|heating|maintenance|general)(?:\s+(?:issue|problem|fault))?[.!? ]*$/i.test(text.trim());
}

function isUsefulDescription(text) {
  const value = text.trim();
  return value.length >= 12
    && !isVagueIssue(value)
    && !/^(hi|hello|hey|thanks|thank you|yes|no|ok|okay|what|why|how)\b/i.test(value)
    && !/^(i |we )?(have|got|there'?s|there is).{0,16}(issue|problem)[.!? ]*$/i.test(value)
    && !/\b(photo|picture|image)\b/i.test(value)
    && !/^\[.*attached\]$/.test(value);
}

function inferAskedField(text = "") {
  if (/\b(saved access|permission to enter|access notes|arrange a time|use those for this repair)\b/i.test(text)) return "accessPermission";
  if (/\b(active happening|anything unsafe|active danger|smoke or sparks|anything dangerous)\b/i.test(text)) return "activeRisk";
  if (/\b(send|upload).{0,25}photos?\b/i.test(text)) return "photos";
  if (/\b(full name)\b/i.test(text)) return "tenantName";
  if (/\b(full property address)\b/i.test(text)) return "address";
  if (/\b(what has happened|what's happened|what is broken)\b/i.test(text)) return "issueDescription";
  return "";
}

// Replay old conversations once so a parser fix also unblocks an existing chat.
function recoverConversationFields(session) {
  if (session.extractionVersion === 2) return;
  if (!looksLikeIssue(session.fields.issueDescription) && !isUsefulDescription(session.fields.issueDescription)) {
    session.fields.issueDescription = "";
  }
  for (let index = 0; index < session.messages.length; index += 1) {
    const item = session.messages[index];
    if (item.role !== "tenant") continue;
    const expectedField = inferAskedField(session.messages[index - 1]?.text);
    const fields = { ...session.fields, issueDescription: "" };
    mergeExtractedFields(fields, item.text, { expectedField, source: session.source, replaying: true });
    if (fields.issueDescription && !session.fields.issueDescription.includes(fields.issueDescription)) {
      session.fields.issueDescription = [session.fields.issueDescription, fields.issueDescription].filter(Boolean).join(" ");
    }
    if (fields.activeRisk) session.fields.activeRisk = fields.activeRisk;
    if (fields.accessPermission) session.fields.accessPermission = fields.accessPermission;
  }
  session.extractionVersion = 2;
}

function buildClarificationReply(field, fields) {
  const questions = {
    tenantName: "What name should I put on the repair report?",
    address: "Which property is this for? Please include the flat number and street address.",
    issueDescription: "What is broken or not working, and where in the property is it?",
    activeRisk: "Is there any active danger at the moment? A simple yes, no, or not sure is fine.",
    accessPermission: "Should the contractor arrange a time with you first, or may they use your saved access notes? I won't assume permission.",
    photos: `I still need ${Math.max(0, MIN_PHOTOS - Number(fields.photoCount || 0))} actual photos attached here. If you can't take them, just say so and I'll flag that for your property manager.`,
  };
  return questions[field];
}

function mergeExtractedFields(fields, message, options) {
  if (options.tenantName && !fields.tenantName) fields.tenantName = options.tenantName;

  const lower = message.toLowerCase();
  const expectedField = options.expectedField || "";
  const address = extractAddress(message);
  if (address) fields.address = address;

  const name = extractName(message);
  if (name) fields.tenantName = name;

  if (looksLikeIssue(message) || (expectedField === "issueDescription" && isUsefulDescription(message))) {
    fields.issueDescription = fields.issueDescription
      ? `${fields.issueDescription} ${message}`.trim()
      : message;
  }

  if (expectedField === "accessPermission" && looksLikeAccessResponse(message, fields)) {
    fields.accessPermission = normalizeAccessPermission(message, fields);
  }

  if (expectedField === "activeRisk" && /\b(not sure|don'?t know|unsure)\b/i.test(message)) {
    fields.activeRisk = `Tenant is unsure; manager must assess risk: ${message.trim()}`;
  } else if (expectedField === "activeRisk" && /^(no|nope|nah|nothing|not really|all safe)\b/i.test(message)) {
    // "No power" describes the fault, not an answer denying active danger.
    if (!/\b(no power|no electricity)\b/i.test(normalizeIssueText(message))) {
      fields.activeRisk = `Tenant reports no active immediate danger: ${message.trim()}`;
    }
  } else if (expectedField === "activeRisk" && /^(yes|yeah|yep)\b/i.test(message)) {
    fields.activeRisk = `Active risk reported: ${message.trim()}`;
  }
  if (/\b(dripping|pouring|leaking|sparking|smoke|flooding|burst)\b/i.test(message)) {
    fields.activeRisk = /\b(no|not|stopped|earlier)\b|only when/i.test(message)
      ? `Tenant reports no active immediate danger: ${message.trim()}`
      : `Active risk reported: ${message.trim()}`;
  }
  if (looksLikeAccessResponse(message, expectedField === "accessPermission" ? fields : {})) {
    fields.accessPermission = normalizeAccessPermission(message, fields);
  }

  if (options.photoCount) {
    for (let index = 0; index < options.photoCount; index += 1) {
      fields.photos.push({
        id: randomUUID(),
        source: options.source || "Chat",
        receivedAt: new Date().toISOString(),
      });
    }
    fields.photoCount = fields.photos.length;
    fields.photoStatus = `${fields.photoCount} photo${fields.photoCount === 1 ? "" : "s"} received`;
  } else if (options.source !== "Telegram" && !options.replaying && /\b(?:sent|attached|uploaded)\s+(?:the\s+)?[1-9]\s*(?:photo|image|picture)/i.test(lower)) {
    const explicitCount = Number(message.match(/\b([1-9])\s*(?:photo|image|picture)/i)?.[1] || 1);
    for (let index = 0; index < explicitCount; index += 1) {
      fields.photos.push({
        id: randomUUID(),
        source: "Text confirmation",
        receivedAt: new Date().toISOString(),
      });
    }
    fields.photoCount = fields.photos.length;
    fields.photoStatus = `${fields.photoCount} photo${fields.photoCount === 1 ? "" : "s"} noted`;
  }
}

function looksLikeAccessResponse(message, fields = {}) {
  const lower = message.toLowerCase();
  if (/^(why|what|how|when|who|where)\b/i.test(message) || /\b(not sure|don'?t know)\b/i.test(message)) return false;
  if (/(permission|enter|access|keysafe|key safe|lockbox|lock box|someone home|home after|available|go in|let them in|approved|approve)/i.test(message)) {
    return true;
  }
  if (/(arrange|book|confirm|set up|organise|schedule).{0,28}(time|slot|visit|appointment|with me)/i.test(message)) {
    return true;
  }
  if (/(call|text|message|contact|ring).{0,36}(me|tenant).{0,24}(first|before|ahead|arrival|arriv)/i.test(message)) {
    return true;
  }
  if (/(contractor|plumber|electrician|engineer|vendor|tradesperson).{0,40}(call|text|message|contact|ring).{0,24}(first|before|ahead|arrival|arriv)/i.test(message)) {
    return true;
  }
  if (/(use|go with|that's fine|that is fine|ok|okay|yeah|yes|yep).{0,28}(saved|those|notes|access)/i.test(message)) {
    return true;
  }
  return Boolean(
    fields.savedAccessNotes
      && !looksLikeActiveRiskDetail(message)
      && /^(yes|yeah|yep|ok|okay|sure|fine|sounds good|go ahead|that's fine|that is fine)[.! ,]*$/i.test(lower)
  );
}

function looksLikeActiveRiskDetail(message) {
  return /(actively|right now|still|currently|dripping|pouring|leaking|sparking|smoke|flood|unsafe|water|electrical|lockout)/i.test(message);
}

function normalizeAccessPermission(message, fields = {}) {
  const trimmed = message.trim();
  if (!fields.savedAccessNotes) return trimmed;

  if (/^(yes|yeah|yep|ok|okay|sure|fine|sounds good|go ahead|that's fine|that is fine)[.! ,]*$/i.test(trimmed)) {
    return `Tenant approved saved access notes for this repair: ${fields.savedAccessNotes}`;
  }

  return trimmed;
}

function recoverAccessPermissionFromHistory(fields, messages) {
  if (fields.accessPermission) return;
  const answer = messages.findLast((item, index) => item.role === "tenant"
    && inferAskedField(messages[index - 1]?.text) === "accessPermission"
    && looksLikeAccessResponse(item.text, fields))?.text;
  if (answer) {
    fields.accessPermission = normalizeAccessPermission(answer, fields);
  }
}

function extractName(message) {
  const patterns = [
    /\bmy name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\bi am\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\bi'm\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\bthis is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function extractAddress(message) {
  const unitStreet = message.match(/\b(?:unit|flat|apt|apartment)\s*[\w-]+[, ]+\s*\d+\s+[A-Za-z][A-Za-z\s]+(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|place|pl)\b/i);
  if (unitStreet) return titleCase(unitStreet[0]);

  const street = message.match(/\b\d+\s+[A-Za-z][A-Za-z\s]+(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|place|pl)\b/i);
  if (street) return titleCase(street[0]);

  const unit = message.match(/\b(?:unit|flat|apt|apartment)\s*[\w-]+\b/i);
  if (unit) return titleCase(unit[0]);

  return "";
}

function looksLikeIssue(message) {
  if (isVagueIssue(message)) return false;
  const lower = normalizeIssueText(message);
  return [...categoryRules.flatMap(([, words]) => words), ...riskWords].some((word) => lower.includes(word));
}

function classifyIssue(text) {
  const lower = normalizeIssueText(text);
  const category = categoryRules.find(([, words]) => words.some((word) => lower.includes(word)))?.[0] || "General";
  const vendor = VENDORS.find((item) => item.trade === category) || VENDORS[VENDORS.length - 1];
  const hasEmergency = emergencyWords.some((word) => lower.includes(word));
  const hasHigh = highWords.some((word) => lower.includes(word));
  const urgency = hasEmergency ? "Emergency" : hasHigh ? "High" : "Standard";
  const risk = hasEmergency
    ? "Immediate property or safety risk"
    : hasHigh
      ? "Potential damage or service disruption"
      : "Routine maintenance";

  return {
    category,
    urgency,
    risk,
    vendor,
    roughPrice: estimatePrice(category, urgency, lower),
    confidence: category === "General" ? 74 : urgency === "Emergency" ? 94 : 88,
  };
}

function estimatePrice(category, urgency, text) {
  const baseByCategory = {
    Plumbing: [180, 480],
    Electrical: [180, 520],
    HVAC: [220, 650],
    Locksmith: [140, 320],
    Appliance: [160, 450],
    General: [120, 360],
  };
  const [baseLow, baseHigh] = baseByCategory[category] || baseByCategory.General;
  let low = baseLow;
  let high = baseHigh;

  if (urgency === "Emergency") {
    low += 160;
    high += 420;
  } else if (urgency === "High") {
    low += 80;
    high += 220;
  }

  if (/flood|burst|ceiling|sewage|major|whole/i.test(text)) {
    low += 180;
    high += 550;
  }

  return {
    low,
    high,
    label: `£${low}-£${high}`,
    basis: "Demo estimate based on trade, urgency, and risk words. Contractor quote should override this.",
  };
}

function getMissingFields(fields) {
  return REQUIRED_FIELDS.filter((field) => {
    if (field === "photos") return Number(fields.photoCount || 0) < MIN_PHOTOS;
    return !fields[field];
  });
}

function buildQuestionReply(fields, missingFields, classification) {
  const firstMissing = missingFields[0];
  const tenantName = fields.tenantName ? `, ${fields.tenantName.split(" ")[0]}` : "";
  const photosNeeded = Math.max(0, MIN_PHOTOS - Number(fields.photoCount || 0));
  const issueType = classification.category === "General"
    ? "maintenance issue"
    : `${classification.category.toLowerCase()} issue`;

  const questions = {
    tenantName: `No problem, I can get this logged properly. Could I take your full name, please?`,
    address: `Thanks${tenantName}. What is the full property address, including the flat or unit number if there is one?`,
    issueDescription: `Of course${tenantName}. What's the problem, and where in the property is it?`,
    activeRisk: `I have the ${issueType} noted. Just so we handle this at the right speed, is there anything active happening right now, like water leaking, smoke, sparking, a lockout, or anything unsafe?`,
    accessPermission: buildAccessQuestion(fields),
    photos: photosNeeded === MIN_PHOTOS
      ? `Last thing: could you send 3 photos, please? A close-up, a wider shot of the area, and one showing any visible damage or access issue. That gives the contractor a much clearer picture before they attend.`
      : `I have ${fields.photoCount} photo${fields.photoCount === 1 ? "" : "s"} so far. Could you send ${photosNeeded} more, please? Once I have those, the property manager will have what they need to move this along.`,
  };

  return questions[firstMissing];
}

function buildAccessQuestion(fields) {
  const saved = fields && fields.savedAccessNotes;
  if (saved) {
    return `Understood. I have saved access notes on file: "${saved}". Can you confirm whether we should use those for this repair, or should the contractor arrange a time with you first?`;
  }
  return "Understood. If we can get a contractor out, should they arrange a time with you first, or do they have permission to enter? Please include any access notes.";
}

function buildConfirmationReply(classification) {
  const response = classification.urgency === "Emergency" || classification.urgency === "High"
    ? "Thanks, that is everything we need. I have flagged this as urgent and packaged it up for the property manager."
    : "Thanks, that is everything we need. I have packaged this up for the property manager.";

  return `${response} You do not need to repeat anything now. They will review it and update you once the next step is confirmed.`;
}

function buildWorkOrder(session, classification, isReady) {
  const fields = session.fields;
  const now = new Date().toISOString();
  const reference = `MN-${session.requestId.slice(0, 6).toUpperCase()}`;

  return {
    id: session.requestId,
    reference,
    source: session.source,
    tenantName: fields.tenantName || "Unknown tenant",
    address: fields.address || "",
    issueDescription: fields.issueDescription || "",
    activeRisk: fields.activeRisk || "",
    accessPermission: fields.accessPermission || "",
    photoStatus: fields.photoStatus,
    photoCount: fields.photoCount || 0,
    tenantProfile: session.tenantProfile || null,
    category: classification.category,
    urgency: classification.urgency,
    risk: classification.risk,
    roughPrice: classification.roughPrice,
    confidence: classification.confidence,
    completeness: isReady ? "Ready" : "Needs info",
    missingFields: getMissingFields(fields),
    vendor: classification.vendor,
    status: isReady ? "Ready for approval" : "Waiting for tenant",
    summary: buildSummary(fields, classification),
    recommendedAction: buildRecommendedAction(classification),
    dispatchPlan: buildDispatchPlan(classification),
    contractorDispatches: [],
    confirmedContractor: null,
    drafts: buildDrafts(fields, classification, reference),
    conversation: session.messages,
    createdAt: session.createdAt,
    updatedAt: now,
  };
}

function buildSummary(fields, classification) {
  const address = fields.address || "address not yet provided";
  return `${classification.urgency} ${classification.category.toLowerCase()} request at ${address}. ${classification.risk}.`;
}

function buildRecommendedAction(classification) {
  if (classification.urgency === "Emergency") {
    return "Call the tenant, approve immediate vendor dispatch, and notify the landlord before costs escalate.";
  }
  if (classification.urgency === "High") {
    return "Approve same-day vendor contact and confirm tenant access details.";
  }
  return "Review details, approve vendor contact, and schedule the next available appointment.";
}

function buildDispatchPlan(classification) {
  const urgent = ["Emergency", "High"].includes(classification.urgency);
  const vendors = getTopVendorsForCategory(classification.category, 3);

  return {
    mode: urgent ? "Auto-contact recommended" : "Landlord review recommended",
    reason: urgent
      ? "Urgent maintenance can create property damage or safety risk, so the app can contact the top approved contractors immediately."
      : "Routine maintenance is usually better held for landlord quote review before contacting contractors.",
    suggestedVendors: vendors.map((vendor) => vendor.id),
  };
}

function buildDrafts(fields, classification, reference) {
  const tenant = fields.tenantName || "there";
  const address = fields.address || "the property";
  const vendor = classification.vendor;

  return {
    tenant: `Hi ${tenant}, thanks for the details. We have logged maintenance request ${reference} as ${classification.urgency.toLowerCase()} ${classification.category.toLowerCase()}. The property manager will review it and update you once ${vendor.name} is approved or scheduled.`,
    vendor: `New ${classification.urgency.toLowerCase()} ${classification.category.toLowerCase()} work order ${reference}. Address: ${address}. Issue: ${fields.issueDescription || "See tenant notes"}. Active risk: ${fields.activeRisk || "Not confirmed"}. Photos: ${fields.photoStatus || "Not provided"}. Access: ${fields.accessPermission || "Confirm with tenant"}. Please advise earliest availability.`,
    landlord: `Maintenance request ${reference} has been raised for ${address}. The issue appears to be ${classification.category.toLowerCase()} with ${classification.risk.toLowerCase()}. Recommended action: ${buildRecommendedAction(classification)}`,
  };
}

function titleCase(value) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (word.length <= 2 ? word.toUpperCase() : `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`))
    .join(" ");
}
