// Test only. Loaded with `node --import` before server.mjs to stand in for a slow model.
// Calls to the OpenAI API wait, then fail, so the server falls back to rules.
// Nothing leaves the machine and no key is used.
const SLOW_MODEL_DELAY_MS = Number(process.env.SLOW_MODEL_DELAY_MS || 1500);
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://api.openai.com/")) {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MODEL_DELAY_MS));
    return new Response("slow model stub", { status: 503 });
  }
  return realFetch(url, options);
};
