from fastapi import FastAPI, File, UploadFile
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader

app = FastAPI()

# CORS Middleware
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

@app.post("/chat")
def chat(request: ChatRequest):
    return {
        "reply": f"You said: {request.message}"
    }
    
    
@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    
    pdf = PdfReader(file.file)
    
    text = ""
    
    for page in pdf.pages:
        page_text = page.extract_text()
        
        if page_text:
            text += page_text + "\n"
            
    return {
         "filename": file.filename,
         "text": text[:1000]
}