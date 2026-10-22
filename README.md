# EduBot AI Tutor

EduBot is a browser-based study tutor for ICSE, ISC, JEE and NEET learners.

## Gemini API setup (server-side only)

1. Import this repository into a Vercel project and deploy the branch `feature/gemini-ai-tutor` as a **Preview** deployment. Do not change the production branch while testing.
2. In the Vercel project, open **Settings → Environment Variables**.
3. Add `GEMINI_API_KEY` with your Google AI Studio API key. Select **Preview** for the environment while testing. Never put the key in `index.html`, a public JavaScript file, GitHub commits, or chat messages.
4. Optionally add `GEMINI_MODEL` with a model enabled for your key. The default is `gemini-3.8-flash`.
5. Redeploy the preview after saving environment variables.
6. Open the preview URL and ask a short test question. The frontend sends `POST /api/chat`; the server endpoint returns JSON in the form `{ "reply": "..." }`.

## Notes

- The key is read only by the serverless function. The browser never receives it.
- Google AI Studio's free usage has quotas and rate limits; it is not unlimited and can change. A valid key does not guarantee that a particular model is enabled or available in every region.
- If the deployment returns a quota or model error, check Google AI Studio's API key/project, enabled model access, and usage limits.
- This repository currently uses a static frontend plus a Vercel serverless endpoint. GitHub Pages alone cannot run `api/chat.js`; use a host that supports the included Vercel function.
