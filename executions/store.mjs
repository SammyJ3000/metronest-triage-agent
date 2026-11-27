// The JSON file that holds chat sessions, work orders and the activity feed.
// Shared by server.mjs and the Telegram bot so both read and write it the same way.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mergeWorkOrder } from "./triage-engine.mjs";

export function createStore(storePath, initialStore) {
  async function write(store) {
    // Write a temporary file and rename it over the store, so a reader never sees half a file.
    const temporary = `${storePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`);
    await rename(temporary, storePath);
  }

  async function ensure() {
    await mkdir(path.dirname(storePath), { recursive: true });
    if (!existsSync(storePath)) await write(initialStore());
  }

  async function read() {
    await ensure();
    return JSON.parse(await readFile(storePath, "utf8"));
  }

  return { read, write, ensure };
}

export async function loadTenantDirectory(filePath) {
  if (!existsSync(filePath)) return [];
  return JSON.parse(await readFile(filePath, "utf8"));
}

// Add a work order, or merge it into the saved one with the same id.
export function upsertRequest(store, request) {
  const existingIndex = store.requests.findIndex((item) => item.id === request.id);
  if (existingIndex >= 0) store.requests[existingIndex] = mergeWorkOrder(store.requests[existingIndex], request);
  else store.requests.unshift(request);
}

export function activityEntry(type, text) {
  return { id: randomUUID(), timestamp: new Date().toISOString(), type, text };
}

export function logActivity(store, type, text) {
  store.activity.unshift(activityEntry(type, text));
}
