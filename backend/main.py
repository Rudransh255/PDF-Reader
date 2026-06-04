from fastapi import FastAPI, File, UploadFile
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader
from ollama import chat

app = FastAPI()
document_text = ""


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

# @app.post("/chat")
# def chat_endpoint(request: ChatRequest):
#     return {
#         "reply": "Backend is working"
#     }
# 
from ollama import chat

# @app.post("/chat")  
# def chat_endpoint(request: ChatRequest):
    
#     response = chat(
#         model="qwen2.5:7b",
#         messages=[
#             {
#                 "role": "user",
#                 "content": "Say hello"
#             }
#         ]
#     )

#     print(response)

#     return {
#         "reply": response.message.content
#     }

    
    
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
    #print("PDF characters:", len(document_text))
            
    return {
         "Message": "PDF uploaded successfully",
         "characters": len(document_text)
}


# @app.post("/chat")
# def chat_endpoint(request: ChatRequest):
    
#     global document_text
    
#     prompt = f"""
# You are a PDF assistant.

# Answer ONLY from the document below.

# DOCUMENT:
# {document_text}

# QUESTION:
# {request.message}
# """

#     response = chat(
#          model="qwen2.5:7b",
#         messages=[
#             {
#                 "role": "user",
#                 "content": prompt   
#             }
#         ]
#     )
#     print(type(response))
#     print(response)

#     return {
#         "reply": str(response)
#     }

@app.post("/chat")
def chat_endpoint(request: ChatRequest):
    print("CHAT ROUTE EXECUTED")
    global document_text
    
    prompt = f"""
You are a PDF assistant.

Answer ONLY from the document below.

DOCUMENT:
{document_text}

QUESTION:
{request.message}
"""
    print("Document length in chat:", len(document_text))
    print("Question:", request.message)
    print(prompt[:500])
    response = chat(
        model="qwen2.5:7b",
        messages=[
            {
                "role": "user",
                "content": prompt
            }
        ]
    )
    print(response.message.content)
    return {
        "reply": response.message.content
    }