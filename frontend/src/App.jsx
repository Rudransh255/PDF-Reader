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
          delimiters: [{
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
          }],
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
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [flippedCards, setFlippedCards] = useState(new Set());
  const toggleFlip = ci => {
    setFlippedCards(prev => {
      const next = new Set(prev);
      next.has(ci) ? next.delete(ci) : next.add(ci);
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
  const [lastQuestion, setLastQuestion] = useState(_persistedChat?.lastQuestion ?? "");
  const [staleChat, setStaleChat] = useState((_persistedChat?.chat ?? []).length > 0);
  const [notebookTitle, setNotebookTitle] = useState(_persisted?.title ?? "Research Notebook");
  const [notebook, setNotebook] = useState(_persisted?.notes ?? "");
  const [activeFormats, setActiveFormats] = useState({});
  const [savedItems, setSavedItems] = useState(_persisted?.items ?? []);
  const [editingId, setEditingId] = useState(null);
  const notebookRef = useRef(null);
  const imageInputRef = useRef(null);
  const chatEndRef = useRef(null);
  const pdfInputRef = useRef(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({
      behavior: "smooth"
    });
  }, [chat, chatLoading]);
  const [lightbox, setLightbox] = useState(null);
  useEffect(() => {
    if (notebookRef.current && notebook) {
      notebookRef.current.innerHTML = DOMPurify.sanitize(notebook);
    }
  }, []);
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
        notes: notebook,
        items: itemsForStorage
      }));
    } catch (e) {
      console.warn("Could not save notebook to localStorage:", e);
    }
  }, [notebookTitle, notebook, savedItems]);
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
        xhr.onerror = () => reject(new Error("Network error. Is the backend reachable?"));
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
      if (data.pages) setPageCount(data.pages);
      if (data.documents) setDocs(data.documents);
      const count = data.documents?.length || 1;
      let note = count > 1 ? `${count} documents loaded · added ${theFile.name}` : `${theFile.name} loaded · ${data.characters ?? 0} characters`;
      if (data.method === "ocr") note += ` · read by OCR (${data.ocr_pages} pages)`;else if (data.method === "mixed") note += ` · ${data.ocr_pages} pages via OCR`;else if (data.method === "empty") note += ` · no text found`;
      if (data.warning) note += ` · ${data.warning}`;
      setUploadStatus(note);
      setStaleChat(false);
    } catch (err) {
      setUploadError(true);
      setUploadStatus(err.message || "Upload failed.");
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
    setCardIndex(0);
    setFlipped(false);
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
      setQuiz(prev => append ? [...fresh, ...prev] : fresh);
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
      setCards(prev => append ? [...fresh, ...prev] : fresh);
    } catch {
      if (!append) setCards([]);
    }
    setCardLoading(false);
  };
  const sendMessage = async () => {
    if (!message.trim()) return;
    const q = message;
    setChat(c => [...c, {
      role: "user",
      content: q
    }]);
    setLastQuestion(q);
    setMessage("");
    setChatLoading(true);
    try {
      const res = await fetch(`${API}/chat`, withSession({
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: q
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
        content: "Couldn't reach the backend."
      }]);
    }
    setChatLoading(false);
  };
  const syncNotebook = () => {
    if (notebookRef.current) setNotebook(notebookRef.current.innerHTML);
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
    } else if (notebookRef.current) {
      notebookRef.current.appendChild(document.createTextNode(text));
    }
    syncNotebook();
  };
  let _idc = 0;
  const newId = () => `${Date.now()}-${_idc++}-${Math.random().toString(36).slice(2, 6)}`;
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
  const addTextBlock = (afterId = null) => setSavedItems(s => {
    const block = {
      id: newId(),
      type: "note",
      text: ""
    };
    if (!afterId) return [...s, block];
    const i = s.findIndex(it => it.id === afterId);
    const next = [...s];
    next.splice(i + 1, 0, block);
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
  const highlightNodeAt = point => {
    const sel = window.getSelection();
    const start = point || sel && sel.anchorNode;
    if (!start) return null;
    let node = start;
    const el = notebookRef.current;
    while (node && node !== el) {
      if (node.nodeType === 1) {
        const bg = node.style?.backgroundColor || "";
        if (node.tagName === "MARK") return node;
        if (bg && /91, *74, *158/.test(bg)) return node;
      }
      node = node.parentNode;
    }
    return null;
  };
  const inHighlight = () => !!highlightNodeAt();
  const refreshFormats = () => {
    const el = notebookRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !el.contains(sel.anchorNode)) {
      setActiveFormats({});
      return;
    }
    setActiveFormats({
      bold: safeState("bold"),
      italic: safeState("italic"),
      bullets: safeState("insertUnorderedList"),
      highlight: inHighlight()
    });
  };
  const safeState = cmd => {
    try {
      return document.queryCommandState(cmd);
    } catch {
      return false;
    }
  };
  const applyFormat = kind => {
    const el = notebookRef.current;
    if (!el) return;
    el.focus();
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
        document.execCommand("hiliteColor", false, "#5b4a9e");
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
    syncNotebook();
    refreshFormats();
  };
  const clearNotebook = () => {
    if (notebookRef.current) notebookRef.current.innerHTML = "";
    setNotebook("");
    savedItems.forEach(it => {
      if (it.type === "image" && it.imgId) idbDeleteImage(it.imgId);
    });
    setSavedItems([]);
  };
  const copyNotebook = () => {
    const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const itemsText = savedItems.map(it => {
      if (it.type === "image") return `[Image: ${it.name || "image"}]`;
      if (it.type === "note") return it.text || "";
      if (it.type === "quiz") {
        const opts = it.options.map((o, i) => `  ${i === it.answer ? "*" : "-"} ${o}`).join("\n");
        return `Q: ${it.question}\n${opts}`;
      }
      return `${it.question ? "Q: " + it.question + "\n" : ""}A: ${it.answer}`;
    }).join("\n\n");
    const itemsHtml = savedItems.map(it => {
      if (it.type === "image") return it.src ? `<img src="${it.src}" alt="${esc(it.name || "image")}" />` : "";
      if (it.type === "note") return `<p>${esc(it.text || "")}</p>`;
      if (it.type === "quiz") {
        const opts = it.options.map((o, i) => `<li>${i === it.answer ? "<strong>" : ""}${esc(o)}${i === it.answer ? "</strong>" : ""}</li>`).join("");
        return `<p><strong>Q:</strong> ${esc(it.question)}</p><ul>${opts}</ul>`;
      }
      return `${it.question ? `<p><strong>Q:</strong> ${esc(it.question)}</p>` : ""}<p>${esc(it.answer)}</p>`;
    }).join("");
    const notesText = notebookRef.current?.innerText || "";
    const notesHtml = DOMPurify.sanitize(notebookRef.current?.innerHTML || "");
    const plain = [itemsText, notesText].filter(Boolean).join("\n\n");
    const html = `<div>${itemsHtml}${notesHtml}</div>`;
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        const item = new window.ClipboardItem({
          "text/html": new Blob([html], {
            type: "text/html"
          }),
          "text/plain": new Blob([plain], {
            type: "text/plain"
          })
        });
        navigator.clipboard.write([item]).then(() => showToast("Copied (with images)"), () => navigator.clipboard.writeText(plain).then(() => showToast("Copied as text"), () => showToast("Copy failed")));
      } else if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(plain).then(() => showToast("Copied to clipboard"), () => showToast("Copy failed"));
      } else {
        showToast("Copy not supported");
      }
    } catch {
      showToast("Copy failed");
    }
  };
  const notebookChars = notebook.replace(/<[^>]*>/g, "").length;
  const exportPdf = () => {
    const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const itemsHtml = savedItems.map(it => {
      if (it.type === "image") {
        return it.src ? `<div class="item"><div class="kind">Image</div><img src="${it.src}" /></div>` : "";
      }
      if (it.type === "quiz") {
        const opts = it.options.map((o, i) => `<li class="${i === it.answer ? "right" : ""}">${esc(o)}</li>`).join("");
        return `<div class="item"><div class="kind">Quiz</div><p class="q">${esc(it.question)}</p><ul>${opts}</ul></div>`;
      }
      if (it.type === "note") {
        return `<div class="item"><div class="kind">Note</div><p class="a">${esc(it.text || "")}</p></div>`;
      }
      const label = it.type === "flashcard" ? "Flashcard" : "AI Answer";
      const q = it.question ? `<p class="q">${esc(it.question)}</p>` : "";
      return `<div class="item"><div class="kind">${label}</div>${q}<p class="a">${esc(it.answer)}</p></div>`;
    }).join("");
    const notesHtml = DOMPurify.sanitize(notebookRef.current?.innerHTML || "");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(notebookTitle)}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; color: #1a1a1a; max-width: 720px; margin: 40px auto; padding: 0 24px; line-height: 1.6; }
  h1 { font-size: 26px; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 24px; }
  .item { border: 1px solid #ccc; border-radius: 8px; padding: 12px 14px; margin: 0 0 14px; page-break-inside: avoid; }
  .kind { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-bottom: 6px; }
  .q { font-weight: bold; margin: 0 0 6px; }
  .a { margin: 0; white-space: pre-wrap; }
  ul { margin: 6px 0 0; padding-left: 20px; }
  li.right { font-weight: bold; }
  li.right::after { content: " ✓"; color: #1a7f37; }
  img { max-width: 100%; border-radius: 6px; }
  mark { background: #fff3a3; }
  .notes { margin-top: 20px; white-space: pre-wrap; }
  @media print { body { margin: 0; } }
</style></head><body>
  <h1>${esc(notebookTitle)}</h1>
  ${itemsHtml}
  <div class="notes">${notesHtml}</div>
</body></html>`;
    const w = window.open("", "_blank");
    if (!w) {
      alert("Please allow popups to export the notebook as PDF.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.onload = () => setTimeout(() => w.print(), 300);
  };
  const pickOption = (qi, oi) => {
    if (picked[qi] !== undefined) return;
    setPicked(p => ({
      ...p,
      [qi]: oi
    }));
  };
  return <div className="app">
      {toast && <div className="toast">{toast}</div>}
      {}
      <header className="topbar">
        <div className="brand">
          <span className="logo">
            <svg viewBox="0 0 48 48" width="38" height="38" aria-hidden="true">
              <defs>
                <linearGradient id="buddyGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#6f8bff" />
                  <stop offset="100%" stopColor="#b06bff" />
                </linearGradient>
              </defs>
              <path d="M14 6 h13 l9 9 v21 a5 5 0 0 1 -5 5 H14 a5 5 0 0 1 -5 -5 V11 a5 5 0 0 1 5 -5 z" fill="url(#buddyGrad)" />
              <path d="M27 6 v9 h9" fill="#fff" opacity="0.28" />
              <circle cx="18.5" cy="29" r="2.1" fill="#fff" />
              <circle cx="24" cy="29" r="2.1" fill="#fff" />
              <circle cx="29.5" cy="29" r="2.1" fill="#fff" />
            </svg>
          </span>
          <div>
            <h1>PDF <span>Buddy</span> {pdfLoaded && <em className="pages-pill">{pageCount} pages</em>}</h1>
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
            const chosen = picked[qi];
            const answered = chosen !== undefined;
            return <div className="quiz-card" key={qi}>
                    <p className="quiz-q">{qi + 1}. {item.question}</p>
                    <div className="quiz-opts">
                      {item.options.map((opt, oi) => {
                  let cls = "opt";
                  if (answered) {
                    if (oi === item.answer) cls += " correct";else if (oi === chosen) cls += " wrong";
                  }
                  return <button key={oi} className={cls} disabled={answered} onClick={() => pickOption(qi, oi)}>
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
            const isFlipped = flippedCards.has(ci);
            return <div className="flash-list-card" key={ci}>
                    <div className={isFlipped ? "flashcard flipped" : "flashcard"} onClick={() => toggleFlip(ci)}>
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
            <input placeholder="Ask any question about active pages…" value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => e.key === "Enter" && message.trim() && sendMessage()} disabled={!pdfLoaded} />
            <button className="send" onClick={sendMessage} disabled={!pdfLoaded || !message.trim() || chatLoading}>↑</button>
          </div>
        </section>

        {}
        <section className="panel panel-notebook">
          <div className="panel-head row">
            <h2 className="panel-title">My Notebook</h2>
            <button className="tool-btn" onClick={() => addTextBlock()}>+ Note Block</button>
            <button className="tool-btn" onClick={() => imageInputRef.current?.click()}>Insert Image</button>
            <input type="file" accept="image/*" ref={imageInputRef} onChange={onPickImage} hidden />
          </div>
          <label className="field-label">Notebook title</label>
          <input className="title-input" value={notebookTitle} onChange={e => setNotebookTitle(e.target.value)} />
          <div className="note-toolbar">
            <button className={activeFormats.bold ? "tool-btn on" : "tool-btn"} onMouseDown={e => e.preventDefault()} onClick={() => applyFormat("bold")}><b>Bold</b></button>
            <button className={activeFormats.italic ? "tool-btn on" : "tool-btn"} onMouseDown={e => e.preventDefault()} onClick={() => applyFormat("italic")}><i>Italic</i></button>
            <button className={activeFormats.highlight ? "tool-btn on" : "tool-btn"} onMouseDown={e => e.preventDefault()} onClick={() => applyFormat("highlight")}>Highlight</button>
            <button className="tool-btn" onMouseDown={e => e.preventDefault()} onClick={() => applyFormat("clear")}>Clear Mark</button>
            <button className={activeFormats.bullets ? "tool-btn on" : "tool-btn"} onMouseDown={e => e.preventDefault()} onClick={() => applyFormat("bullets")}>Bullets</button>
          </div>

          <div className="note-scroll">
            {savedItems.length > 0 && <div className="saved-list">
                {savedItems.map((it, idx) => <div className={`saved-item ${it.type}`} key={it.id}>
                    <div className="saved-controls">
                      <button className="saved-move" title="Move up" disabled={idx === 0} onClick={() => moveSavedItem(it.id, "up")}>↑</button>
                      <button className="saved-move" title="Move down" disabled={idx === savedItems.length - 1} onClick={() => moveSavedItem(it.id, "down")}>↓</button>
                      <button className="saved-remove" title="Remove" onClick={() => removeSavedItem(it.id)}>×</button>
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
                      </> : it.type === "note" ? editingId === it.id ? <textarea className="saved-edit note-edit" value={it.text} placeholder="Type a note…" autoFocus onChange={e => updateSavedItem(it.id, {
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
                    <button className="insert-block-btn" title="Insert a note below" onClick={() => addTextBlock(it.id)}>+ note below</button>
                  </div>)}
              </div>}

            <div ref={notebookRef} className="notebook-area" contentEditable suppressContentEditableWarning data-placeholder="Write your own notes here, or import quizzes, flashcards, answers, and images above." onInput={syncNotebook} onPaste={handlePaste} onKeyUp={refreshFormats} onMouseUp={refreshFormats} onFocus={refreshFormats} onBlur={() => setActiveFormats({})} />
          </div>

          <div className="notebook-foot">
            <span className="meta">{savedItems.length} items · {notebookChars} chars · auto-saved</span>
            <div className="foot-btns">
              <button className="btn ghost sm" onClick={exportPdf}>Export PDF</button>
              <button className="btn ghost sm" onClick={copyNotebook}>Copy</button>
              <button className="btn ghost sm danger" onClick={clearNotebook}>Clear</button>
            </div>
          </div>
        </section>
      </main>

      {lightbox && <div className="lightbox" onClick={() => setLightbox(null)}>
          <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">×</button>
          <img src={lightbox.src} alt={lightbox.name || "enlarged"} onClick={e => e.stopPropagation()} />
        </div>}
    </div>;
}