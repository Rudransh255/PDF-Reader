import json
import re
import os
import tempfile
from services.ocr import extract_pdf_text
from fastapi import FastAPI, File, UploadFile, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from openai import OpenAI
from services.rag import (
    chunk_text,
    get_session,
    drop_session,
    session_count,
)

MAX_UPLOAD_BYTES = 100 * 1024 * 1024


def _sid(session_id):
    """Normalize a session id; fall back to a shared default if none sent
    (keeps the app working for clients that don't send one yet)."""
    return (session_id or "default").strip() or "default"

                                                                                 
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")

_groq = None


def _get_groq():
    global _groq
    if _groq is None:
        key = os.environ.get("GROQ_API_KEY", "")
        if not key:
            raise RuntimeError(
                "GROQ_API_KEY is not set. Set it before starting the server "
                "(e.g. $env:GROQ_API_KEY=\"gsk_...\" then run uvicorn)."
            )
        _groq = OpenAI(
            api_key=key,
            base_url="https://api.groq.com/openai/v1",
            timeout=30.0,      # fail fast instead of hanging if Groq is slow/down
            max_retries=2,
        )
    return _groq


def llm_chat(messages):
    """Send messages to Groq and return the assistant's text content."""
    resp = _get_groq().chat.completions.create(model=GROQ_MODEL, messages=messages)
    return resp.choices[0].message.content

import logging

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger("pdfbuddy")

app = FastAPI()
# per-user state now lives in sessions (see services/rag.py); no module globals.

# ---- lightweight per-IP rate limiting (in-memory, no extra deps) -----------
# expensive endpoints get tight limits; everything else shares a loose one.
# NOTE: X-Forwarded-For is only trustworthy behind a reverse proxy (nginx);
# direct-to-uvicorn deployments fall back to the socket address.
import threading as _threading
import time as _time
from collections import defaultdict, deque

_RATE_LIMITS = {
    "/chat": (20, 60),          # 20 requests / minute
    "/quiz": (10, 60),
    "/flashcards": (10, 60),
    "/upload": (10, 600),       # 10 uploads / 10 minutes
}
_DEFAULT_LIMIT = (120, 60)
_hits = defaultdict(deque)
_hits_lock = _threading.Lock()


# registered before CORSMiddleware is added, so CORS wraps it and 429
# responses still carry the CORS headers the browser needs to read them
@app.middleware("http")
async def _rate_limit(request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)
    fwd = request.headers.get("x-forwarded-for", "")
    ip = fwd.split(",")[0].strip() or (request.client.host if request.client else "unknown")
    path = request.url.path
    limit, window = _RATE_LIMITS.get(path, _DEFAULT_LIMIT)
    key = (ip, path if path in _RATE_LIMITS else "*")
    now = _time.time()
    with _hits_lock:
        dq = _hits[key]
        while dq and now - dq[0] > window:
            dq.popleft()
        if len(dq) >= limit:
            return JSONResponse(status_code=429,
                                content={"error": "Too many requests — please slow down and try again shortly."})
        dq.append(now)
        # keep the table itself from growing without bound
        if len(_hits) > 10000:
            for k in [k for k, d in _hits.items() if not d]:
                _hits.pop(k, None)
    return await call_next(request)


app.add_middleware(GZipMiddleware, minimum_size=500)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://pdf-buddy-red.vercel.app",
        "https://pdf-buddy.me",
        "https://www.pdf-buddy.me",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    # optional @-mention filter: restrict retrieval to these documents
    documents: list[str] = Field(default_factory=list, max_length=10)

class TopicRequest(BaseModel):
    topic: str = Field(default="", max_length=500)
    avoid: list[str] = Field(default_factory=list)

@app.get("/")
def home():
    return {"message": "Backend is running"}


@app.get("/health")
def health():
    return {"status": "ok"}

                                                                            
def _ask_json(prompt: str):
    """Call the LLM and return parsed JSON. Uses JSON mode + tolerant parsing."""
    try:
        resp = _get_groq().chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": "You output ONLY valid JSON. No markdown, no commentary."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.4,
        )
        raw = resp.choices[0].message.content
    except Exception as e:
        log.error("LLM call failed in _ask_json: %s", e)
        raise

    raw = (raw or "").strip()
    raw = re.sub(r"^```(json)?|```$", "", raw, flags=re.MULTILINE).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"[\[{].*[\]}]", raw, re.DOTALL)
        if match:
            return json.loads(match.group(0))
        log.error("Could not parse JSON from model output: %r", raw[:300])
        raise

