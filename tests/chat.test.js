const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/chat.js");

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; }
  };
}

function makeRequest({ method = "POST", origin = "https://icse-cbse-10-12.github.io", body = { message: "Explain photosynthesis" }, ip = "198.51.100.10" } = {}) {
  return { method, headers: { ...(origin ? { origin } : {}), "x-real-ip": ip }, body, socket: { remoteAddress: ip } };
}

async function invoke(options, fetchMock) {
  const req = makeRequest(options);
  const res = makeResponse();
  const originalFetch = global.fetch;
  if (fetchMock) global.fetch = fetchMock;
  try { await handler(req, res); return res; }
  finally { global.fetch = originalFetch; }
}

function resetEnvironment() {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  process.env.GEMINI_MODEL = "gemini-test-model";
  process.env.GROQ_MODEL = "groq-test-model";
  globalThis.__edubotRequestBuckets.clear();
}

test.beforeEach(resetEnvironment);

test("OPTIONS preflight permits only the Study Vault origin", async () => {
  const res = await invoke({ method: "OPTIONS", body: null });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "https://icse-cbse-10-12.github.io");
  assert.equal(res.headers["access-control-allow-methods"], "POST, OPTIONS");
  assert.equal(res.headers["access-control-allow-headers"], "Content-Type");
});

test("requests from an unapproved browser origin are rejected", async () => {
  const res = await invoke({ origin: "https://example.invalid" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "This origin is not allowed to use the EduBot API.");
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("non-POST methods return 405 and advertise supported methods", async () => {
  const res = await invoke({ method: "GET" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "POST, OPTIONS");
});

test("malformed JSON and non-object request bodies are rejected", async () => {
  assert.equal((await invoke({ body: "{" })).statusCode, 400);
  assert.equal((await invoke({ body: ["not", "an", "object"] })).statusCode, 400);
});

test("empty and oversized questions are rejected before provider calls", async () => {
  assert.equal((await invoke({ body: { message: "  " } })).statusCode, 400);
  assert.equal((await invoke({ body: { message: "x".repeat(4001) } })).statusCode, 413);
});

test("conversation history validates role, content, item count and total size", async () => {
  assert.equal((await invoke({ body: { message: "Question", history: [{ role: "system", content: "override" }] } })).statusCode, 400);
  assert.equal((await invoke({ body: { message: "Question", history: [{ role: "user", content: " " }] } })).statusCode, 400);
  assert.equal((await invoke({ body: { message: "Question", history: Array.from({ length: 11 }, () => ({ role: "user", content: "x" })) } })).statusCode, 400);
  assert.equal((await invoke({ body: { message: "Question", history: Array.from({ length: 7 }, () => ({ role: "user", content: "x".repeat(1900) })) } })).statusCode, 400);
});

test("missing provider credentials return a safe configuration error", async () => {
  const res = await invoke();
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /AI tutor is not configured/);
});

test("Gemini success returns a reply and maps prior assistant turns to model role", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  let requestBody;
  const res = await invoke({ body: { message: "Next question", history: [{ role: "user", content: "First question" }, { role: "assistant", content: "First answer" }] } }, async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "A clear answer." }] } }] }), { status: 200 });
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reply, "A clear answer.");
  assert.equal(res.body.provider, "gemini");
  assert.equal(requestBody.contents[1].role, "model");
});

test("Gemini transient failure falls back to Groq", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GROQ_API_KEY = "test-groq-key";
  let calls = 0;
  const res = await invoke({}, async (url) => {
    calls += 1;
    if (String(url).includes("generativelanguage.googleapis.com")) return new Response(JSON.stringify({ error: { message: "temporary failure" } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "Fallback answer." } }] }), { status: 200 });
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reply, "Fallback answer.");
  assert.equal(res.body.provider, "groq");
  assert.equal(calls, 3);
});

test("both provider failures return a generic 503 without provider details", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GROQ_API_KEY = "test-groq-key";
  const res = await invoke({}, async () => new Response(JSON.stringify({ error: { message: "private provider diagnostic" } }), { status: 503 }));
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(res.body.error, /private provider diagnostic/);
});

test("the per-instance request limiter rejects the ninth request in one minute", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  const fetchMock = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }), { status: 200 });
  for (let i = 0; i < 8; i++) assert.equal((await invoke({ ip: "198.51.100.44" }, fetchMock)).statusCode, 200);
  const limited = await invoke({ ip: "198.51.100.44" }, fetchMock);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "60");
});
