import json
import re
import os
import tempfile
from services.ocr import extract_pdf_text
from fastapi import FastAPI, File, UploadFile
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader
from ollama import chat
from sentence_transformers import SentenceTransformer
from services.rag import (
    chunk_text,
    build_index,
    search,
    index
)


app = FastAPI()
document_text = ""
chat_history = []

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    message: str

@app.get("/")
def home():
    return {"message": "Backend is running"}

class TopicRequest(BaseModel):
    topic: str = ""
 
 
def _ask_json(prompt: str):
    response = chat(
        model="qwen2.5:7b",
        messages=[
            {"role": "system", "content": "You output ONLY valid JSON. No markdown, no commentary."},
            {"role": "user", "content": prompt},
        ],
    )
    raw = response.message.content
    raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    match = re.search(r"[\[{].*[\]}]", raw, re.DOTALL)
    return json.loads(match.group(0) if match else raw)
 
 
def _context_for(topic: str, k: int = 5):
    """Retrieve chunks. If a topic is given, search for it; else a generic query."""
    query = topic.strip() if topic and topic.strip() else "summary key concepts overview"
    return "\n\n".join(search(query, k=k))
 
 
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

    
# @app.post("/upload")
# async def upload_pdf(file: UploadFile = File(...)):
    
#     global document_text
    
    
#     pdf = PdfReader(file.file)
    
#     text = ""
    
#     for page in pdf.pages:
#         page_text = page.extract_text()
        
#         if page_text:
#             text += page_text + "\n"
    
#     document_text = text

    
#     print("FAISS index built successfully")
#     chunks = chunk_text(document_text)
    
#     print("Total Chunks",len(chunks))
    
#     build_index(chunks)
            
#     return {
#          "Message": "PDF uploaded successfully",
#          "characters": len(document_text)
# }


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    global document_text
 
    # save to a temp file so OCR/pdf2image can read it by path
    suffix = os.path.splitext(file.filename or "")[1] or ".pdf"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
 
    try:
        result = extract_pdf_text(tmp_path)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
 
    document_text = result["text"]
 
    chunks = chunk_text(document_text)
    print(f"Extraction method: {result['method']} | OCR pages: {result.get('ocr_pages', 0)}")
    print("Total Chunks", len(chunks))
    build_index(chunks)
 
    return {
        "Message": "PDF uploaded successfully",
        "characters": len(document_text),
        "pages": result["pages"],
        "method": result["method"],          # "text" | "ocr" | "mixed" | "empty"
        "ocr_pages": result.get("ocr_pages", 0),
        "warning": result.get("warning"),
    }
 






def _ask_json(prompt: str):
    """Call qwen and pull the first JSON object/array out of the reply."""
    response = chat(
        model="qwen2.5:7b",
        messages=[
            {
                "role": "system",
                "content": "You output ONLY valid JSON. No markdown, no commentary.",
            },
            {"role": "user", "content": prompt},
        ],
    )
    raw = response.message.content
    # strip code fences if the model adds them anyway
    raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    match = re.search(r"[\[{].*[\]}]", raw, re.DOTALL)
    return json.loads(match.group(0) if match else raw)
 
 
@app.post("/quiz")
def quiz_endpoint():
    if not document_text:
        return {"questions": []}
 
    # pull a few representative chunks as grounding
    context = "\n\n".join(search("summary key concepts", k=4))
 
    prompt = f"""
Using ONLY the content below, write 4 multiple-choice questions.
Each question has exactly 4 options and one correct option.
 
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
        return {"questions": data.get("questions", [])}
    except Exception as e:
        return {"questions": [], "error": str(e)}
 
 
@app.post("/flashcards")
def flashcards_endpoint():
    if not document_text:
        return {"cards": []}
 
    context = "\n\n".join(search("summary key concepts", k=4))
 
    prompt = f"""
Using ONLY the content below, write 6 study flashcards.
Each card has a short question and a concise answer.
 
Return JSON in this exact shape:
{{"cards": [{{"question": "...", "answer": "..."}}]}}
 
Content:
{context}
"""
    try:
        data = _ask_json(prompt)
        return {"cards": data.get("cards", [])}
    except Exception as e:
        return {"cards": [], "error": str(e)}
 


@app.post("/chat")
def chat_endpoint(request: ChatRequest):

    global chat_history

    print("CHAT ROUTE EXECUTED")
    print("\nQuestion:", request.message)

    try:
        results = search(request.message, k=2)

    except Exception as e:
        return {
            "reply": str(e)
        }

    print("\nRetrieved Chunks:")

    for chunk in results:
        print("-" * 50)
        print(chunk)

    context = "\n\n".join(results)

    
    chat_history.append({
        "role": "user",
        "content": request.message
    })
    chat_history = chat_history[-10:]

    
    messages = [
        {
            "role": "system",
            "content": f"""
You are a PDF assistant.

Use the conversation history and the provided context.

Context:
{context}

Rules:
- Answer only from the context.
- Do not use LaTeX.
- Write equations in plain text.
"""
        }
    ]

  
    messages.extend(chat_history[-10:])

    print("\nCHAT HISTORY SENT TO QWEN:")
    for msg in messages:
        print(msg)

    response = chat(
        model="qwen2.5:7b",
        messages=messages
    )

    # Save assistant response
    chat_history.append({
        "role": "assistant",
        "content": response.message.content
    })

    print("\nCurrent Chat History:")
    print(chat_history)

    
    return {
        "reply": response.message.content,
        "sources": results
    }