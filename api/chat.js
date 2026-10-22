// Vercel serverless endpoint for EduBot. Keep GEMINI_API_KEY in hosting environment variables.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_MESSAGE_CHARS = 4000;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST to send a message." });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: "The AI tutor is not configured yet. Add GEMINI_API_KEY to the deployment environment."
    });
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

  try {
    // Retry transient provider outages (503/502/504) twice before returning an error.
    let upstream;
    let data = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        upstream = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": process.env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{
                role: "user",
                parts: [{ text: `Selected exam: ${targetExam}\nSelected subject: ${subject}\nStudent question:\n${message}` }]
              }],
              generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
            }),
            signal: AbortSignal.timeout(18000)
          }
        );
        data = await upstream.json().catch(() => ({}));
      } catch (requestError) {
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        throw requestError;
      }

      if (upstream.ok) break;
      const transient = [500, 502, 503, 504].includes(upstream.status);
      if (transient && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      break;
    }

    if (!upstream || !upstream.ok) {
      const status = upstream ? upstream.status : 503;
      // Log only provider status and safe diagnostic code; never log request headers or keys.
      const providerMessage = data && data.error && typeof data.error.message === "string"
        ? data.error.message.slice(0, 300)
        : "";
      console.error("Gemini API request failed:", JSON.stringify({
        status,
        model: MODEL,
        providerMessage
      }));
      if (status === 429) {
        return res.status(429).json({ error: "The AI service is rate-limiting requests. Please wait briefly and try again." });
      }
      if (status === 400 || status === 404) {
        return res.status(502).json({ error: "The AI model request was rejected. Check the configured Gemini model and API access." });
      }
      if ([500, 502, 503, 504].includes(status)) {
        return res.status(503).json({ error: "Gemini is temporarily unavailable after retrying. Please try again in a minute." });
      }
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: "The Gemini API key or its permissions need checking in the Preview environment." });
      }
      return res.status(502).json({ error: "The AI provider rejected the request. Check the Preview deployment logs." });
    }

    const reply = (data.candidates || [])
      .flatMap(candidate => candidate.content && candidate.content.parts ? candidate.content.parts : [])
      .map(part => typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();

    if (!reply) {
      return res.status(502).json({ error: "The AI did not return a text answer. Please rephrase your question." });
    }

    return res.status(200).json({ reply });
  } catch (error) {
    console.error("EduBot chat endpoint failed:", error && error.name ? error.name : "UnknownError");
    return res.status(500).json({ error: "Could not reach the AI service. Please try again." });
  }
};
