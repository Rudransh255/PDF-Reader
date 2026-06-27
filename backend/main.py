import json
import re
import os
import tempfile
from services.ocr import extract_pdf_text
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from openai import OpenAI
from services.rag import (
    chunk_text,
    build_index,
    search,
)

MAX_UPLOAD_BYTES = 60 * 1024 * 1024         

                                                                                 
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
document_text = ""
chat_history = []

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

def _context_for(topic: str, k: int = 5):
    """Retrieve chunks. If a topic is given, search for it; else a generic query."""
    query = topic.strip() if topic and topic.strip() else "summary key concepts overview"
    return "\n\n".join(search(query, k=k))

                                                                           
import uuid
import threading

# in-memory progress tracker: job_id -> {stage, pct, done, result/error}
_jobs = {}


def _process_pdf_job(job_id, tmp_path):
    global document_text
    try:
        _jobs[job_id] = {"stage": "Extracting text", "pct": 35, "done": False, "error": None, "result": None}
        result = extract_pdf_text(tmp_path)

        method = result.get("method", "text")
        if method in ("ocr", "mixed"):
            _jobs[job_id].update({"stage": "Reading scanned pages (OCR)", "pct": 60})
        else:
            _jobs[job_id].update({"stage": "Text extracted", "pct": 60})

        document_text = result["text"]

        _jobs[job_id].update({"stage": "Building search index", "pct": 80})
        chunks = chunk_text(document_text)
        log.info("Extraction method: %s | OCR pages: %s | chunks: %d",
                 result["method"], result.get("ocr_pages", 0), len(chunks))
        build_index(chunks)

        _jobs[job_id] = {
            "stage": "Done", "pct": 100, "done": True, "error": None,
            "result": {
                "characters": len(document_text),
                "pages": result["pages"],
                "method": result["method"],
                "ocr_pages": result.get("ocr_pages", 0),
                "warning": result.get("warning"),
            },
        }
    except Exception as e:
        log.error("Upload job failed: %s", e)
        _jobs[job_id] = {"stage": "Error", "pct": 100, "done": True, "error": str(e), "result": None}
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    suffix = os.path.splitext(file.filename or "")[1].lower() or ".pdf"
    if suffix != ".pdf":
        return JSONResponse(status_code=400, content={"error": "Only .pdf files are accepted."})

    total = 0
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                tmp.close()
                try:
                    os.remove(tmp.name)
                except OSError:
                    pass
                return JSONResponse(status_code=413, content={"error": "File too large (max 60 MB)."})
            tmp.write(chunk)
        tmp_path = tmp.name

    # start processing in a background thread; client polls /progress/{job_id}
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"stage": "Queued", "pct": 30, "done": False, "error": None, "result": None}
    threading.Thread(target=_process_pdf_job, args=(job_id, tmp_path), daemon=True).start()

    return {"job_id": job_id}


@app.get("/progress/{job_id}")
def upload_progress(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        return JSONResponse(status_code=404, content={"error": "Unknown job id."})
    return job

                                                                         
@app.post("/quiz")
def quiz_endpoint(req: TopicRequest = TopicRequest()):
    if not document_text:
        return {"questions": []}

    topic = (req.topic or "").strip()
    context = _context_for(topic, k=5)

    focus = (
        f'Focus the questions on the topic: "{topic}" and closely related ideas '
        f"from the same section of the document.\n"
        if topic
        else "Cover the most important ideas in the content.\n"
    )

    prompt = f"""
Using ONLY the content below, write 4 multiple-choice questions.
{focus}Each question has exactly 4 options and one correct option.

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
        return {"questions": data.get("questions", []), "topic": topic}
    except Exception as e:
        return {"questions": [], "error": str(e)}

                                                                               
@app.post("/flashcards")
def flashcards_endpoint(req: TopicRequest = TopicRequest()):
    if not document_text:
        return {"cards": []}

    topic = (req.topic or "").strip()
    context = _context_for(topic, k=5)

    focus = (
        f'Focus the cards on the topic: "{topic}" and closely related ideas '
        f"from the same section of the document.\n"
        if topic
        else "Cover the most important ideas in the content.\n"
    )

    prompt = f"""
Using ONLY the content below, write 6 study flashcards.
{focus}Each card has a short question and a concise answer.

Return JSON in this exact shape:
{{"cards": [{{"question": "...", "answer": "..."}}]}}

Content:
{context}
"""
    try:
        data = _ask_json(prompt)
        return {"cards": data.get("cards", []), "topic": topic}
    except Exception as e:
        return {"cards": [], "error": str(e)}

                                                                         
@app.post("/chat")
def chat_endpoint(request: ChatRequest):
    global chat_history

    log.info("Chat question: %s", request.message)

    try:
        results = search(request.message, k=6)
    except Exception as e:
        return {"reply": str(e)}

    log.debug("Retrieved %d chunks", len(results))

    context = "\n\n".join(results)

    chat_history.append({"role": "user", "content": request.message})
    chat_history = chat_history[-10:]

    messages = [
        {
            "role": "system",
            "content": f"""
You are a helpful assistant that answers questions about the user's PDF document.

Use the document context below to answer. The context may contain several
relevant sections — read ALL of them before answering, and combine information
from multiple sections when needed (for example, if the user asks for all dates,
times, or items, list every one you can find across the context, not just the
first).

Guidelines:
- Answer thoroughly and completely. Do not give a one-line answer when the
  document contains more relevant detail.
- If information appears for multiple categories (e.g. different classes,
  subjects, or sections), clearly label which is which, and only include what
  the user asked for.
- Reply in the SAME language the user wrote their latest message in. If the user
  writes in English, answer in English; if in Hindi, answer in Hindi.
- If the answer is not in the context, say so plainly instead of guessing.
- For mathematical expressions, use LaTeX: inline math in \\( ... \\) and block
  equations in \\[ ... \\].

Document context:
{context}
""",
        }
    ]
    messages.extend(chat_history[-10:])

    try:
        reply = llm_chat(messages)
    except Exception as e:
        log.error("LLM call failed in /chat: %s", e)
        return {"reply": "The AI service is temporarily unavailable. Please try again in a moment.", "sources": results}

    chat_history.append({"role": "assistant", "content": reply})

    return {"reply": reply, "sources": results}


@app.post("/reset_chat")
def reset_chat():
    """Clear the server-side conversation history."""
    global chat_history
    chat_history = []
    return {"status": "cleared"}