<div align="center">

# 📚 PDF Buddy

**Upload any PDF — digital or scanned — then chat with it, generate quizzes and flashcards, and take notes. All in one place.**

🌐 **Live:** [pdf-buddy.me](https://pdf-buddy.me)

</div>

---

## What it does

PDF Buddy turns any PDF into an interactive study companion. Drop in a
document and you can ask it questions, test yourself with auto-generated
quizzes and flashcards, and keep everything you learn in a built-in notebook.
It reads scanned and photographed PDFs too, thanks to built-in OCR.

## Features

- **Chat with your PDFs** — ask questions and get answers grounded in the
  document text, powered by retrieval-augmented generation (RAG). Answers cite
  which document they came from.
- **Multi-PDF knowledge base** — upload several PDFs and ask questions across
  all of them at once.
- **Scanned-PDF support (OCR)** — image-only and photographed PDFs are read
  automatically with Tesseract OCR.
- **Markdown & math rendering** — answers render formatted text and LaTeX
  equations (via KaTeX), so technical material reads cleanly.
- **Quiz Me** — generates multiple-choice questions from your document with
  instant feedback. Topic-aware, and you can keep generating more.
- **Flashcards** — auto-generated two-sided flip cards for active recall, also
  topic-aware and extendable.
- **Notebook** — rich-text notes with bold/italic/highlight/lists, one-click
  saving of any quiz, flashcard, answer, or image, image insertion with
  preview, and export to PDF.
- **Real-time upload progress** — per-stage feedback (uploading → extracting →
  OCR → indexing) while your document is processed.

## Tech stack

| Layer     | Technology                                                  |
|-----------|-------------------------------------------------------------|
| Frontend  | React, Vite, marked (Markdown), KaTeX (math), IndexedDB     |
| Backend   | FastAPI, Uvicorn                                            |
| RAG       | sentence-transformers (BAAI/bge-small-en-v1.5), FAISS       |
| LLM       | Groq API (openai/gpt-oss-120b)                              |
| OCR       | Tesseract, Poppler                                          |
| Hosting   | Vercel (frontend), DigitalOcean + Docker + Caddy (backend)  |

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

The backend runs as a Docker container on a DigitalOcean Droplet, fronted by
Caddy (which provides automatic HTTPS via Let's Encrypt). The frontend is a
static Vite build on Vercel. The Groq API key is supplied as an environment
variable and never committed.

## How it works

1. **Upload** — the PDF is streamed to the backend. Each page's text layer is
   extracted; any page with little or no text is rendered to an image and run
   through OCR.
2. **Index** — extracted text is split into overlapping chunks, embedded with a
   sentence-transformer model, and stored in a FAISS vector index, with each
   chunk tagged by its source document.
3. **Ask** — your question is embedded and matched against the index; the most
   relevant chunks (across all uploaded PDFs) are passed to the LLM, which
   answers using only that context and tells you which documents it drew from.

## Local setup

### Prerequisites
- Python 3.11+ and Node.js 18+
- **Tesseract OCR** and **Poppler** installed and on your PATH (for scanned-PDF OCR)
- A free **Groq API key** from [console.groq.com](https://console.groq.com)

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# set your Groq key:
export GROQ_API_KEY="gsk_your_key"        # Windows (PowerShell): $env:GROQ_API_KEY="gsk_your_key"
# optionally choose the model (defaults shown):
export GROQ_MODEL="openai/gpt-oss-120b"

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
  -e GROQ_MODEL="openai/gpt-oss-120b" \
  --name pdfbuddy pdf-buddy
```
Caddy proxies `api.pdf-buddy.me` → `127.0.0.1:8000` and manages TLS automatically.

**Frontend** is deployed on Vercel as a static Vite build; pushes to `main`
trigger an automatic redeploy.

## Project structure
```
backend/
  main.py              FastAPI app + endpoints
  services/
    rag.py             embeddings, FAISS index, chunking, source tracking
    ocr.py             text extraction with OCR fallback
  requirements.txt
  Dockerfile
frontend/
  src/
    App.jsx            the UI
    App.css, index.css
  index.html
```

## Roadmap

- **Per-session isolation** — give each user their own private knowledge base
  and chat so multiple people can use the app simultaneously without overlap.
- **Page-number citations** — show the source page for each answer, not just
  the document name.
- **Streaming responses** — stream answers token-by-token for faster-feeling
  replies.

## Notes & limitations

- **Shared state (current).** The backend keeps the document index and chat
  history in memory, shared across requests. This suits single-user or demo use;
  per-session isolation (see roadmap) is needed before heavy concurrent use.
- **In-memory storage.** Documents and the index live in RAM, so a backend
  restart clears them. Notebook text and images persist in the browser
  (localStorage + IndexedDB).
- **OCR preprocessing.** Scanned pages are converted to grayscale and
  thresholded to black/white before OCR — this is what makes Tesseract read
  real-world scans reliably. The threshold is tunable in `backend/services/ocr.py`.

---

<div align="center">
Built with FastAPI, React, FAISS, and Groq.
</div>