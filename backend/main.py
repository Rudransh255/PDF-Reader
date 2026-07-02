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

# in-memory progress tracker: job_id -> {stage, pct, done, result/error, ts}
_jobs = {}
JOB_TTL_SECONDS = 30 * 60


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

        _jobs[job_id].update({
            "stage": "Done", "pct": 100, "done": True, "error": None,
            "result": {
                "characters": len(sess.document_text),
                "pages": result["pages"],
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
    # start processing in a background thread; client polls /progress/{job_id}
    _reap_jobs()
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"stage": "Queued", "pct": 30, "done": False, "error": None, "result": None,
                     "ts": time.time()}
    threading.Thread(target=_process_pdf_job, args=(job_id, tmp_path, sid, fname, replace), daemon=True).start()

    return {"job_id": job_id}


@app.get("/progress/{job_id}")
def upload_progress(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        return JSONResponse(status_code=404, content={"error": "Unknown job id."})
    if job.get("done"):
        # final state has been delivered; free the slot
        _jobs.pop(job_id, None)
    return {k: v for k, v in job.items() if k != "ts"}

                                                                         
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

    try:
        results = sess.search(request.message, k=6)
    except Exception as e:
        return {"reply": str(e)}

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

    sess.chat_history.append({"role": "assistant", "content": reply})

    return {"reply": reply, "sources": source_names}


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
    return {"documents": sess.list_documents()}


@app.post("/clear_documents")
def clear_documents(x_session_id: str = Header(default=None)):
    """Remove all documents from this session and clear its chat."""
    sess = get_session(_sid(x_session_id))
    sess.reset_index()
    sess.chat_history = []
    return {"status": "cleared", "documents": []}