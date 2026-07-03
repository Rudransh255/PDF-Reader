import { useState, useRef, useEffect } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import "./App.css";
const API = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
const SID_KEY = "pdfBuddySessionId";
function getSessionId() {
  try {
    let id = localStorage.getItem(SID_KEY);
    if (!id) {
      id = crypto.randomUUID && crypto.randomUUID() || Date.now().toString(36) + Math.random().toString(36).slice(2);
      localStorage.setItem(SID_KEY, id);
    }
    return id;
  } catch {
    return "default";
  }
}
const SESSION_ID = getSessionId();
const withSession = (opts = {}) => ({
  ...opts,
  headers: {
    ...(opts.headers || {}),
    "X-Session-Id": SESSION_ID
  }
});
const LS_KEY = "pdfBuddyNotebook";
const loadSaved = () => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
const _persisted = typeof window !== "undefined" ? loadSaved() : null;
const LS_CHAT = "pdfBuddyChat";
const loadChat = () => {
  try {
    const raw = localStorage.getItem(LS_CHAT);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
const _persistedChat = typeof window !== "undefined" ? loadChat() : null;
let _idc = 0;
const newId = () => `${Date.now()}-${_idc++}-${Math.random().toString(36).slice(2, 6)}`;
// migration: freeform notes written before the composer existed become a
// regular note block so the content stays visible and editable
const _initialItems = (() => {
  const items = _persisted?.items ?? [];
  const legacy = _persisted?.notes;
  if (legacy && legacy.replace(/<[^>]*>/g, "").trim()) {
    return [...items, {
      id: newId(),
      type: "note",
      html: legacy
    }];
  }
  return items;
})();
const richHostOf = node => {
  if (!node) return null;
  const el = node.nodeType === 3 ? node.parentNode : node;
  return el?.closest?.(".rich-edit") || null;
};
const highlightNodeAt = () => {
  const sel = window.getSelection();
  let node = sel && sel.anchorNode;
  const host = richHostOf(node);
  if (!host) return null;
  while (node && node !== host) {
    if (node.nodeType === 1) {
      if (node.tagName === "MARK") return node;
      const bg = node.style?.backgroundColor || "";
      if (bg && bg !== "transparent" && !/rgba?\([^)]*,\s*0\s*\)/.test(bg)) return node;
    }
    node = node.parentNode;
  }
  return null;
};
const inHighlight = () => !!highlightNodeAt();
const safeState = cmd => {
  try {
    return document.queryCommandState(cmd);
  } catch {
    return false;
  }
};
const readFormats = () => ({
  bold: safeState("bold"),
  italic: safeState("italic"),
  bullets: safeState("insertUnorderedList"),
  highlight: inHighlight()
});
const IDB_NAME = "pdfBuddyImages";
const IDB_STORE = "images";
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPutImage(id, dataUrl) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(dataUrl, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGetImage(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function idbDeleteImage(id) {
  const db = await idbOpen();
  return new Promise(resolve => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
marked.setOptions({
  gfm: true,
  breaks: true
});
function mdToHtml(src) {
  try {
    return marked.parse(src || "");
  } catch {
    return src || "";
  }
}
const MATH_DELIMITERS = [{
  left: "\\[",
  right: "\\]",
  display: true
}, {
  left: "\\(",
  right: "\\)",
  display: false
}, {
  left: "$$",
  right: "$$",
  display: true
}];
// markdown → sanitized HTML with math rendered (for print/export output);
// falls back to raw delimiters when KaTeX hasn't loaded
function mdBlock(src) {
  const div = document.createElement("div");
  div.innerHTML = DOMPurify.sanitize(mdToHtml(src || ""));
  if (window.renderMathInElement) {
    try {
      window.renderMathInElement(div, {
        delimiters: MATH_DELIMITERS,
        throwOnError: false
      });
    } catch {}
  }
  return div.innerHTML;
}
function MathText({
  text
}) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = DOMPurify.sanitize(mdToHtml(text || ""));
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(el, {
          delimiters: MATH_DELIMITERS,
          throwOnError: false
        });
      } catch {}
    }
  }, [text]);
  return <div ref={ref} className="mathtext" />;
}
export default function App() {
  const [file, setFile] = useState(null);
  const [pdfLoaded, setPdfLoaded] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [uploadStatus, setUploadStatus] = useState("No PDF loaded");
  const [docs, setDocs] = useState([]);
  const [uploadError, setUploadError] = useState(false);
  const [uploadPct, setUploadPct] = useState(null);
  const [helperTab, setHelperTab] = useState("quiz");
  const [mobileView, setMobileView] = useState("chat");
  const [quiz, setQuiz] = useState([]);
  const [quizLoading, setQuizLoading] = useState(false);
  const [picked, setPicked] = useState({});
  const [cards, setCards] = useState([]);
  const [cardLoading, setCardLoading] = useState(false);
  const [flippedCards, setFlippedCards] = useState(new Set());
  const toggleFlip = key => {
    setFlippedCards(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const showToast = msg => {
    setToast(msg);
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(""), 1800);
  };
  const [chat, setChat] = useState(_persistedChat?.chat ?? []);
  const [chatLoading, setChatLoading] = useState(false);
  const [mention, setMention] = useState(null);
  const chatInputRef = useRef(null);
  const [lastQuestion, setLastQuestion] = useState(_persistedChat?.lastQuestion ?? "");
  const [staleChat, setStaleChat] = useState((_persistedChat?.chat ?? []).length > 0);
  const [notebookTitle, setNotebookTitle] = useState(_persisted?.title ?? "Research Notebook");
  const [activeFormats, setActiveFormats] = useState({});
  const [savedItems, setSavedItems] = useState(_initialItems);
  const [editingId, setEditingId] = useState(null);
  const [menuPos, setMenuPos] = useState(null);
  const composerRef = useRef(null);
  const imageInputRef = useRef(null);
  const chatEndRef = useRef(null);
  const pdfInputRef = useRef(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({
      behavior: "smooth"
    });
  }, [chat, chatLoading]);
  useEffect(() => {
    // the backend session outlives a page refresh: restore its document list
    // so the UI matches what the server will actually answer from
    (async () => {
      try {
        const r = await fetch(`${API}/documents`, withSession());
        if (!r.ok) return;
        const data = await r.json();
        if (data.documents?.length) {
          setDocs(data.documents);
          setPdfLoaded(true);
          if (data.total_pages) setPageCount(data.total_pages);
          setUploadStatus(data.documents.length === 1
            ? `${data.documents[0]} · restored from your session`
            : `${data.documents.length} documents · restored from your session`);
          setStaleChat(false);
        }
      } catch {}
    })();
  }, []);
  const [lightbox, setLightbox] = useState(null);
  useEffect(() => {
    try {
      const itemsForStorage = savedItems.map(it => it.type === "image" ? {
        id: it.id,
        type: "image",
        name: it.name,
        imgId: it.imgId
      } : it);
      localStorage.setItem(LS_KEY, JSON.stringify({
        title: notebookTitle,
        items: itemsForStorage
      }));
    } catch (e) {
      console.warn("Could not save notebook to localStorage:", e);
    }
  }, [notebookTitle, savedItems]);
  useEffect(() => {
    const imageItems = (_persisted?.items ?? []).filter(it => it.type === "image" && it.imgId);
    if (imageItems.length === 0) return;
    (async () => {
      for (const it of imageItems) {
        try {
          const src = await idbGetImage(it.imgId);
          if (src) {
            setSavedItems(s => s.map(x => x.id === it.id ? {
              ...x,
              src
            } : x));
          }
        } catch {}
      }
    })();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LS_CHAT, JSON.stringify({
        chat,
        lastQuestion
      }));
    } catch (e) {
      console.warn("Could not save chat to localStorage:", e);
    }
  }, [chat, lastQuestion]);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = e => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);
  const clearServerChat = () => {
    fetch(`${API}/reset_chat`, withSession({
      method: "POST"
    })).catch(() => {});
  };
  const uploadPdf = async (theFile = file) => {
    if (!theFile) {
      setUploadError(true);
      setUploadStatus("No PDF selected — choose a PDF first.");
      return;
    }
    if (theFile.size > 100 * 1024 * 1024) {
      setUploadError(true);
      setUploadStatus("PDF is too large (max 100 MB). Please choose a smaller file.");
      return;
    }
    setUploadError(false);
    setUploadPct(0);
    setUploadStatus("Uploading…");
    const formData = new FormData();
    formData.append("file", theFile);
    try {
      const {
        job_id
      } = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API}/upload`);
        xhr.setRequestHeader("X-Session-Id", SESSION_ID);
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) {
            const pct = Math.round(e.loaded / e.total * 30);
            setUploadPct(pct);
            setUploadStatus(`Uploading… ${Math.round(e.loaded / e.total * 100)}%`);
          }
        };
        xhr.onload = () => {
          let parsed = {};
          try {
            parsed = JSON.parse(xhr.responseText);
          } catch {}
          if (xhr.status >= 200 && xhr.status < 300 && parsed.job_id) resolve(parsed);else reject(new Error(parsed.error || `Upload failed (HTTP ${xhr.status}).`));
        };
        xhr.onerror = () => reject(new Error("Couldn't upload right now. Please check your connection and try again."));
        xhr.send(formData);
      });
      const data = await new Promise((resolve, reject) => {
        const poll = async () => {
          try {
            const r = await fetch(`${API}/progress/${job_id}`, withSession());
            if (!r.ok) throw new Error("Lost track of the upload job.");
            const job = await r.json();
            setUploadPct(job.pct ?? 30);
            if (job.error) {
              reject(new Error(job.error));
              return;
            }
            if (job.done) {
              resolve(job.result || {});
              return;
            }
            setUploadStatus(`${job.stage}…`);
            setTimeout(poll, 500);
          } catch (e) {
            reject(e);
          }
        };
        poll();
      });
      setPdfLoaded(true);
      if (data.total_pages || data.pages) setPageCount(data.total_pages || data.pages);
      if (data.documents) setDocs(data.documents);
      const count = data.documents?.length || 1;
      let note = count > 1 ? `${count} documents loaded · added ${theFile.name}` : `${theFile.name} loaded · ${data.characters ?? 0} characters`;
      if (data.method === "ocr") note += ` · read by OCR (${data.ocr_pages} pages)`;else if (data.method === "mixed") note += ` · ${data.ocr_pages} pages via OCR`;else if (data.method === "empty") note += ` · no text found`;
      if (data.warning) note += ` · ${data.warning}`;
      setUploadStatus(note);
      setStaleChat(false);
    } catch (err) {
      setUploadError(true);
      const msg = err?.message || "";
      const friendly = /large|100 MB|pdf|accepted/i.test(msg)
        ? msg
        : "Upload didn't go through. Please try again.";
      setUploadStatus(friendly);
    } finally {
      setUploadPct(null);
    }
  };
  const reset = () => {
    setFile(null);
    setPdfLoaded(false);
    setPageCount(1);
    setUploadStatus("No PDF loaded");
    setQuiz([]);
    setCards([]);
    setChat([]);
    setLastQuestion("");
    setStaleChat(false);
    setPicked({});
    setFlippedCards(new Set());
    setDocs([]);
    fetch(`${API}/clear_documents`, withSession({
      method: "POST"
    })).catch(() => {});
  };
  const loadQuiz = async (append = false) => {
    if (!pdfLoaded) return;
    setQuizLoading(true);
    if (!append) setPicked({});
    try {
      const res = await fetch(`${API}/quiz`, withSession({
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          topic: lastQuestion,
          avoid: append ? quiz.map(q => q.question) : []
        })
      }));
      const data = await res.json();
      const fresh = data.questions || [];
      setQuiz(prev => {
        if (!append) return fresh;
        const seen = new Set(prev.map(q => q.question));
        return [...fresh.filter(q => !seen.has(q.question)), ...prev];
      });
    } catch {
      if (!append) setQuiz([]);
    }
    setQuizLoading(false);
  };
  const loadFlashcards = async (append = false) => {
    if (!pdfLoaded) return;
    setCardLoading(true);
    if (!append) {
      setFlippedCards(new Set());
    }
    try {
      const res = await fetch(`${API}/flashcards`, withSession({
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          topic: lastQuestion,
          avoid: append ? cards.map(c => c.question) : []
        })
      }));
      const data = await res.json();
      const fresh = data.cards || [];
      setCards(prev => {
        if (!append) return fresh;
        const seen = new Set(prev.map(c => c.question));
        return [...fresh.filter(c => !seen.has(c.question)), ...prev];
      });
    } catch {
      if (!append) setCards([]);
    }
    setCardLoading(false);
  };
  // @-mention picker: typing "@" in the chat input suggests loaded PDFs so a
  // question can be aimed at specific documents
  const updateMention = (val, caret) => {
    if (docs.length === 0) {
      setMention(null);
      return;
    }
    const before = val.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at === -1) {
      setMention(null);
      return;
    }
    const query = before.slice(at + 1);
    if (query.length > 80) {
      setMention(null);
      return;
    }
    const matches = docs.filter(d => d.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
    if (matches.length === 0) {
      setMention(null);
      return;
    }
    setMention({
      at,
      query,
      matches,
      index: 0
    });
  };
  const pickMention = doc => {
    if (!mention) return;
    const end = mention.at + 1 + mention.query.length;
    setMessage(message.slice(0, mention.at) + "@" + doc + " " + message.slice(end));
    setMention(null);
    chatInputRef.current?.focus();
  };
  const onChatChange = e => {
    setMessage(e.target.value);
    updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };
  const onChatKeyDown = e => {
    if (mention) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setMention(m => ({
          ...m,
          index: (m.index + dir + m.matches.length) % m.matches.length
        }));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mention.matches[mention.index]);
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !chatLoading && message.trim()) sendMessage();
  };
  const sendMessage = async () => {
    if (!message.trim()) return;
    const q = message;
    const mentioned = docs.filter(d => q.includes("@" + d)).slice(0, 10);
    setChat(c => [...c, {
      role: "user",
      content: q
    }]);
    setLastQuestion(q);
    setMessage("");
    setMention(null);
    setChatLoading(true);
    try {
      const res = await fetch(`${API}/chat`, withSession({
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: q,
          documents: mentioned
        })
      }));
      const data = await res.json();
      setChat(c => [...c, {
        role: "assistant",
        content: data.reply || "No reply received",
        sources: data.sources || []
      }]);
    } catch {
      setChat(c => [...c, {
        role: "assistant",
        content: "Something went wrong. Please try again in a moment."
      }]);
    }
    setChatLoading(false);
  };
  const handlePaste = e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };
  const addSavedItem = item => setSavedItems(s => [...s, {
    id: newId(),
    ...item
  }]);
  const removeSavedItem = id => setSavedItems(s => {
    const item = s.find(it => it.id === id);
    if (item?.type === "image" && item.imgId) idbDeleteImage(item.imgId);
    return s.filter(it => it.id !== id);
  });
  const updateSavedItem = (id, patch) => setSavedItems(s => s.map(it => it.id === id ? {
    ...it,
    ...patch
  } : it));
  const moveSavedItem = (id, dir) => setSavedItems(s => {
    const i = s.findIndex(it => it.id === id);
    if (i < 0) return s;
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= s.length) return s;
    const next = [...s];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const importQuizQuestion = qi => {
    const item = quiz[qi];
    addSavedItem({
      type: "quiz",
      question: item.question,
      options: item.options,
      answer: item.answer
    });
  };
  const importCard = card => {
    addSavedItem({
      type: "flashcard",
      question: card.question,
      answer: card.answer
    });
  };
  const importAnswer = idx => {
    const a = chat[idx];
    const q = idx > 0 && chat[idx - 1].role === "user" ? chat[idx - 1].content : "";
    addSavedItem({
      type: "answer",
      question: q,
      answer: a.content
    });
  };
  const onPickImage = e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const MB = 1024 * 1024;
    if (f.size > 10 * MB) {
      window.alert("Image is too large (max 10 MB). Please choose a smaller image.");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const src = reader.result;
      const imgId = newId();
      try {
        await idbPutImage(imgId, src);
      } catch (err) {
        console.warn("Could not save image to IndexedDB:", err);
      }
      addSavedItem({
        type: "image",
        src,
        name: f.name,
        imgId
      });
    };
    reader.readAsDataURL(f);
    e.target.value = "";
  };
  useEffect(() => {
    const onSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !richHostOf(sel.anchorNode)) {
        setMenuPos(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setMenuPos(null);
        return;
      }
      setMenuPos({
        top: Math.max(8, rect.top - 44),
        left: Math.min(Math.max(rect.left + rect.width / 2, 130), window.innerWidth - 130)
      });
      setActiveFormats(readFormats());
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);
  const applyFormat = kind => {
    if (kind === "highlight") {
      const node = highlightNodeAt();
      if (node) {
        const sel = window.getSelection();
        if (sel.isCollapsed) {
          const range = document.createRange();
          range.selectNodeContents(node);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand("styleWithCSS", false, true);
        document.execCommand("hiliteColor", false, "transparent");
        document.execCommand("backColor", false, "transparent");
        document.execCommand("removeFormat");
      } else {
        document.execCommand("styleWithCSS", false, true);
        document.execCommand("hiliteColor", false, "rgba(249, 199, 79, 0.5)");
      }
    } else {
      const cmd = {
        bold: () => document.execCommand("bold"),
        italic: () => document.execCommand("italic"),
        clear: () => document.execCommand("removeFormat"),
        bullets: () => document.execCommand("insertUnorderedList")
      }[kind];
      if (cmd) cmd();
    }
    setActiveFormats(readFormats());
  };
  const commitComposer = () => {
    const el = composerRef.current;
    if (!el) return;
    if (!el.innerText.trim()) return;
    addSavedItem({
      type: "note",
      html: DOMPurify.sanitize(el.innerHTML)
    });
    el.innerHTML = "";
  };
  const persistNoteHtml = (id, e) => {
    updateSavedItem(id, {
      html: DOMPurify.sanitize(e.currentTarget.innerHTML)
    });
  };
  const stripHtml = h => {
    const d = document.createElement("div");
    d.innerHTML = DOMPurify.sanitize(h || "");
    return d.innerText;
  };
  const noteText = it => it.html !== undefined ? stripHtml(it.html) : it.text || "";
  const noteHtml = (it, esc) => it.html !== undefined ? `<div>${DOMPurify.sanitize(it.html)}</div>` : `<p>${esc(it.text || "")}</p>`;
  const clearNotebook = () => {
    savedItems.forEach(it => {
      if (it.type === "image" && it.imgId) idbDeleteImage(it.imgId);
    });
    setSavedItems([]);
    if (composerRef.current) composerRef.current.innerHTML = "";
  };
  // copy rich HTML through a real DOM selection: unlike the async clipboard
  // API, this preserves large data-URL images, which Chromium silently strips
  // or rejects when written via ClipboardItem
  const copyViaSelection = html => {
    const holder = document.createElement("div");
    holder.setAttribute("contenteditable", "true");
    holder.style.cssText = "position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none;";
    holder.innerHTML = html;
    document.body.appendChild(holder);
    const sel = window.getSelection();
    const prevRanges = [];
    for (let i = 0; i < (sel?.rangeCount || 0); i++) prevRanges.push(sel.getRangeAt(i));
    let ok;
    try {
      const range = document.createRange();
      range.selectNodeContents(holder);
      sel.removeAllRanges();
      sel.addRange(range);
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    sel?.removeAllRanges();
    prevRanges.forEach(r => sel.addRange(r));
    holder.remove();
    return ok;
  };
  const copyNotebook = () => {
    const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const itemsText = savedItems.map(it => {
      if (it.type === "image") return `[Image: ${it.name || "image"}]`;
      if (it.type === "note") return noteText(it);
      if (it.type === "quiz") {
        const opts = it.options.map((o, i) => `  ${i === it.answer ? "*" : "-"} ${o}`).join("\n");
        return `Q: ${it.question}\n${opts}`;
      }
      return `${it.question ? "Q: " + it.question + "\n" : ""}A: ${it.answer}`;
    }).join("\n\n");
    const itemsHtml = savedItems.map(it => {
      if (it.type === "image") return it.src ? `<img src="${it.src}" alt="${esc(it.name || "image")}" />` : "";
      if (it.type === "note") return noteHtml(it, esc);
      if (it.type === "quiz") {
        const opts = it.options.map((o, i) => `<li>${i === it.answer ? "<strong>" : ""}${esc(o)}${i === it.answer ? "</strong>" : ""}</li>`).join("");
        return `<p><strong>Q:</strong> ${esc(it.question)}</p><ul>${opts}</ul>`;
      }
      return `${it.question ? `<p><strong>Q:</strong> ${esc(it.question)}</p>` : ""}<p>${esc(it.answer)}</p>`;
    }).join("");
    const plain = itemsText;
    const html = `<div>${itemsHtml}</div>`;
    if (savedItems.length === 0) {
      showToast("Notebook is empty — nothing to copy");
      return;
    }
    const hasImages = savedItems.some(it => it.type === "image" && it.src);
    try {
      // images only survive the selection-based copy; use it whenever present
      if (hasImages && copyViaSelection(html)) {
        showToast("Copied (with images)");
        return;
      }
      if (navigator.clipboard && window.ClipboardItem) {
        const item = new window.ClipboardItem({
          "text/html": new Blob([html], {
            type: "text/html"
          }),
          "text/plain": new Blob([plain], {
            type: "text/plain"
          })
        });
        navigator.clipboard.write([item]).then(() => showToast(hasImages ? "Copied — images may be dropped by this browser" : "Copied to clipboard"), () => navigator.clipboard.writeText(plain).then(() => showToast("Copied as text"), () => showToast("Copy failed")));
      } else if (copyViaSelection(html)) {
        showToast("Copied to clipboard");
      } else if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(plain).then(() => showToast("Copied to clipboard"), () => showToast("Copy failed"));
      } else {
        showToast("Copy not supported");
      }
    } catch {
      showToast("Copy failed");
    }
  };
  const exportPdf = () => {
    if (savedItems.length === 0) {
      showToast("Notebook is empty — nothing to export");
      return;
    }
    const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const itemsHtml = savedItems.map(it => {
      if (it.type === "image") {
        return it.src ? `<div class="item"><div class="kind">Image</div><img src="${it.src}" alt="${esc(it.name || "image")}" /></div>` : "";
      }
      if (it.type === "quiz") {
        const opts = it.options.map((o, i) => `<li class="${i === it.answer ? "right" : ""}">${esc(o)}</li>`).join("");
        return `<div class="item"><div class="kind">Quiz</div><p class="q">${esc(it.question)}</p><ul>${opts}</ul></div>`;
      }
      if (it.type === "note") {
        const body = it.html !== undefined ? DOMPurify.sanitize(it.html) : mdBlock(it.text);
        return `<div class="item"><div class="kind">Note</div><div class="a">${body}</div></div>`;
      }
      const label = it.type === "flashcard" ? "Flashcard" : "AI Answer";
      const q = it.question ? `<p class="q">${esc(it.question)}</p>` : "";
      return `<div class="item"><div class="kind">${label}</div>${q}<div class="a">${mdBlock(it.answer)}</div></div>`;
    }).join("");
    const today = new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric"
    });
    const katexCss = itemsHtml.includes('class="katex') ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" crossorigin="anonymous" />' : "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(notebookTitle)}</title>
${katexCss}<style>
  @page { margin: 18mm 16mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Georgia, "Times New Roman", serif; color: #1a1a1a; max-width: 720px; margin: 40px auto; padding: 0 24px; line-height: 1.6; }
  h1 { font-size: 26px; border-bottom: 3px double #1a1a1a; padding-bottom: 10px; margin: 0 0 6px; }
  .subtitle { font-size: 12px; color: #666; margin: 0 0 24px; }
  .item { border: 1px solid #ccc; border-radius: 8px; padding: 12px 16px; margin: 0 0 14px; page-break-inside: avoid; break-inside: avoid; }
  .kind { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-bottom: 6px; }
  .q { font-weight: bold; margin: 0 0 6px; }
  .a { margin: 0; }
  .a p { margin: 0 0 8px; }
  .a p:last-child { margin-bottom: 0; }
  .a ul, .a ol { margin: 6px 0; padding-left: 20px; }
  .a pre { background: #f4f2ea; border: 1px solid #ddd; border-radius: 6px; padding: 10px; overflow-x: auto; font-size: 12px; }
  .a code { font-family: Menlo, Consolas, monospace; font-size: 0.92em; }
  .a blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid #bbb; color: #555; }
  .katex-display { margin: 8px 0; }
  ul { margin: 6px 0 0; padding-left: 20px; }
  li.right { font-weight: bold; }
  li.right::after { content: " \\2713"; color: #1a7f37; }
  img { max-width: 100%; border-radius: 6px; }
  mark { background: #fff3a3; }
  [style*="background"] { padding: 0 2px; border-radius: 2px; }
  @media print { body { margin: 0; max-width: none; } }
</style></head><body>
  <h1>${esc(notebookTitle)}</h1>
  <p class="subtitle">${savedItems.length} block${savedItems.length === 1 ? "" : "s"} · exported ${esc(today)}</p>
  ${itemsHtml}
</body></html>`;
    // print from a hidden same-origin iframe: popup blockers can't interfere,
    // and the load event fires only after images/stylesheets are ready
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    frame.setAttribute("aria-hidden", "true");
    document.body.appendChild(frame);
    const cleanup = () => {
      if (frame.parentNode) frame.remove();
    };
    frame.onload = () => {
      try {
        frame.contentWindow.onafterprint = cleanup;
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch {
        showToast("Could not open the print dialog");
        cleanup();
        return;
      }
      // fallback for browsers that never fire afterprint on iframes
      setTimeout(cleanup, 120000);
    };
    frame.srcdoc = html;
  };
  const pickOption = (qkey, oi) => {
    if (picked[qkey] !== undefined) return;
    setPicked(p => ({
      ...p,
      [qkey]: oi
    }));
  };
  return <div className="app">
      {toast && <div className="toast">{toast}</div>}
      {}
      <header className="topbar">
        <div className="brand">
          <span className="logo">
            <svg viewBox="0 0 48 48" width="38" height="38" aria-hidden="true">
              <path d="M14 6 h13 l9 9 v21 a5 5 0 0 1 -5 5 H14 a5 5 0 0 1 -5 -5 V11 a5 5 0 0 1 5 -5 z" fill="#2f6b4e" />
              <path d="M27 6 v9 h9" fill="#fff" opacity="0.28" />
              <circle cx="18.5" cy="29" r="2.1" fill="#fff" />
              <circle cx="24" cy="29" r="2.1" fill="#fff" />
              <circle cx="29.5" cy="29" r="2.1" fill="#fff" />
            </svg>
          </span>
          <div>
            <h1>PDF <span>Buddy</span> {pdfLoaded && <em className="pages-pill">{pageCount} {pageCount === 1 ? "page" : "pages"}</em>}</h1>
            <p className={uploadError ? "doc-status err" : "doc-status"}>Active document: {uploadStatus}</p>
            {docs.length > 0 && <div className="doc-chips">
                {docs.map((d, i) => <span className="doc-chip" key={i} title={d}>{d}</span>)}
              </div>}
            {uploadPct !== null && <div className="upload-bar">
                <div className={uploadPct >= 30 && uploadPct < 100 ? "upload-bar-fill processing" : "upload-bar-fill"} style={{
              width: `${uploadPct}%`
            }} />
              </div>}
          </div>
        </div>
        <div className="top-actions">
          <input type="file" accept=".pdf" ref={pdfInputRef} style={{
          display: "none"
        }} onChange={e => {
          const f = e.target.files[0];
          e.target.value = "";
          if (f) {
            setFile(f);
            setUploadError(false);
            uploadPdf(f);
          }
        }} />
          <button className="btn primary" onClick={() => pdfInputRef.current?.click()} disabled={uploadPct !== null}>
            {uploadPct !== null ? <><span className="btn-spinner" />Uploading {uploadPct}%</> : docs.length > 0 ? "+ Add PDF" : "Upload PDF"}
          </button>
          <button className="btn ghost" onClick={reset}>Reset</button>
        </div>
      </header>

      <nav className="mobile-nav">
        <button className={mobileView === "helper" ? "mnav on" : "mnav"} onClick={() => setMobileView("helper")}>Helper</button>
        <button className={mobileView === "chat" ? "mnav on" : "mnav"} onClick={() => setMobileView("chat")}>AI Agent</button>
        <button className={mobileView === "notebook" ? "mnav on" : "mnav"} onClick={() => setMobileView("notebook")}>Notebook</button>
      </nav>

      <main className="columns" data-mobile-view={mobileView}>
        {}
        <section className="panel panel-helper">
          <div className="panel-head">
            <h2 className="panel-title">Helper</h2>
          </div>

          <div className="seg">
            <button className={helperTab === "quiz" ? "seg-btn on" : "seg-btn"} onClick={() => setHelperTab("quiz")}>Quiz Me</button>
            <button className={helperTab === "flashcards" ? "seg-btn on" : "seg-btn"} onClick={() => setHelperTab("flashcards")}>Flashcards</button>
          </div>

          {}
          {helperTab === "quiz" && <div className="helper-body">
              <button className="btn block" disabled={!pdfLoaded || quizLoading} onClick={loadQuiz}>
                {quizLoading ? "Building quiz…" : lastQuestion ? "Generate quiz on this topic" : "Generate quiz from PDF"}
              </button>
              {quiz.length > 0 && <div className="helper-actions">
                  <button className="btn ghost sm" disabled={quizLoading} onClick={() => loadQuiz(true)}>
                    {quizLoading ? "Adding…" : "+ More questions"}
                  </button>
                  <button className="btn ghost sm" onClick={() => {
              setQuiz([]);
              setPicked({});
            }}>Clear</button>
                </div>}
              {pdfLoaded && lastQuestion && <p className="topic-note">Focused on your last question: <span>{lastQuestion}</span></p>}
              {!pdfLoaded ? <div className="helper-empty">
                  <span className="empty-icon">?</span>
                  <p>Upload a PDF and the Helper will turn it into multiple-choice questions you can test yourself with.</p>
                </div> : quiz.length === 0 && !quizLoading ? <div className="helper-empty">
                  <span className="empty-icon">?</span>
                  <p>Ready when you are. Generate a quiz to get four questions drawn from your document.</p>
                </div> : null}
              {quiz.map((item, qi) => {
            const qkey = item.question;
            const chosen = picked[qkey];
            const answered = chosen !== undefined;
            return <div className="quiz-card" key={qkey}>
                    <p className="quiz-q">{qi + 1}. {item.question}</p>
                    <div className="quiz-opts">
                      {item.options.map((opt, oi) => {
                  let cls = "opt";
                  if (answered) {
                    if (oi === item.answer) cls += " correct";else if (oi === chosen) cls += " wrong";
                  }
                  return <button key={oi} className={cls} disabled={answered} onClick={() => pickOption(qkey, oi)}>
                            {opt}
                            {answered && oi === item.answer && <span className="tag">Correct</span>}
                            {answered && oi === chosen && oi !== item.answer && <span className="tag">Your pick</span>}
                          </button>;
                })}
                    </div>
                    <button className="link-btn" onClick={() => importQuizQuestion(qi)}>+ Save to notebook</button>
                  </div>;
          })}
            </div>}

          {helperTab === "flashcards" && <div className="helper-body">
              <button className="btn block" disabled={!pdfLoaded || cardLoading} onClick={loadFlashcards}>
                {cardLoading ? "Building cards…" : lastQuestion ? "Generate flashcards on this topic" : "Generate flashcards from PDF"}
              </button>
              {cards.length > 0 && <div className="helper-actions">
                  <button className="btn ghost sm" disabled={cardLoading} onClick={() => loadFlashcards(true)}>
                    {cardLoading ? "Adding…" : "+ More cards"}
                  </button>
                  <button className="btn ghost sm" onClick={() => {
              setCards([]);
              setFlippedCards(new Set());
            }}>Clear</button>
                </div>}
              {pdfLoaded && lastQuestion && <p className="topic-note">Focused on your last question: <span>{lastQuestion}</span></p>}
              {!pdfLoaded ? <div className="helper-empty">
                  <span className="empty-icon">▤</span>
                  <p>Upload a PDF and the Helper will build two-sided study cards — question on the front, answer on the back.</p>
                </div> : cards.length === 0 && !cardLoading ? <div className="helper-empty">
                  <span className="empty-icon">▤</span>
                  <p>Generate flashcards to build a study deck from your document.</p>
                </div> : null}
              {cards.map((card, ci) => {
            const ckey = card.question;
            const isFlipped = flippedCards.has(ckey);
            return <div className="flash-list-card" key={ckey}>
                    <div className={isFlipped ? "flashcard flipped" : "flashcard"} onClick={() => toggleFlip(ckey)}>
                      <div className="flash-inner">
                        <div className="flash-face front">
                          <span className="flash-label">Question {ci + 1}</span>
                          <p>{card.question}</p>
                          <span className="flash-tip">Click to flip</span>
                        </div>
                        <div className="flash-face back">
                          <span className="flash-label">Answer</span>
                          <p>{card.answer}</p>
                          <span className="flash-tip">Click to flip</span>
                        </div>
                      </div>
                    </div>
                    <button className="link-btn" onClick={() => importCard(card)}>+ Save to notebook</button>
                  </div>;
          })}
            </div>}

        </section>

        {}
        <section className="panel panel-chat">
          <div className="panel-head row">
            <h2 className="panel-title">AI Agent</h2>
            {chat.length > 0 && <button className="tool-btn" onClick={() => {
            setChat([]);
            setLastQuestion("");
            setStaleChat(false);
            clearServerChat();
          }}>Clear chat</button>}
          </div>
          {staleChat && !pdfLoaded && <p className="topic-note">Showing your previous conversation. Re-upload the PDF to ask new questions.</p>}
          <div className="chat-scroll">
            {chat.length === 0 && <div className="helper-empty">
                <span className="empty-icon">
                  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
                    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 4v-4H5.5A1.5 1.5 0 0 1 4 14.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    <circle cx="9" cy="10" r="1.1" fill="currentColor" />
                    <circle cx="12" cy="10" r="1.1" fill="currentColor" />
                    <circle cx="15" cy="10" r="1.1" fill="currentColor" />
                  </svg>
                </span>
                <p>Ask about the active PDF and the assistant will answer from retrieved passages.</p>
              </div>}
            {chat.map((m, i) => <div key={i} className={m.role === "user" ? "bubble user" : "bubble bot"}>
                <MathText text={m.content} />
                {m.role === "assistant" && m.sources && m.sources.length > 0 && <div className="bubble-sources">
                    Sources: {m.sources.map((s, si) => <span className="src-chip" key={si}>{s}</span>)}
                  </div>}
                {m.role === "assistant" && <button className="bubble-save" onClick={() => importAnswer(i)}>+ Save answer to notebook</button>}
              </div>)}
            {chatLoading && <div className="bubble bot typing">
                <span className="dot"></span><span className="dot"></span><span className="dot"></span>
              </div>}
            <div ref={chatEndRef} />
          </div>
          <div className="suggest-row">
            {["Key facts", "Methodology", "Explain basic concepts"].map(s => <button key={s} className="chip" onClick={() => setMessage(s)}>{s}</button>)}
          </div>
          <div className="chat-input">
            {mention && <div className="mention-pop" role="listbox" aria-label="Mention a PDF">
                <div className="mention-title">Ask a specific PDF</div>
                {mention.matches.map((d, i) => <button key={d} role="option" aria-selected={i === mention.index} className={i === mention.index ? "mention-item on" : "mention-item"} onMouseDown={e => e.preventDefault()} onClick={() => pickMention(d)}>{d}</button>)}
              </div>}
            <input ref={chatInputRef} placeholder={docs.length > 1 ? "Ask a question… type @ to target one PDF" : "Ask any question about active pages…"} value={message} onChange={onChatChange} onKeyDown={onChatKeyDown} onBlur={() => setMention(null)} disabled={!pdfLoaded} />
            <button className="send" aria-label="Send message" onClick={sendMessage} disabled={!pdfLoaded || !message.trim() || chatLoading}>↑</button>
          </div>
        </section>

        {}
        <section className="panel panel-notebook">
          <div className="panel-head row">
            <h2 className="panel-title">My Notebook</h2>
            <button className="tool-btn" onClick={() => imageInputRef.current?.click()}>Insert Image</button>
            <input type="file" accept="image/*" ref={imageInputRef} onChange={onPickImage} hidden />
          </div>
          <label className="field-label">Notebook title</label>
          <input className="title-input" value={notebookTitle} onChange={e => setNotebookTitle(e.target.value)} />

          <div className="note-scroll">
            {savedItems.length > 0 && <div className="saved-list">
                {savedItems.map((it, idx) => <div className={`saved-item ${it.type}`} key={it.id}>
                    <div className="saved-controls">
                      <button className="saved-move" aria-label="Move up" title="Move up" disabled={idx === 0} onClick={() => moveSavedItem(it.id, "up")}>↑</button>
                      <button className="saved-move" aria-label="Move down" title="Move down" disabled={idx === savedItems.length - 1} onClick={() => moveSavedItem(it.id, "down")}>↓</button>
                      <button className="saved-remove" aria-label="Remove item" title="Remove" onClick={() => removeSavedItem(it.id)}>×</button>
                    </div>
                    <span className="saved-kind">{it.type === "quiz" ? "Quiz" : it.type === "flashcard" ? "Flashcard" : it.type === "answer" ? "AI Answer" : it.type === "note" ? "Note" : "Image"}</span>
                    {it.type === "image" ? it.src ? <img className="saved-img" src={it.src} alt={it.name || "saved"} onClick={() => setLightbox({
                src: it.src,
                name: it.name
              })} /> : <div className="saved-img-loading">Loading image…</div> : it.type === "quiz" ? <>
                        <p className="saved-q">{it.question}</p>
                        <ul className="saved-opts">
                          {it.options.map((o, i) => <li key={i} className={i === it.answer ? "right" : ""}>{o}</li>)}
                        </ul>
                      </> : it.type === "note" ? it.html !== undefined ? <div className="note-editable rich-edit" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Note" onPaste={handlePaste} onBlur={e => persistNoteHtml(it.id, e)} dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(it.html)
              }} /> : editingId === it.id ? <textarea className="saved-edit note-edit" value={it.text} placeholder="Type a note…" autoFocus onChange={e => updateSavedItem(it.id, {
                text: e.target.value
              })} onBlur={() => setEditingId(null)} /> : <div className="saved-rendered" onClick={() => setEditingId(it.id)}>
                          {it.text ? <MathText text={it.text} /> : <span className="saved-placeholder">Empty note — click to edit</span>}
                        </div> : editingId === it.id ? <>
                          {it.question !== undefined && it.question !== "" && <textarea className="saved-edit saved-q-edit" value={it.question} onChange={e => updateSavedItem(it.id, {
                  question: e.target.value
                })} />}
                          <textarea className="saved-edit saved-a-edit" value={it.answer} autoFocus onChange={e => updateSavedItem(it.id, {
                  answer: e.target.value
                })} />
                          <button className="link-btn" onClick={() => setEditingId(null)}>Done</button>
                        </> : <>
                          {it.question && <p className="saved-q">{it.question}</p>}
                          <div className="saved-rendered"><MathText text={it.answer} /></div>
                          <button className="link-btn" onClick={() => setEditingId(it.id)}>Edit</button>
                        </>}
                  </div>)}
              </div>}
            {savedItems.length === 0 && <div className="helper-empty">
                <span className="empty-icon">✎</span>
                <p>No notes yet. Write below and press Enter — or save quizzes, answers, and images from the other panels.</p>
              </div>}
          </div>

          <div ref={composerRef} className="note-composer rich-edit" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="New note" data-placeholder="Write a note… Enter to add, Shift+Enter for a new line" onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commitComposer();
          }
        }} onPaste={handlePaste} />

          <div className="notebook-foot">
            <span className="meta">{savedItems.length} blocks · auto-saved</span>
            <div className="foot-btns">
              <button className="btn ghost sm" onClick={exportPdf}>Export PDF</button>
              <button className="btn ghost sm" onClick={copyNotebook}>Copy</button>
              <button className="btn ghost sm danger" onClick={clearNotebook}>Clear</button>
            </div>
          </div>
        </section>
      </main>

      {menuPos && <div className="float-menu" style={{
      top: menuPos.top,
      left: menuPos.left
    }} onMouseDown={e => e.preventDefault()}>
          <button className={activeFormats.bold ? "fm-btn on" : "fm-btn"} aria-label="Bold" onClick={() => applyFormat("bold")}><b>B</b></button>
          <button className={activeFormats.italic ? "fm-btn on" : "fm-btn"} aria-label="Italic" onClick={() => applyFormat("italic")}><i>I</i></button>
          <button className={activeFormats.highlight ? "fm-btn on" : "fm-btn"} aria-label="Highlight" onClick={() => applyFormat("highlight")}><span className="fm-hl">A</span></button>
          <button className={activeFormats.bullets ? "fm-btn on" : "fm-btn"} aria-label="Bulleted list" onClick={() => applyFormat("bullets")}>• List</button>
          <button className="fm-btn" aria-label="Clear formatting" onClick={() => applyFormat("clear")}>Clear</button>
        </div>}

      {lightbox && <div className="lightbox" onClick={() => setLightbox(null)}>
          <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">×</button>
          <img src={lightbox.src} alt={lightbox.name || "enlarged"} onClick={e => e.stopPropagation()} />
        </div>}
    </div>;
}