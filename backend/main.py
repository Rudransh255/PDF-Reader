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


    
@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    
    global document_text
    
    
    pdf = PdfReader(file.file)
    
    text = ""
    
    for page in pdf.pages:
        page_text = page.extract_text()
        
        if page_text:
            text += page_text + "\n"
    
    document_text = text

    
    print("FAISS index built successfully")
    chunks = chunk_text(document_text)
    
    print("Total Chunks",len(chunks))
    
    build_index(chunks)
            
    return {
         "Message": "PDF uploaded successfully",
         "characters": len(document_text)
}



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