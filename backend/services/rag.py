from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
import faiss
import torch

                                                              
_device = "cuda" if torch.cuda.is_available() else "cpu"
embedding_model = SentenceTransformer("BAAI/bge-small-en-v1.5", device=_device)

index = None
stored_chunks = []

def chunk_text(text):
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=500,
        chunk_overlap=100,
    )
    return splitter.split_text(text)

def build_index(chunks):
    global index
    global stored_chunks

    if not chunks:
        index = None
        stored_chunks = []
        raise ValueError(
            "No text could be extracted from this PDF. If it is a scanned "
            "document, make sure the /upload route uses extract_pdf_text (OCR) "
            "and check the logs for 'OCR fallback page'."
        )

    embeddings = embedding_model.encode(chunks, convert_to_numpy=True)

    if embeddings.ndim != 2 or embeddings.shape[0] == 0:
        index = None
        stored_chunks = []
        raise ValueError(
            f"Embedding produced an unexpected shape {embeddings.shape}; "
            "expected a 2D array. Got no usable chunks."
        )

    dimension = embeddings.shape[1]
    index = faiss.IndexFlatL2(dimension)
    index.add(embeddings)
    stored_chunks = chunks

def search(query, k=3):
    if index is None:
        raise Exception("No PDF indexed yet. Upload a PDF first.")

    query_embedding = embedding_model.encode([query], convert_to_numpy=True)
    distances, indices = index.search(query_embedding, k)

    return [stored_chunks[i] for i in indices[0]]