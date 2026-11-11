// Vercel serverless endpoint shared by the standalone EduBot and the Study Vault embed.
// Provider keys must remain in Vercel environment variables; never expose them to the browser.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const ALLOWED_ORIGIN = "https://icse-cbse-10-12.github.io";
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_CHARS = 2000;
const MAX_HISTORY_TOTAL_CHARS = 12000;
const MAX_RATE_BUCKETS = 5000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 8;

// Best-effort per-instance protection. For a hard global limit across serverless instances,
// replace this with a shared store (e.g. Upstash Redis) before significant public traffic.
const requestBuckets = globalThis.__edubotRequestBuckets || new Map();
globalThis.__edubotRequestBuckets = requestBuckets;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  if (origin && origin !== ALLOWED_ORIGIN) return false;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  return true;
}

function isRateLimited(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (typeof req.headers["x-real-ip"] === "string" && req.headers["x-real-ip"]) ||
    (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "") ||
    req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = requestBuckets.get(ip) || [];
  const recent = bucket.filter(timestamp => now - timestamp < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    requestBuckets.set(ip, recent);
    return true;
  }
  recent.push(now);
  requestBuckets.set(ip, recent);
  if (requestBuckets.size > MAX_RATE_BUCKETS) {
    for (const [key, timestamps] of requestBuckets) {
      if (!timestamps.some(timestamp => now - timestamp < RATE_WINDOW_MS)) requestBuckets.delete(key);
      if (requestBuckets.size <= MAX_RATE_BUCKETS) break;
    }
    while (requestBuckets.size > MAX_RATE_BUCKETS) {
      requestBuckets.delete(requestBuckets.keys().next().value);
    }
  }
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!applyCors(req, res)) {
    return res.status(403).json({ error: "This origin is not allowed to use the EduBot API." });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Use POST to send a message." });
  }
  if (isRateLimited(req)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "You've sent several questions recently. Please wait a minute and try again." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ error: "Request body must be valid JSON." });
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Request body must be a JSON object." });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const targetExam = typeof body.targetExam === "string" ? body.targetExam.trim().slice(0, 100) : "ICSE Class 10";
  const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 100) : "General";
  const history = body.history === undefined ? [] : body.history;

  if (!message) return res.status(400).json({ error: "Please enter a question." });
  if (message.length > MAX_MESSAGE_CHARS) {
    return res.status(413).json({ error: "Please keep each message under 4,000 characters." });
  }
  if (!Array.isArray(history) || history.length > MAX_HISTORY_MESSAGES ||
      history.some(item => !item || typeof item !== "object" ||
        !["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string" ||
        !item.content.trim() || item.content.length > MAX_HISTORY_CHARS) ||
      history.reduce((total, item) => total + item.content.length, 0) > MAX_HISTORY_TOTAL_CHARS) {
    return res.status(400).json({ error: "Conversation history is invalid or too long. Please clear the chat and try again." });
  }
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: "The AI tutor is not configured. Add GEMINI_API_KEY or GROQ_API_KEY to the deployment environment." });
  }

  const systemInstruction = [
    "You are EduBot, a friendly, accurate, age-appropriate school and entrance-exam study tutor.",
    "Use clear, readable, student-friendly answers. Do not begin with a long generic greeting or repeat the question.",
    "Structure answers with a short direct opening, useful headings, bullets or numbered steps, and whitespace. Use Markdown bold for key terms and standard Markdown/LaTeX for formulas when helpful.",
    "Answer the exact question first. Keep simple doubts short; explain difficult concepts and multi-step problems carefully without skipping necessary reasoning.",
    "Adapt terminology and depth to the selected exam and subject. Use ICSE Class 10 wording where suitable.",
    "For numerical problems, state the relevant formula, substitute values, show the calculation, and include units. For theory, explain the key concept and use an example when useful.",
    "If a question is ambiguous, state the assumption or ask one brief clarifying question. Never invent syllabus citations or pretend certainty when unsure. Correct misconceptions politely.",
    "Do not claim to have accessed private study materials unless supplied in the conversation. Never ask for passwords, phone numbers, or other private information."
  ].join(" ");

  const userPrompt = `Selected exam: ${targetExam}\nSelected subject: ${subject}\nStudent question:\n${message}`;
  const geminiHistory = history.map(item => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }]
  }));
  const groqHistory = history.map(item => ({ role: item.role, content: item.content }));
  let geminiFailure = "not_configured";

  if (process.env.GEMINI_API_KEY) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const upstream = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [...geminiHistory, { role: "user", parts: [{ text: userPrompt }] }],
              generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
            }),
            signal: AbortSignal.timeout(7500)
          }
        );
        const data = await upstream.json().catch(() => ({}));
        if (upstream.ok) {
          const reply = (data.candidates || [])
            .flatMap(candidate => candidate.content?.parts || [])
            .map(part => typeof part.text === "string" ? part.text : "")
            .join("").trim();
          if (reply) return res.status(200).json({ reply, provider: "gemini" });
          geminiFailure = "empty_response";
          break;
        }
        geminiFailure = `http_${upstream.status}`;
        const transient = [408, 429, 500, 502, 503, 504].includes(upstream.status);
        console.error("Gemini provider failure:", JSON.stringify({
          status: upstream.status, model: GEMINI_MODEL,
          providerMessage: typeof data?.error?.message === "string" ? data.error.message.slice(0, 200) : ""
        }));
        if (transient && attempt === 0) { await sleep(250); continue; }
        break;
      } catch (error) {
        geminiFailure = error?.name === "TimeoutError" ? "timeout" : "network_error";
        if (attempt === 0) { await sleep(250); continue; }
        break;
      }
    }
  }

  if (process.env.GROQ_API_KEY) {
    try {
      const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: systemInstruction },
            ...groqHistory,
            { role: "user", content: userPrompt }
          ],
          temperature: 0.4,
          max_completion_tokens: 1200
        }),
        signal: AbortSignal.timeout(9000)
      });
      const data = await upstream.json().catch(() => ({}));
      if (upstream.ok) {
        const reply = data?.choices?.[0]?.message?.content?.trim();
        if (reply) return res.status(200).json({ reply, provider: "groq" });
        console.error("Groq returned an empty response:", JSON.stringify({ model: GROQ_MODEL }));
      } else {
        console.error("Groq provider failure:", JSON.stringify({
          status: upstream.status, model: GROQ_MODEL,
          providerMessage: typeof data?.error?.message === "string" ? data.error.message.slice(0, 200) : ""
        }));
      }
    } catch (error) {
      console.error("Groq request failed:", error?.name || "UnknownError");
    }
  }

  console.error("All configured AI providers failed:", JSON.stringify({ geminiFailure, groqConfigured: Boolean(process.env.GROQ_API_KEY) }));
  return res.status(503).json({
    error: "The AI tutor is temporarily unavailable. Please try again shortly."
  });
};
