import { readFile } from "node:fs/promises";

export async function loadEnv(file) {
  let content;
  try { content = await readFile(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
