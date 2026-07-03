from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
import faiss
import torch
import time
import threading

_device = "cuda" if torch.cuda.is_available() else "cpu"
# the embedding model is read-only and expensive to load, so it is shared
# safely across all sessions.
embedding_model = SentenceTransformer("BAAI/bge-small-en-v1.5", device=_device)


def chunk_text(text):
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=500,
        chunk_overlap=100,
    )
    return splitter.split_text(text)


class Session:
    """Holds one user's private knowledge base and chat history."""

    def __init__(self):
        self.index = None
        self.chunks = []
        self.sources = []
        self.documents = []
        self.document_text = ""
        self.total_pages = 0
        self.chat_history = []
        self.last_seen = time.time()

    def touch(self):
        self.last_seen = time.time()

    def reset_index(self):
        self.index = None
        self.chunks = []
        self.sources = []
        self.documents = []
        self.document_text = ""
        self.total_pages = 0

    def add_document(self, chunks, source="document"):
        if not chunks:
            raise ValueError(
                "No text could be extracted from this PDF. If it is a scanned "
                "document, check that OCR ran (see logs)."
            )

        embeddings = embedding_model.encode(chunks, convert_to_numpy=True)
        if embeddings.ndim != 2 or embeddings.shape[0] == 0:
            raise ValueError(
                f"Embedding produced an unexpected shape {embeddings.shape}."
            )

        dimension = embeddings.shape[1]
        if self.index is None:
            self.index = faiss.IndexFlatL2(dimension)

        self.index.add(embeddings)
        self.chunks.extend(chunks)
        self.sources.extend([source] * len(chunks))
        if source not in self.documents:
            self.documents.append(source)
        return len(chunks)

    def search(self, query, k=6, sources=None):
        """Top-k chunks for the query; optionally restricted to the given
        source documents (fetches a wider net first, then filters)."""
        if self.index is None:
            raise Exception("No PDF indexed yet. Upload a PDF first.")

        query_embedding = embedding_model.encode([query], convert_to_numpy=True)
        total = len(self.chunks)
        fetch = min(total, max(k * 10, 60) if sources else k)
        distances, indices = self.index.search(query_embedding, fetch)

        results = []
        for i in indices[0]:
            if not 0 <= i < total:
                continue
            if sources and self.sources[i] not in sources:
                continue
            results.append({"text": self.chunks[i], "source": self.sources[i]})
            if len(results) >= k:
                break
        return results

    def list_documents(self):
        return list(self.documents)


# ---- session registry with idle expiry -------------------------------------

_sessions = {}
_lock = threading.Lock()
SESSION_TTL_SECONDS = 60 * 60          # drop sessions idle for > 60 minutes
MAX_SESSIONS = 300                     # hard cap: evict least-recently-used


def get_session(session_id):
    """Return the Session for this id, creating it if needed. Also reaps
    sessions that have been idle past the TTL to free memory."""
    now = time.time()
    with _lock:
        # reap idle sessions
        stale = [sid for sid, s in _sessions.items()
                 if now - s.last_seen > SESSION_TTL_SECONDS]
        for sid in stale:
            _sessions.pop(sid, None)

        sess = _sessions.get(session_id)
        if sess is None:
            # a flood of new session ids must not exhaust memory: each session
            # can hold a FAISS index, so evict the least-recently-used first
            while len(_sessions) >= MAX_SESSIONS:
                oldest = min(_sessions, key=lambda sid: _sessions[sid].last_seen)
                _sessions.pop(oldest, None)
            sess = Session()
            _sessions[session_id] = sess
        sess.touch()
        return sess


def drop_session(session_id):
    with _lock:
        _sessions.pop(session_id, None)


def session_count():
    with _lock:
        return len(_sessions)