def _context_for(sess, topic: str, k: int = 5):
    """Retrieve chunks. If a topic is given, search for it; else a generic query."""
    query = topic.strip() if topic and topic.strip() else "summary key concepts overview"
    hits = sess.search(query, k=k)
    return "\n\n".join(h["text"] for h in hits)


def _avoid_note(avoid, kind="questions"):
    if not avoid:
        return ""
    existing = "; ".join(str(a)[:300] for a in avoid[:20])
    return (
        f"\nDo NOT repeat or rephrase any of these existing {kind}; "
        f"write entirely new ones covering different points: {existing}\n"
    )


def _clean_questions(items):
    """Keep only well-formed MCQs so bad model output can't break the client."""
    out = []
    for q in items if isinstance(items, list) else []:
        if not isinstance(q, dict):
            continue
        text, opts, ans = q.get("question"), q.get("options"), q.get("answer")
        if not isinstance(text, str) or not text.strip():
            continue
        if not isinstance(opts, list) or len(opts) < 2:
            continue
        opts = [str(o) for o in opts]
        if not isinstance(ans, int) or not 0 <= ans < len(opts):
            continue
        out.append({"question": text.strip(), "options": opts, "answer": ans})
    return out


def _extract_sources_used(reply, known_sources):
    """Pull the trailing 'SOURCES_USED: ...' line off an LLM reply.

    Returns (cleaned_reply, used_list). used_list is None when the trailer is
    missing/unparseable (caller falls back to the retrieved-source list), and
    may be [] when the model states it used none."""
    if not reply:
        return reply, None
    lines = reply.rstrip().splitlines()
    # the trailer should be the last line, but tolerate one stray blank/extra line
    for i in range(len(lines) - 1, max(len(lines) - 3, -1), -1):
        m = re.match(r"\s*\**\s*sources?[_ ]used\s*\**\s*[::]\s*(.+)", lines[i], re.IGNORECASE)
        if not m:
            continue
        tail = m.group(1).lower()
        cleaned = "\n".join(lines[:i]).rstrip()
        if not cleaned:          # model sent only the trailer; keep original
            return reply, None
        used = [s for s in known_sources if s.lower() in tail]
        return cleaned, used
    return reply, None


def _clean_cards(items):
    out = []
    for c in items if isinstance(items, list) else []:
        if not isinstance(c, dict):
            continue
        q, a = c.get("question"), c.get("answer")
        if isinstance(q, str) and q.strip() and isinstance(a, str) and a.strip():
            out.append({"question": q.strip(), "answer": a.strip()})
    return out

                                                                           
import time
import uuid
import threading

# in-memory progress tracker: job_id -> {stage, pct, done, result/error, ts, sid}
_jobs = {}
JOB_TTL_SECONDS = 30 * 60
MAX_ACTIVE_JOBS = 4


def _reap_jobs():
    """Drop finished/abandoned jobs so the tracker can't grow forever."""
    now = time.time()
    for jid in [j for j, job in _jobs.items() if now - job.get("ts", 0) > JOB_TTL_SECONDS]:
        _jobs.pop(jid, None)


