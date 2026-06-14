import { useState, useRef, useEffect } from "react";
import "./App.css";

const API = "http://127.0.0.1:8000";

// ---- localStorage persistence ----
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

export default function App() {
  // ---- shared document state ----
  const [file, setFile] = useState(null);
  const [pdfLoaded, setPdfLoaded] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [uploadStatus, setUploadStatus] = useState("No PDF loaded");

  // ---- helper panel ----
  const [helperTab, setHelperTab] = useState("quiz"); // quiz | flashcards

  // ---- quiz state ----
  const [quiz, setQuiz] = useState([]); // [{question, options:[], answer:index}]
  const [quizLoading, setQuizLoading] = useState(false);
  const [picked, setPicked] = useState({}); // {questionIndex: optionIndex}

  // ---- flashcard state ----
  const [cards, setCards] = useState([]); // [{question, answer}]
  const [cardLoading, setCardLoading] = useState(false);
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  // ---- AI agent ----
  const [message, setMessage] = useState("");
  const [chat, setChat] = useState([]); // [{role, content}]
  const [chatLoading, setChatLoading] = useState(false);
  const [lastQuestion, setLastQuestion] = useState(""); // seeds quiz/flashcards

  // ---- notebook (persisted in localStorage) ----
  const [notebookTitle, setNotebookTitle] = useState(_persisted?.title ?? "Research Notebook");
  const [notebook, setNotebook] = useState(_persisted?.notes ?? "");
  const [activeFormats, setActiveFormats] = useState({});
  const [savedItems, setSavedItems] = useState(_persisted?.items ?? []); // [{id, type, ...}]
  const notebookRef = useRef(null);
  const imageInputRef = useRef(null);

  // restore the editor's saved HTML into the contentEditable div on first mount
  useEffect(() => {
    if (notebookRef.current && notebook) {
      notebookRef.current.innerHTML = notebook;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist notebook to localStorage whenever title, notes, or items change
  useEffect(() => {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ title: notebookTitle, notes: notebook, items: savedItems })
      );
    } catch (e) {
      // storage full (likely too many/large images) — fail quietly
      console.warn("Could not save notebook to localStorage:", e);
    }
  }, [notebookTitle, notebook, savedItems]);

  // ---------- backend calls ----------
  const uploadPdf = async () => {
    if (!file) {
      setUploadStatus("Pick a PDF first, then upload");
      return;
    }
    setUploadStatus("Uploading…");
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`${API}/upload`, { method: "POST", body: formData });
      const data = await res.json();
      setPdfLoaded(true);
      if (data.pages) setPageCount(data.pages);
      let note = `${file.name} loaded · ${data.characters ?? 0} characters`;
      if (data.method === "ocr") note += ` · read by OCR (${data.ocr_pages} pages)`;
      else if (data.method === "mixed") note += ` · ${data.ocr_pages} pages via OCR`;
      else if (data.method === "empty") note += ` · no text found`;
      if (data.warning) note += ` · ${data.warning}`;
      setUploadStatus(note);
      // reset derived content
      setQuiz([]); setCards([]); setChat([]);
    } catch {
      setUploadStatus("Upload failed. Is the backend running on port 8000?");
    }
  };

  const reset = () => {
    setFile(null); setPdfLoaded(false); setPageCount(1);
    setUploadStatus("No PDF loaded");
    setQuiz([]); setCards([]); setChat([]);
    setPicked({}); setCardIndex(0); setFlipped(false);
  };

  const loadQuiz = async () => {
    if (!pdfLoaded) return;
    setQuizLoading(true); setPicked({});
    try {
      const res = await fetch(`${API}/quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: lastQuestion }),
      });
      const data = await res.json();
      setQuiz(data.questions || []);
    } catch {
      setQuiz([]);
    }
    setQuizLoading(false);
  };

  const loadFlashcards = async () => {
    if (!pdfLoaded) return;
    setCardLoading(true); setCardIndex(0); setFlipped(false);
    try {
      const res = await fetch(`${API}/flashcards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: lastQuestion }),
      });
      const data = await res.json();
      setCards(data.cards || []);
    } catch {
      setCards([]);
    }
    setCardLoading(false);
  };

  const sendMessage = async () => {
    if (!message.trim()) return;
    const q = message;
    setChat((c) => [...c, { role: "user", content: q }]);
    setLastQuestion(q); // seed quiz/flashcards with this topic
    setMessage(""); setChatLoading(true);
    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q }),
      });
      const data = await res.json();
      setChat((c) => [...c, { role: "assistant", content: data.reply || "No reply received" }]);
    } catch {
      setChat((c) => [...c, { role: "assistant", content: "Couldn't reach the backend." }]);
    }
    setChatLoading(false);
  };

  // ---------- notebook helpers ----------
  const syncNotebook = () => {
    if (notebookRef.current) setNotebook(notebookRef.current.innerHTML);
  };

  let _idc = 0;
  const newId = () => `${Date.now()}-${_idc++}-${Math.random().toString(36).slice(2, 6)}`;

  const addSavedItem = (item) => setSavedItems((s) => [...s, { id: newId(), ...item }]);
  const removeSavedItem = (id) => setSavedItems((s) => s.filter((it) => it.id !== id));

  const importQuizQuestion = (qi) => {
    const item = quiz[qi];
    addSavedItem({
      type: "quiz",
      question: item.question,
      options: item.options,
      answer: item.answer,
    });
  };

  const importCard = (card) => {
    addSavedItem({ type: "flashcard", question: card.question, answer: card.answer });
  };

  const importAnswer = (idx) => {
    const a = chat[idx];
    // pair with the preceding user question if present
    const q = idx > 0 && chat[idx - 1].role === "user" ? chat[idx - 1].content : "";
    addSavedItem({ type: "answer", question: q, answer: a.content });
  };

  const onPickImage = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // base64 inflates ~33%; localStorage caps near 5MB total, so warn on big files
    if (f.size > 2 * 1024 * 1024) {
      const ok = window.confirm(
        "This image is over 2MB. Large images may not save permanently " +
        "(browser storage is limited). Add it anyway?"
      );
      if (!ok) { e.target.value = ""; return; }
    }
    const reader = new FileReader();
    reader.onload = () => addSavedItem({ type: "image", src: reader.result, name: f.name });
    reader.readAsDataURL(f);
    e.target.value = ""; // allow re-picking same file
  };

  // walk up from selection; return the highlight element if we're inside one
  const highlightNodeAt = (point) => {
    const sel = window.getSelection();
    const start = point || (sel && sel.anchorNode);
    if (!start) return null;
    let node = start;
    const el = notebookRef.current;
    while (node && node !== el) {
      if (node.nodeType === 1) {
        const bg = node.style?.backgroundColor || "";
        if (node.tagName === "MARK") return node;
        if (bg && /91, *74, *158/.test(bg)) return node; // #5b4a9e in rgb
      }
      node = node.parentNode;
    }
    return null;
  };

  const inHighlight = () => !!highlightNodeAt();

  // read which formats are active at the current selection → drives toggle UI
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
      highlight: inHighlight(),
    });
  };

  const safeState = (cmd) => {
    try { return document.queryCommandState(cmd); } catch { return false; }
  };

  // apply real formatting to the current selection inside the editor
  const applyFormat = (kind) => {
    const el = notebookRef.current;
    if (!el) return;
    el.focus();
    if (kind === "highlight") {
      const node = highlightNodeAt();
      if (node) {
        // cursor is inside a highlight — select the whole span and strip it,
        // so you don't have to manually re-select the text first
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
        // if it was a <mark>, removeFormat clears the tag itself
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
        bullets: () => document.execCommand("insertUnorderedList"),
      }[kind];
      if (cmd) cmd();
    }
    syncNotebook();
    refreshFormats();
  };

  const clearNotebook = () => {
    if (notebookRef.current) notebookRef.current.innerHTML = "";
    setNotebook("");
    setSavedItems([]);
  };

  const copyNotebook = () => {
    const itemsText = savedItems.map((it) => {
      if (it.type === "image") return `[Image: ${it.name || "image"}]`;
      if (it.type === "quiz") {
        const opts = it.options.map((o, i) => `  ${i === it.answer ? "*" : "-"} ${o}`).join("\n");
        return `Q: ${it.question}\n${opts}`;
      }
      return `${it.question ? "Q: " + it.question + "\n" : ""}A: ${it.answer}`;
    }).join("\n\n");
    const notes = notebookRef.current?.innerText || "";
    navigator.clipboard?.writeText([itemsText, notes].filter(Boolean).join("\n\n"));
  };

  const notebookChars = notebook.replace(/<[^>]*>/g, "").length;

  const pickOption = (qi, oi) => {
    if (picked[qi] !== undefined) return; // lock after first pick
    setPicked((p) => ({ ...p, [qi]: oi }));
  };

  // ---------- render ----------
  return (
    <div className="app">
      {/* ===== Top bar ===== */}
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
              <path d="M14 6 h13 l9 9 v21 a5 5 0 0 1 -5 5 H14 a5 5 0 0 1 -5 -5 V11 a5 5 0 0 1 5 -5 z"
                fill="url(#buddyGrad)" />
              <path d="M27 6 v9 h9" fill="#fff" opacity="0.28" />
              <circle cx="18.5" cy="29" r="2.1" fill="#fff" />
              <circle cx="24" cy="29" r="2.1" fill="#fff" />
              <circle cx="29.5" cy="29" r="2.1" fill="#fff" />
            </svg>
          </span>
          <div>
            <h1>PDF <span>Buddy</span> <em className="pages-pill">{pageCount} pages</em></h1>
            <p className="doc-status">Active document: {uploadStatus}</p>
          </div>
        </div>
        <div className="top-actions">
          <label className="filepick">
            {file ? file.name : "Choose a PDF to begin"}
            <input type="file" accept=".pdf" onChange={(e) => setFile(e.target.files[0])} />
          </label>
          <button className="btn primary" onClick={uploadPdf}>Upload PDF</button>
          <button className="btn ghost" onClick={reset}>Reset</button>
        </div>
      </header>

      <main className="columns">
        {/* ===== LEFT: HELPER ===== */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Helper</h2>
          </div>

          <div className="seg">
            <button className={helperTab === "quiz" ? "seg-btn on" : "seg-btn"} onClick={() => setHelperTab("quiz")}>Quiz Me</button>
            <button className={helperTab === "flashcards" ? "seg-btn on" : "seg-btn"} onClick={() => setHelperTab("flashcards")}>Flashcards</button>
          </div>

          {/* QUIZ */}
          {helperTab === "quiz" && (
            <div className="helper-body">
              <button className="btn block" disabled={!pdfLoaded || quizLoading} onClick={loadQuiz}>
                {quizLoading ? "Building quiz…" : lastQuestion ? "Generate quiz on this topic" : "Generate quiz from PDF"}
              </button>
              {pdfLoaded && lastQuestion && (
                <p className="topic-note">Focused on your last question: <span>{lastQuestion}</span></p>
              )}
              {!pdfLoaded ? (
                <div className="helper-empty">
                  <span className="empty-icon">?</span>
                  <p>Upload a PDF and the Helper will turn it into multiple-choice questions you can test yourself with.</p>
                </div>
              ) : quiz.length === 0 && !quizLoading ? (
                <div className="helper-empty">
                  <span className="empty-icon">?</span>
                  <p>Ready when you are. Generate a quiz to get four questions drawn from your document.</p>
                </div>
              ) : null}
              {quiz.map((item, qi) => {
                const chosen = picked[qi];
                const answered = chosen !== undefined;
                return (
                  <div className="quiz-card" key={qi}>
                    <p className="quiz-q">{qi + 1}. {item.question}</p>
                    <div className="quiz-opts">
                      {item.options.map((opt, oi) => {
                        let cls = "opt";
                        if (answered) {
                          if (oi === item.answer) cls += " correct";
                          else if (oi === chosen) cls += " wrong";
                        }
                        return (
                          <button key={oi} className={cls} disabled={answered} onClick={() => pickOption(qi, oi)}>
                            {opt}
                            {answered && oi === item.answer && <span className="tag">Correct</span>}
                            {answered && oi === chosen && oi !== item.answer && <span className="tag">Your pick</span>}
                          </button>
                        );
                      })}
                    </div>
                    {answered && (
                      <button className="link-btn" onClick={() => importQuizQuestion(qi)}>+ Save to notebook</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* FLASHCARDS */}
          {helperTab === "flashcards" && (
            <div className="helper-body">
              <button className="btn block" disabled={!pdfLoaded || cardLoading} onClick={loadFlashcards}>
                {cardLoading ? "Building cards…" : lastQuestion ? "Generate flashcards on this topic" : "Generate flashcards from PDF"}
              </button>
              {pdfLoaded && lastQuestion && (
                <p className="topic-note">Focused on your last question: <span>{lastQuestion}</span></p>
              )}
              {!pdfLoaded ? (
                <div className="helper-empty">
                  <span className="empty-icon">▤</span>
                  <p>Upload a PDF and the Helper will build two-sided study cards — question on the front, answer on the back.</p>
                </div>
              ) : cards.length === 0 && !cardLoading ? (
                <div className="helper-empty">
                  <span className="empty-icon">▤</span>
                  <p>Generate flashcards to start a flip-through deck from your document.</p>
                </div>
              ) : null}
              {cards.length > 0 && (
                <>
                  <div className={flipped ? "flashcard flipped" : "flashcard"} onClick={() => setFlipped((f) => !f)}>
                    <div className="flash-inner">
                      <div className="flash-face front">
                        <span className="flash-label">Question</span>
                        <p>{cards[cardIndex].question}</p>
                        <span className="flash-tip">Click to flip</span>
                      </div>
                      <div className="flash-face back">
                        <span className="flash-label">Answer</span>
                        <p>{cards[cardIndex].answer}</p>
                        <span className="flash-tip">Click to flip</span>
                      </div>
                    </div>
                  </div>
                  <div className="flash-nav">
                    <button className="btn ghost sm" disabled={cardIndex === 0}
                      onClick={() => { setCardIndex((i) => Math.max(0, i - 1)); setFlipped(false); }}>Prev</button>
                    <span className="flash-count">{cardIndex + 1} / {cards.length}</span>
                    <button className="btn ghost sm" disabled={cardIndex === cards.length - 1}
                      onClick={() => { setCardIndex((i) => Math.min(cards.length - 1, i + 1)); setFlipped(false); }}>Next</button>
                  </div>
                  <button className="link-btn" onClick={() => importCard(cards[cardIndex])}>+ Save this card to notebook</button>
                </>
              )}
            </div>
          )}

        </section>

        {/* ===== CENTER: AI AGENT ===== */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">AI Intelligent Agent</h2>
          </div>
          <div className="chat-scroll">
            {chat.length === 0 && (
              <div className="helper-empty">
                <span className="empty-icon">
                  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
                    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 4v-4H5.5A1.5 1.5 0 0 1 4 14.5z"
                      stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    <circle cx="9" cy="10" r="1.1" fill="currentColor" />
                    <circle cx="12" cy="10" r="1.1" fill="currentColor" />
                    <circle cx="15" cy="10" r="1.1" fill="currentColor" />
                  </svg>
                </span>
                <p>Ask about the active PDF and the assistant will answer from retrieved passages.</p>
              </div>
            )}
            {chat.map((m, i) => (
              <div key={i} className={m.role === "user" ? "bubble user" : "bubble bot"}>
                <div>{m.content}</div>
                {m.role === "assistant" && (
                  <button className="bubble-save" onClick={() => importAnswer(i)}>+ Save answer to notebook</button>
                )}
              </div>
            ))}
            {chatLoading && <div className="bubble bot">…</div>}
          </div>
          <div className="suggest-row">
            {["Key facts", "Methodology", "Explain basic concepts"].map((s) => (
              <button key={s} className="chip" onClick={() => setMessage(s)}>{s}</button>
            ))}
          </div>
          <div className="chat-input">
            <input placeholder="Ask any question about active pages…" value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()} disabled={!pdfLoaded} />
            <button className="send" onClick={sendMessage} disabled={!pdfLoaded}>↑</button>
          </div>
        </section>

        {/* ===== RIGHT: NOTEBOOK ===== */}
        <section className="panel">
          <div className="panel-head row">
            <h2 className="panel-title">My Notebook</h2>
            <button className="tool-btn" onClick={() => imageInputRef.current?.click()}>Insert Image</button>
            <input type="file" accept="image/*" ref={imageInputRef} onChange={onPickImage} hidden />
          </div>
          <label className="field-label">Notebook title</label>
          <input className="title-input" value={notebookTitle} onChange={(e) => setNotebookTitle(e.target.value)} />
          <div className="note-toolbar">
            <button className={activeFormats.bold ? "tool-btn on" : "tool-btn"} onMouseDown={(e) => e.preventDefault()} onClick={() => applyFormat("bold")}><b>Bold</b></button>
            <button className={activeFormats.italic ? "tool-btn on" : "tool-btn"} onMouseDown={(e) => e.preventDefault()} onClick={() => applyFormat("italic")}><i>Italic</i></button>
            <button className={activeFormats.highlight ? "tool-btn on" : "tool-btn"} onMouseDown={(e) => e.preventDefault()} onClick={() => applyFormat("highlight")}>Highlight</button>
            <button className="tool-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => applyFormat("clear")}>Clear Mark</button>
            <button className={activeFormats.bullets ? "tool-btn on" : "tool-btn"} onMouseDown={(e) => e.preventDefault()} onClick={() => applyFormat("bullets")}>Bullets</button>
          </div>

          <div className="note-scroll">
            {savedItems.length > 0 && (
              <div className="saved-list">
                {savedItems.map((it) => (
                  <div className={`saved-item ${it.type}`} key={it.id}>
                    <button className="saved-remove" title="Remove" onClick={() => removeSavedItem(it.id)}>×</button>
                    <span className="saved-kind">{
                      it.type === "quiz" ? "Quiz" :
                      it.type === "flashcard" ? "Flashcard" :
                      it.type === "answer" ? "AI Answer" : "Image"
                    }</span>
                    {it.type === "image" ? (
                      <img className="saved-img" src={it.src} alt={it.name || "saved"} />
                    ) : it.type === "quiz" ? (
                      <>
                        <p className="saved-q">{it.question}</p>
                        <ul className="saved-opts">
                          {it.options.map((o, i) => (
                            <li key={i} className={i === it.answer ? "right" : ""}>{o}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <>
                        {it.question && <p className="saved-q">{it.question}</p>}
                        <p className="saved-a">{it.answer}</p>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div
              ref={notebookRef}
              className="notebook-area"
              contentEditable
              suppressContentEditableWarning
              data-placeholder="Write your own notes here, or import quizzes, flashcards, answers, and images above."
              onInput={syncNotebook}
              onKeyUp={refreshFormats}
              onMouseUp={refreshFormats}
              onFocus={refreshFormats}
              onBlur={() => setActiveFormats({})}
            />
          </div>

          <div className="notebook-foot">
            <span className="meta">{savedItems.length} items · {notebookChars} chars · auto-saved</span>
            <div className="foot-btns">
              <button className="btn ghost sm" onClick={copyNotebook}>Copy</button>
              <button className="btn ghost sm danger" onClick={clearNotebook}>Clear</button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}