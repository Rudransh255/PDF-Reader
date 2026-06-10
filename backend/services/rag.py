from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
import faiss
import numpy as np

embedding_model = SentenceTransformer("BAAI/bge-small-en-v1.5",device = "cuda")
 
index = None
stored_chunks = []


def chunk_text(text):
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=100,
        chunk_overlap=20
    )

    return splitter.split_text(text)


def build_index(chunks):
    global index
    global stored_chunks

    embeddings = embedding_model.encode(chunks, convert_to_numpy=True)

    dimension = embeddings.shape[1]

    index = faiss.IndexFlatL2(dimension)

    index.add(embeddings)

    stored_chunks = chunks


def search(query, k=3):

    
    if index is None:
        raise Exception("No PDF indexed yes, Upload a PDF first")
    
    
    query_embedding = embedding_model.encode([query], convert_to_numpy=True)

    distances, indices = index.search(query_embedding, k)
    

    return [
        stored_chunks[i]
        for i in indices[0]
    ]