def _process_pdf_job(job_id, tmp_path, session_id, filename="document", replace=False):
    try:
        sess = get_session(session_id)
        _jobs[job_id].update({"stage": "Extracting text", "pct": 35})
        result = extract_pdf_text(tmp_path)

        method = result.get("method", "text")
        if method in ("ocr", "mixed"):
            _jobs[job_id].update({"stage": "Reading scanned pages (OCR)", "pct": 60})
        else:
            _jobs[job_id].update({"stage": "Text extracted", "pct": 60})

        sess.document_text = result["text"]

        _jobs[job_id].update({"stage": "Building search index", "pct": 80})
        chunks = chunk_text(sess.document_text)
        log.info("Extraction method: %s | OCR pages: %s | chunks: %d | source: %s",
                 result["method"], result.get("ocr_pages", 0), len(chunks), filename)

        # combined knowledge base for this session: add this doc (or replace all)
        if replace:
            sess.reset_index()
        sess.add_document(chunks, source=filename)
        sess.total_pages += result["pages"]

        _jobs[job_id].update({
            "stage": "Done", "pct": 100, "done": True, "error": None,
            "result": {
                "characters": len(sess.document_text),
                "pages": result["pages"],
                "total_pages": sess.total_pages,
                "method": result["method"],
                "ocr_pages": result.get("ocr_pages", 0),
                "warning": result.get("warning"),
                "documents": sess.list_documents(),
            },
        })
    except Exception as e:
        log.exception("Upload job failed")
        # our own ValueErrors carry user-friendly text; anything else stays internal
        msg = str(e) if isinstance(e, ValueError) else \
            "Could not process this PDF. It may be corrupted or password-protected."
        _jobs[job_id].update({"stage": "Error", "pct": 100, "done": True, "error": msg, "result": None})
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...), replace: bool = False,
                     x_session_id: str = Header(default=None)):
    suffix = os.path.splitext(file.filename or "")[1].lower() or ".pdf"
    if suffix != ".pdf":
        return JSONResponse(status_code=400, content={"error": "Only .pdf files are accepted."})

    total = 0
    first_chunk = True
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            if first_chunk:
                first_chunk = False
                # the PDF header must appear near the start of the file;
                # a renamed non-PDF fails here instead of deep in extraction
                if b"%PDF" not in chunk[:1024]:
                    tmp.close()
                    try:
                        os.remove(tmp.name)
                    except OSError:
                        pass
                    return JSONResponse(status_code=400, content={"error": "This file does not look like a PDF."})
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                tmp.close()
                try:
                    os.remove(tmp.name)
                except OSError:
                    pass
                return JSONResponse(status_code=413, content={"error": "File too large (max 100 MB)."})
            tmp.write(chunk)
        tmp_path = tmp.name

    if total == 0:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return JSONResponse(status_code=400, content={"error": "The uploaded file is empty."})

    fname = file.filename or "document"
    sid = _sid(x_session_id)
    _reap_jobs()

    # bound concurrent PDF processing: each job holds page images and runs
    # embeddings, so a burst of uploads must not be able to exhaust memory
    active = sum(1 for j in _jobs.values() if not j.get("done"))
    if active >= MAX_ACTIVE_JOBS:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return JSONResponse(status_code=429,
                            content={"error": "The server is busy processing other uploads. Please try again in a minute."})

    # start processing in a background thread; client polls /progress/{job_id}
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"stage": "Queued", "pct": 30, "done": False, "error": None, "result": None,
                     "ts": time.time(), "sid": sid}
    threading.Thread(target=_process_pdf_job, args=(job_id, tmp_path, sid, fname, replace), daemon=True).start()

    return {"job_id": job_id}


@app.get("/progress/{job_id}")
def upload_progress(job_id: str, x_session_id: str = Header(default=None)):
    job = _jobs.get(job_id)
    # jobs are only visible to the session that created them
    if not job or job.get("sid") != _sid(x_session_id):
        return JSONResponse(status_code=404, content={"error": "Unknown job id."})
    if job.get("done"):
        # final state has been delivered; free the slot
        _jobs.pop(job_id, None)
    return {k: v for k, v in job.items() if k not in ("ts", "sid")}

                                                                         
@app.post("/quiz")
def quiz_endpoint(req: TopicRequest = TopicRequest(), x_session_id: str = Header(default=None)):
    sess = get_session(_sid(x_session_id))
    if not sess.document_text:
        return {"questions": []}

    topic = (req.topic or "").strip()
    context = _context_for(sess, topic, k=5)

    focus = (
        f'Focus the questions on the topic: "{topic}" and closely related ideas '
        f"from the same section of the document.\n"
        if topic
        else "Cover the most important ideas in the content.\n"
    )

    avoid_note = _avoid_note(req.avoid, "questions")

    prompt = f"""
Using ONLY the content below, write 4 multiple-choice questions.
{focus}{avoid_note}Each question has exactly 4 options and one correct option.

Return JSON in this exact shape:
{{"questions": [
  {{"question": "...", "options": ["A","B","C","D"], "answer": 0}}
]}}
"answer" is the 0-based index of the correct option.

Content:
{context}
"""
    try:
        data = _ask_json(prompt)
        return {"questions": _clean_questions(data.get("questions")), "topic": topic}
    except Exception:
        log.exception("Quiz generation failed")
        return {"questions": [], "error": "Could not generate a quiz right now. Please try again."}

                                                                               
@app.post("/flashcards")
def flashcards_endpoint(req: TopicRequest = TopicRequest(), x_session_id: str = Header(default=None)):
    sess = get_session(_sid(x_session_id))
    if not sess.document_text:
        return {"cards": []}

    topic = (req.topic or "").strip()
    context = _context_for(sess, topic, k=5)

    focus = (
        f'Focus the cards on the topic: "{topic}" and closely related ideas '
        f"from the same section of the document.\n"
        if topic
        else "Cover the most important ideas in the content.\n"
    )

    avoid_note = _avoid_note(req.avoid, "cards")

    prompt = f"""
Using ONLY the content below, write 6 study flashcards.
{focus}{avoid_note}Each card has a short question and a concise answer.

Return JSON in this exact shape:
{{"cards": [{{"question": "...", "answer": "..."}}]}}

Content:
{context}
"""
    try:
        data = _ask_json(prompt)
        return {"cards": _clean_cards(data.get("cards")), "topic": topic}
    except Exception:
        log.exception("Flashcard generation failed")
        return {"cards": [], "error": "Could not generate flashcards right now. Please try again."}

                                                                         
