# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Run the server (production/main)
npm start          # runs: node server.js

# Run the Gemini variant server
node servertest.js
```

No test suite is configured (`npm test` exits with an error by default).

## Architecture

This is **QuantumBot** — a domain-restricted chatbot assistant for microcontroller and electronics topics (Arduino, ESP32, ESP8266, STM32, Raspberry Pi, etc.).

### Two server variants

| File | AI Backend | Module system |
|---|---|---|
| `server.js` | OpenAI-compatible API (configurable via env) | CommonJS (`require`) |
| `servertest.js` | Google Gemini via `@google/genai` | ES Modules (`import`) |

Both expose the same `POST /api/chat` endpoint that accepts `{ messages: [{role, content}] }` in OpenAI message format and return an OpenAI-shaped response (`choices[0].message`). This means `public/index.html` works with either backend without modification — `servertest.js` translates Gemini's response format to match OpenAI's shape before returning it.

### Environment variables

- `server.js` requires: `OPENAI_API_KEY`, optionally `BASE_URL` (default: `https://api.openai.com`), `MODEL_NAME` (default: `o3-mini`), `PORT` (default: 3000)
- `servertest.js` requires: `GEMINI_API_KEY`, optionally `PORT` (default: 3000)

Variables are loaded from a `.env` file via `dotenv`.

### Frontend

`public/index.html` is a single-file chat UI (HTML + CSS + JS inline). It maintains a `messages` array in-memory (no persistence), posts to `/api/chat`, and renders markdown responses including images. The UI uses a dark theme with CSS custom properties defined in `:root`.
