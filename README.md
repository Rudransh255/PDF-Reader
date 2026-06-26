# PDF Buddy

An AI-powered PDF study companion. Upload a PDF — digital or scanned — then chat
with it, generate quizzes and flashcards from its content, and keep notes, all in
one workspace.

**Live:** https://pdf-buddy.me

---

## Features

- **Chat with your PDF** — ask questions and get answers grounded in the
  document, using retrieval-augmented generation (RAG).
- **Scanned PDF support (OCR)** — image-only PDFs are run through OCR
  automatically, so scanned and photographed documents work too.
- **Math rendering** — answers containing LaTeX are rendered as formatted
  equations with KaTeX.
- **Quiz Me** — generates multiple-choice questions from the document with
  instant right/wrong feedback. Topic-aware based on your last question.
- **Flashcards** — generates two-sided flip cards for study, also topic-aware.
- **Notebook** — a rich-text notebook with bold/italic/highlight/bullets, image
  insertion with lightbox preview, one-click saving of any quiz, flashcard, AI
  answer, or image, export to PDF, and persistence in the browser.
- **Real-time upload progress** — per-stage feedback (uploading, extracting
  text, OCR, building the index) while a document is processed.

---

## Architecture

```
  Browser ──HTTPS──> pdf-buddy.me (Vercel, React/Vite frontend)
                          │
                          └──HTTPS──> api.pdf-buddy.me
                                          │  (Caddy reverse proxy + Let's Encrypt TLS)
                                          └──> FastAPI backend (Docker, DigitalOcean)
                                                   ├─ RAG: sentence-transformers + FAISS
                                                   ├─ OCR: Tesseract + Poppler
                                                   └─ LLM: Groq API
```

**Frontend** — React + Vite, deployed on Vercel. Notebook text persists in
`localStorage`; notebook images persist in `IndexedDB`. Math via KaTeX.

**Backend** — FastAPI (Python), containerized with Docker, running on a
DigitalOcean Droplet behind Caddy (which provides automatic HTTPS via
Let's Encrypt).
- RAG: `sentence-transformers` (BAAI/bge-small-en-v1.5) for embeddings, FAISS for
  vector search.
- LLM: Groq API (default model `llama-3.3-70b-versatile`), OpenAI-compatible.
- OCR: Tesseract + Poppler, via `pytesseract` and `pdf2image`.

---

## Tech stack

| Layer     | Technology                                              |
|-----------|---------------------------------------------------------|
| Frontend  | React, Vite, KaTeX, IndexedDB                           |
| Backend   | FastAPI, Uvicorn                                        |
| RAG       | sentence-transformers (bge-small-en-v1.5), FAISS        |
| LLM       | Groq API (llama-3.3-70b-versatile)                      |
| OCR       | Tesseract, Poppler                                      |
| Hosting   | Vercel (frontend), DigitalOcean + Docker + Caddy (API)  |

---

## Local setup

### Prerequisites
- Python 3.11+ and Node.js 18+
- **Tesseract OCR** and **Poppler** installed as system binaries and on PATH
  (needed for scanned-PDF OCR).
- A free **Groq API key** from https://console.groq.com

### Backend
```bash
cd backend
python -m venv venv
venv\Scripts\activate          # Windows  (source venv/bin/activate on macOS/Linux)
pip install -r requirements.txt

# set your Groq key (one session, PowerShell):
$env:GROQ_API_KEY="gsk_your_key"
# or permanently on Windows:  setx GROQ_API_KEY "gsk_your_key"  (then reopen terminal)

uvicorn main:app --reload
```
Backend runs at http://127.0.0.1:8000

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Frontend runs at http://127.0.0.1:5173

To point the frontend at a deployed backend, set `VITE_API_URL` (e.g. in
`frontend/.env.production`):
```
VITE_API_URL=https://api.pdf-buddy.me
```

---

## Deployment

The backend runs as a Docker container on a DigitalOcean Droplet, fronted by
Caddy for automatic HTTPS. The frontend is a static Vite build on Vercel.

Backend (on the server):
```bash
docker build -t pdf-buddy .
docker run -d --restart always -p 127.0.0.1:8000:8000 \
  -e GROQ_API_KEY="gsk_your_key" --name pdfbuddy pdf-buddy
```
Caddy proxies `api.pdf-buddy.me` to `127.0.0.1:8000` and handles TLS. The Groq
key is supplied as an environment variable and is never committed to the repo.

---

## Notes & limitations

- **Single shared state.** The backend stores the active document, chat history,
  and search index in module-level globals, so it serves one document/session at
  a time — appropriate for a personal tool or demo, not concurrent multi-user use.
- **OCR preprocessing.** Scanned pages are converted to grayscale and hard-
  thresholded to pure black/white before OCR — this is what makes Tesseract
  reliably read real-world scans. The threshold is tunable in
  `backend/services/ocr.py`.
- **Image persistence is per-browser.** Notebook images live in the browser's
  IndexedDB, so they don't sync across browsers or devices.

---

## Project structure
```
backend/
  main.py              FastAPI app + endpoints
  services/
    rag.py             embeddings, FAISS index, chunking
    ocr.py             text extraction with OCR fallback
  requirements.txt
  Dockerfile
frontend/
  src/
    App.jsx            the UI
    App.css, index.css
  index.html
```