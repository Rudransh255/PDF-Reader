from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
import faiss
import torch

_device = "cuda" if torch.cuda.is_available() else "cpu"
embedding_model = SentenceTransformer("BAAI/bge-small-en-v1.5", device=_device)

index = None
stored_chunks = []
stored_sources = []
documents = []


def chunk_text(text):
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=500,
        chunk_overlap=100,
    )
    return splitter.split_text(text)


def reset_index():
    global index, stored_chunks, stored_sources, documents
    index = None
    stored_chunks = []
    stored_sources = []
    documents = []


def add_document(chunks, source="document"):
    """Add a document's chunks to the combined index, tracking their source."""
    global index, stored_chunks, stored_sources, documents

    if not chunks:
        raise ValueError(
            "No text could be extracted from this PDF. If it is a scanned "
            "document, make sure the /upload route uses extract_pdf_text (OCR) "
            "and check the logs for 'OCR fallback page'."
        )

    embeddings = embedding_model.encode(chunks, convert_to_numpy=True)

    if embeddings.ndim != 2 or embeddings.shape[0] == 0:
        raise ValueError(
            f"Embedding produced an unexpected shape {embeddings.shape}; "
            "expected a 2D array. Got no usable chunks."
        )

    dimension = embeddings.shape[1]
    if index is None:
        index = faiss.IndexFlatL2(dimension)

    index.add(embeddings)
    stored_chunks.extend(chunks)
    stored_sources.extend([source] * len(chunks))
    if source not in documents:
        documents.append(source)

    return len(chunks)


def build_index(chunks, source="document"):
    """Backwards-compatible single-document build: clears then adds one doc."""
    reset_index()
    return add_document(chunks, source=source)


def search(query, k=6):
    if index is None:
        raise Exception("No PDF indexed yet. Upload a PDF first.")

    query_embedding = embedding_model.encode([query], convert_to_numpy=True)
    k = min(k, len(stored_chunks))
    distances, indices = index.search(query_embedding, k)

    results = []
    for i in indices[0]:
        if 0 <= i < len(stored_chunks):
            results.append({"text": stored_chunks[i], "source": stored_sources[i]})
    return results


def list_documents():
    return list(documents)