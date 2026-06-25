# PDF Buddy

An AI-powered PDF study companion. Upload a PDF (digital or scanned) and chat
with it, generate quizzes and flashcards from its content, and keep notes — all
in one workspace.

> **Scope:** This is a single-user demo / portfolio project. It keeps document
> and chat state in memory on the server, so it is intended for one user at a
> time (local use or a personal demo deployment), not multi-user production.

---

## Features

- **Chat with your PDF** — ask questions and get answers grounded in the
  document, using retrieval-augmented generation (RAG).
- **Scanned PDF support (OCR)** — image-only PDFs are run through OCR
  automatically, so scanned notes and handwritten-style scans work too.
- **Math rendering** — answers containing LaTeX are rendered as formatted
  equations via KaTeX.
- **Quiz Me** — generates multiple-choice questions from the document, with
  instant right/wrong feedback. Topic-aware based on your last question.
- **Flashcards** — generates two-sided flip cards for study. Also topic-aware.
- **Notebook** — a rich-text notebook with bold/italic/highlight/bullets, image
  insertion (with lightbox preview), and one-click saving of any quiz,
  flashcard, AI answer, or image. Persists in the browser.

---

## Tech stack

**Frontend** — React + Vite. Notebook text persists in `localStorage`; images
persist in `IndexedDB` (larger quota). Math via KaTeX.

**Backend** — FastAPI (Python).
- RAG: `sentence-transformers` (BAAI/bge-small-en-v1.5) for embeddings +
  FAISS for vector search.
- LLM: Groq API (default model `llama-3.3-70b-versatile`), OpenAI-compatible.
- OCR: Tesseract + Poppler, via `pytesseract` and `pdf2image`.

---

## Local setup

### Prerequisites
- Python 3.11+ and Node.js 18+
- **Tesseract OCR** and **Poppler** installed as system binaries and on PATH
  (needed for scanned-PDF OCR). See `OCR_SETUP.md` for details.
- A free **Groq API key** from https://console.groq.com

### Backend
```bash
cd backend
python -m venv venv
venv\Scripts\activate           # Windows  (use: source venv/bin/activate on macOS/Linux)
pip install -r requirements.txt

# set your Groq key (Windows, permanent):
setx GROQ_API_KEY "gsk_your_key"   # then reopen the terminal
# or for one session (PowerShell):  $env:GROQ_API_KEY="gsk_your_key"

uvicorn main:app --reload
```
Backend runs at http://127.0.0.1:8000

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Frontend runs at http://127.0.0.1:5173 — open it in your browser.

---

## Deployment

Designed to deploy free: backend on Render (Docker), frontend on Vercel, LLM on
Groq's free tier. See `DEPLOY.md` for step-by-step instructions.

Set `GROQ_API_KEY` as an environment variable on the host — never commit it.

---

## Notes & limitations

- **Single shared state.** The backend stores the active document, chat history,
  and search index in module-level globals. All requests share them, so it
  supports one user/document at a time. Per-session state would be required for
  real multi-user use.
- **OCR threshold.** Scanned pages are binarized (grayscale → hard black/white
  threshold) before OCR, which is what makes Tesseract reliably read real scans.
  The threshold lives in `backend/services/ocr.py` if you need to tune it for
  unusually light or dark scans.
- **Image persistence is per-browser.** Notebook images are stored in the
  browser's IndexedDB, so they don't sync across browsers or devices.

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
    App.jsx            the whole UI
    App.css, index.css
  index.html
```