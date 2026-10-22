// Vercel serverless endpoint for EduBot.
// Keep GEMINI_API_KEY and GROQ_API_KEY in the hosting environment variables; never expose either in frontend code.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MAX_MESSAGE_CHARS = 4000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST to send a message." });
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
  const targetExam = typeof body.targetExam === "string" ? body.targetExam.trim().slice(0, 100) : "General study";
  const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 100) : "General";

  if (!message) return res.status(400).json({ error: "Please enter a question." });
  if (message.length > MAX_MESSAGE_CHARS) {
    return res.status(413).json({ error: "Please keep each message under 4,000 characters." });
  }
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    return res.status(503).json({
      error: "The AI tutor is not configured. Add GEMINI_API_KEY or GROQ_API_KEY to the deployment environment."
    });
  }

  const systemInstruction = [
    "You are EduBot, a friendly, accurate school and entrance-exam study tutor.",
    "Use this response style for EVERY exam and subject: clear, readable, student-friendly, and concise by default. Do not begin with a long generic greeting or repeat the question.",
    "Structure answers with a short direct opening, useful headings, bullets or numbered steps, and whitespace. Use Markdown bold for key terms and standard Markdown/LaTeX for formulas when helpful. Never print escaped formatting such as \\*\\* or \\---; use actual Markdown characters.",
    "Answer the exact question first. For simple doubts, keep the answer short. For difficult concepts, derivations, proofs, or multi-step problems, explain each necessary step without skipping important reasoning.",
    "Include definitions, formulas, units, worked examples, and exam tips only when relevant. Adapt terminology and depth to the selected exam and subject: ICSE/ISC board wording where suitable, and deeper conceptual reasoning for JEE/NEET. For other exams, follow their appropriate level and terminology.",
    "For numerical problems, list the relevant formula, substitute values, show calculation, and state the final answer with units. For theory, explain the key concept and give a relevant example if it improves understanding.",
    "If a question is ambiguous, state the assumption or ask one brief clarifying question. Never invent syllabus citations or pretend certainty when unsure. Correct misconceptions politely.",
    "Use a compact answer by default; expand only when the question needs it or the student asks for detailed notes. Avoid repetitive introductions, conclusions, and unnecessary decorative separators."
  ].join(" ");

  const userPrompt = `Selected exam: ${targetExam}\nSelected subject: ${subject}\nStudent question:\n${message}`;
  let geminiFailure = "not_configured";

  // Primary: Gemini. Keep retry time bounded so the backup can run within Vercel's function limit.
  if (process.env.GEMINI_API_KEY) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const upstream = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": process.env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ role: "user", parts: [{ text: userPrompt }] }],
              generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
            }),
            signal: AbortSignal.timeout(7500)
          }
        );
        const data = await upstream.json().catch(() => ({}));
        if (upstream.ok) {
          const reply = (data.candidates || [])
            .flatMap(candidate => candidate.content && candidate.content.parts ? candidate.content.parts : [])
            .map(part => typeof part.text === "string" ? part.text : "")
            .join("")
            .trim();
          if (reply) return res.status(200).json({ reply, provider: "gemini" });
          geminiFailure = "empty_response";
          break;
        }

        geminiFailure = `http_${upstream.status}`;
        const transient = [408, 429, 500, 502, 503, 504].includes(upstream.status);
        console.error("Gemini provider failure:", JSON.stringify({
          status: upstream.status,
          model: GEMINI_MODEL,
          providerMessage: data && data.error && typeof data.error.message === "string"
            ? data.error.message.slice(0, 200) : ""
        }));
        if (transient && attempt === 0) {
          await sleep(250);
          continue;
        }
        break;
      } catch (error) {
        geminiFailure = error && error.name === "TimeoutError" ? "timeout" : "network_error";
        if (attempt === 0) {
          await sleep(250);
          continue;
        }
        break;
      }
    }
  }

  // Backup: Groq's OpenAI-compatible chat completions API.
  if (process.env.GROQ_API_KEY) {
    try {
      const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.4,
          max_completion_tokens: 1200
        }),
        signal: AbortSignal.timeout(9000)
      });
      const data = await upstream.json().catch(() => ({}));
      if (upstream.ok) {
        const reply = data && data.choices && data.choices[0] &&
          data.choices[0].message && typeof data.choices[0].message.content === "string"
          ? data.choices[0].message.content.trim() : "";
        if (reply) return res.status(200).json({ reply, provider: "groq" });
        console.error("Groq returned an empty response:", JSON.stringify({ model: GROQ_MODEL }));
      } else {
        console.error("Groq provider failure:", JSON.stringify({
          status: upstream.status,
          model: GROQ_MODEL,
          providerMessage: data && data.error && typeof data.error.message === "string"
            ? data.error.message.slice(0, 200) : ""
        }));
      }
    } catch (error) {
      console.error("Groq request failed:", error && error.name ? error.name : "UnknownError");
    }
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({
      error: "Gemini is temporarily unavailable and no backup AI provider is configured. Add GROQ_API_KEY to the Preview environment."
    });
  }
  return res.status(503).json({
    error: "Both AI providers are temporarily unavailable. Please try again shortly."
  });
};