@app.post("/chat")
def chat_endpoint(request: ChatRequest, x_session_id: str = Header(default=None)):
    sess = get_session(_sid(x_session_id))

    log.info("Chat question: %s", request.message)

    # only accept filters naming documents that actually exist in this session
    known = sess.list_documents()
    focus_docs = [d for d in request.documents if d in known]

    try:
        results = sess.search(request.message, k=6, sources=focus_docs or None)
    except Exception as e:
        return {"reply": str(e)}

    if focus_docs and not results:
        return {
            "reply": "I couldn't find anything relevant in "
                     + ", ".join(focus_docs)
                     + " for that question. Try rephrasing, or ask without the @mention to search all documents.",
            "sources": [],
        }

    log.debug("Retrieved %d chunks", len(results))

    # label each chunk with its source document so the model can attribute and
    # distinguish across multiple PDFs in the combined knowledge base
    context = "\n\n".join(f"[from: {h['source']}]\n{h['text']}" for h in results)
    source_names = []
    for h in results:
        if h["source"] not in source_names:
            source_names.append(h["source"])

    sess.chat_history.append({"role": "user", "content": request.message})
    sess.chat_history = sess.chat_history[-10:]

    messages = [
        {
            "role": "system",
            "content": f"""
You are a helpful assistant that answers questions about the user's uploaded PDF documents.

Use the document context below to answer. The context may contain several
relevant sections, possibly from DIFFERENT documents (each marked with its
source like "[from: filename]"). Read ALL of them before answering, and combine
information across sections when needed (for example, if the user asks for all
dates, times, or items, list every one you can find, not just the first).

Guidelines:
- Answer thoroughly and completely. Do not give a one-line answer when the
  documents contain more relevant detail.
- When information comes from different documents, you may mention which
  document it came from if that helps clarity.
- If information appears for multiple categories (e.g. different classes,
  subjects, or sections), clearly label which is which, and only include what
  the user asked for.
- Reply in the SAME language the user wrote their latest message in.
- If the answer is not in the context, say so plainly instead of guessing.
{f"- The user directed this question at: {', '.join(focus_docs)} (referenced with @ in their message). The context contains only those documents; answer from them." if focus_docs else ""}
- After your answer, add ONE final line, exactly in this form (it is removed
  before display, so never mention it in the answer itself):
  SOURCES_USED: <comma-separated filenames of the documents your answer actually drew from>
  Only list filenames that appear in the "[from: ...]" labels, and only those
  you truly used. If you used none, write: SOURCES_USED: none
- For mathematical expressions, use LaTeX: inline math in \\( ... \\) and block
  equations in \\[ ... \\].

Document context:
{context}
""",
        }
    ]
    messages.extend(sess.chat_history[-10:])

    try:
        reply = llm_chat(messages)
    except Exception as e:
        log.error("LLM call failed in /chat: %s", e)
        return {"reply": "The AI service is temporarily unavailable. Please try again in a moment.", "sources": source_names}

    # strip the SOURCES_USED trailer and use it to attribute the answer to the
    # documents actually used, not everything retrieval happened to surface
    reply, used = _extract_sources_used(reply, source_names)
    final_sources = used if used is not None else source_names

    sess.chat_history.append({"role": "assistant", "content": reply})

    return {"reply": reply, "sources": final_sources}


@app.post("/reset_chat")
def reset_chat(x_session_id: str = Header(default=None)):
    """Clear this session's conversation history."""
    sess = get_session(_sid(x_session_id))
    sess.chat_history = []
    return {"status": "cleared"}


@app.get("/documents")
def get_documents(x_session_id: str = Header(default=None)):
    """List the documents in this session's knowledge base."""
    sess = get_session(_sid(x_session_id))
    return {"documents": sess.list_documents(), "total_pages": sess.total_pages}


@app.post("/clear_documents")
def clear_documents(x_session_id: str = Header(default=None)):
    """Remove all documents from this session and clear its chat."""
    sess = get_session(_sid(x_session_id))
    sess.reset_index()
    sess.chat_history = []
    return {"status": "cleared", "documents": []}