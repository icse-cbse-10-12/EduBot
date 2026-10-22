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
    const upstream = await fetch(
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
        })
      }
    );

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      // Do not send provider details or secrets to the browser.
      console.error("Gemini API request failed with status", upstream.status);
      if (upstream.status === 429) {
        return res.status(429).json({ error: "The free AI quota is temporarily busy. Please wait a little and try again." });
      }
      if (upstream.status === 400 || upstream.status === 404) {
        return res.status(502).json({ error: "The AI model request was rejected. Check the configured Gemini model and API access." });
      }
      return res.status(502).json({ error: "The AI service is temporarily unavailable. Please try again shortly." });
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
