<div align="center">

# 📚 PDF Buddy

**Upload any PDF — digital or scanned — then chat with it, quiz yourself, build flashcards, and keep notes. All in one place.**

🌐 **Live at [pdf-buddy.me](https://pdf-buddy.me)**

![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.136-009688?logo=fastapi&logoColor=white)
![FAISS](https://img.shields.io/badge/FAISS-vector_search-4b8bbe)
![Groq](https://img.shields.io/badge/LLM-Groq_API-f55036)
![Tesseract](https://img.shields.io/badge/OCR-Tesseract-3d8563)

</div>

---

## What it does

PDF Buddy turns any PDF into an interactive study companion. Drop in a
document and you can ask it questions, test yourself with auto-generated
quizzes and flashcards, and collect everything worth keeping in a built-in
notebook. Scanned and photographed PDFs work too, thanks to automatic OCR.

## Features

### 🤖 AI Agent
- **Chat with your PDFs** — answers are grounded in retrieved passages
  (RAG) and cite which document they came from.
- **Multi-PDF knowledge base** — upload several PDFs and ask questions
  across all of them at once.
- **Markdown & math rendering** — formatted answers with LaTeX equations
  (KaTeX), so technical material reads cleanly.

### 📝 Study tools
- **Quiz Me** — topic-aware multiple-choice questions with instant
  feedback; keep generating more without repeats.
- **Flashcards** — two-sided flip cards for active recall, extendable the
  same way.
- Both follow your latest chat question, so they focus on what you're
  studying right now.

### 📓 Notebook
- **Message-style notes** — type in the composer, press <kbd>Enter</kbd> to
  add a note block (<kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line), then
  reorder blocks freely.
- **Floating format menu** — select text and a Notion-style toolbar appears:
  bold, italic, marker highlight, lists.
- **Save anything** — one click keeps a quiz question, flashcard, AI answer,
  or image in the notebook.
- **Copy & Export** — copy the whole notebook (images included) or export a
  print-ready PDF with rendered Markdown, math, and highlights.
- Notes and images persist in your browser (localStorage + IndexedDB).

### ⚙️ Under the hood
- **Scanned-PDF support** — pages without a text layer are rendered and read
  with Tesseract OCR automatically, page by page.
- **Per-session isolation** — each browser gets its own private knowledge
  base and chat history (`X-Session-Id`), reaped after 60 minutes idle.
- **Live upload progress** — uploading → extracting → OCR → indexing, with
  per-stage percentages.

## Tech stack

| Layer     | Technology                                                  |
|-----------|-------------------------------------------------------------|
| Frontend  | React 19, Vite, marked (Markdown), KaTeX (math), IndexedDB  |
| Backend   | FastAPI, Uvicorn                                            |
| RAG       | sentence-transformers (BAAI/bge-small-en-v1.5), FAISS       |
| LLM       | Groq API (default `llama-3.3-70b-versatile`, configurable)  |
| OCR       | Tesseract, Poppler (pdf2image)                              |
| Hosting   | Vercel (frontend) · DigitalOcean + Docker + Caddy (backend) |

## Architecture

```
  Browser ──HTTPS──> pdf-buddy.me  (Vercel — React/Vite frontend)
                          │
                          └──HTTPS──> api.pdf-buddy.me
                                          │  Caddy reverse proxy + Let's Encrypt TLS
                                          └──> FastAPI backend (Docker, DigitalOcean Droplet)
                                                   ├─ RAG:  sentence-transformers + FAISS
                                                   ├─ OCR:  Tesseract + Poppler
                                                   └─ LLM:  Groq API
```

## How it works

1. **Upload** — the PDF is streamed to the backend (extension + `%PDF`
   header checked, 100 MB cap) and processed in a background job the client
   polls for progress. Each page's text layer is extracted; pages with
   little or no text are rasterized one at a time and run through OCR.
2. **Index** — extracted text is split into overlapping chunks, embedded
   with a sentence-transformer model, and stored in a per-session FAISS
   index, each chunk tagged with its source document.
3. **Ask** — your question is embedded and matched against the index; the
   most relevant chunks (across all uploaded PDFs) go to the LLM, which
   answers from that context only and reports which documents it used.

## Security & hardening

- **Session isolation** — documents, chat history, and upload jobs are
  scoped to a session id; idle sessions expire (60 min TTL) and the session
  table is capped with LRU eviction.
- **Rate limiting** — per-IP sliding-window limits, strictest on the
  expensive endpoints (chat, quiz, flashcards, upload).
- **Resource bounds** — upload size (100 MB), page count, OCR page count,
  and concurrent processing jobs are all capped so one upload can't exhaust
  the droplet.
- **Input & output hygiene** — uploads are content-checked, LLM JSON output
  is validated server-side before it reaches the client, internal error
  details stay in server logs, and all model/notebook HTML is sanitized with
  DOMPurify in the browser.
- **Deployment** — the container runs as a non-root user; the Groq API key
  is supplied via environment variable and never committed; CORS is
  restricted to known origins.

## Local setup

### Prerequisites
- Python 3.11+ and Node.js 18+
- **Tesseract OCR** and **Poppler** on your PATH (only needed for scanned PDFs)
- A free **Groq API key** from [console.groq.com](https://console.groq.com)

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

export GROQ_API_KEY="gsk_your_key"   # PowerShell: $env:GROQ_API_KEY="gsk_your_key"
export GROQ_MODEL="llama-3.3-70b-versatile"   # optional, this is the default

uvicorn main:app --reload
```
Backend runs at `http://127.0.0.1:8000`.

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Frontend runs at `http://127.0.0.1:5173`.

To point the frontend at a deployed backend, set `VITE_API_URL` (e.g. in
`frontend/.env.production`):
```
VITE_API_URL=https://api.pdf-buddy.me
```

## Deployment

**Backend** (Docker on a DigitalOcean Droplet, behind Caddy for HTTPS):
```bash
docker build -t pdf-buddy .
docker run -d --restart always -p 127.0.0.1:8000:8000 \
  -e GROQ_API_KEY="gsk_your_key" \
  --name pdfbuddy pdf-buddy
```
Caddy proxies `api.pdf-buddy.me` → `127.0.0.1:8000` and manages TLS
automatically. **Frontend** deploys on Vercel as a static Vite build;
pushes to `main` trigger a redeploy.

## Project structure
```
backend/
  main.py              FastAPI app, endpoints, rate limiting, upload jobs
  services/
    rag.py             sessions, embeddings, FAISS index, chunking
    ocr.py             text extraction with page-by-page OCR fallback
  requirements.txt
  Dockerfile
frontend/
  src/
    App.jsx            the UI
    App.css, index.css
  index.html
```

## Roadmap

- **Page-number citations** — show the source page for each answer, not
  just the document name.
- **Streaming responses** — stream answers token-by-token for
  faster-feeling replies.
- **Persistent indexes** — survive backend restarts by storing chunks and
  embeddings on disk.

## Notes & limitations

- **In-memory storage.** Document indexes and chat history live in RAM, so
  a backend restart (or 60 minutes of inactivity) clears them. Notebook
  content persists in the browser regardless.
- **OCR preprocessing.** Scanned pages are converted to grayscale and
  thresholded to black/white before OCR — that's what makes Tesseract read
  real-world scans reliably. Threshold and page caps are tunable in
  `backend/services/ocr.py`.

---

<div align="center">
Built with FastAPI, React, FAISS, and Groq.
</div>
