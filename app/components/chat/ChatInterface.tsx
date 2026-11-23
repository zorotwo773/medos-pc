"use client";
/**
 * ChatInterface — unified AI chat with:
 *   - RAG mode (NVIDIA NIM + FAISS vectorstore)
 *   - Gemma 4 31B Direct (streaming, vision-capable) via NVIDIA NIM
 *   - Gemini 1.5 Flash Direct
 *   - Image upload (drag-drop or click) for vision queries
 */
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { getBackendUrl } from "@/lib/api";
import type { ChatMessage } from "@/types/medical";

/* ─── Model registry ─────────────────────────────────────────────────── */

const ALL_MODELS = [
  {
    id: "nvidia-direct",
    label: "Gemma 4 31B",
    desc: "Direct · NVIDIA NIM · Vision",
    icon: "⚡",
    requires: "nvidia-direct",
    streaming: true,
    vision: true,
  },
  {
    id: "nvidia",
    label: "Llama 3.3 70B",
    desc: "RAG · NVIDIA NIM",
    icon: "📚",
    requires: "nvidia",
    streaming: false,
    vision: false,
  },
  {
    id: "gemini",
    label: "Gemini 1.5 Flash",
    desc: "Direct · Google",
    icon: "✦",
    requires: "gemini",
    streaming: false,
    vision: false,
  },
];

const SUGGESTIONS = [
  "What are the diagnostic criteria for type 2 diabetes?",
  "Explain the pathophysiology of heart failure",
  "First-line treatment for hypertension?",
  "Mechanism of ACE inhibitors",
  "Causes of metabolic acidosis",
  "How does AF lead to stroke?",
];
const MAX_RENDERED_MESSAGES = 80;

/* ─── Types ──────────────────────────────────────────────────────────── */

interface ImageAttachment {
  b64:  string;   // raw base64, no prefix
  mime: string;
  preview: string; // data URL for display
  name: string;
}

interface ExtendedMessage extends ChatMessage {
  image?: ImageAttachment;
  streaming?: boolean;
  thinking?: string;   // collects reasoning_content separately
}

/* ─── Streaming SSE helper ───────────────────────────────────────────── */

async function streamNvidiaResponse(
  url: string,
  body: object,
  onChunk: (delta: string, isThinking?: boolean) => void,
  onDone: () => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.text();
    throw new Error(`Backend error ${res.status}: ${err.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]" || raw === "[KEEPALIVE]") continue;
      try {
        const json = JSON.parse(raw);
        const delta   = json?.choices?.[0]?.delta?.content ?? "";
        const thinking = json?.choices?.[0]?.delta?.thinking ?? false;
        if (delta) onChunk(delta, thinking);
      } catch {
        // partial JSON — skip
      }
    }
  }
  onDone();
}

/* ─── Component ──────────────────────────────────────────────────────── */

export default function ChatInterface() {
  const [messages,       setMessages]       = useState<ExtendedMessage[]>([]);
  const [input,          setInput]          = useState("");
  const [loading,        setLoading]        = useState(false);
  const [model,          setModel]          = useState("nvidia-direct");
  const [availableModels,setAvailableModels]= useState(ALL_MODELS);
  const [showModel,      setShowModel]      = useState(false);
  const [backendStatus,  setBackendStatus]  = useState<"checking"|"online"|"offline">("checking");
  const [image,          setImage]          = useState<ImageAttachment | null>(null);
  const [isDragging,     setIsDragging]     = useState(false);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLTextAreaElement>(null);
  const fileRef     = useRef<HTMLInputElement>(null);
  const abortRef    = useRef<AbortController | null>(null);
  const autosizeFrameRef = useRef<number | null>(null);

  const renderedMessages = useMemo(() => (
    messages.length > MAX_RENDERED_MESSAGES
      ? messages.slice(-MAX_RENDERED_MESSAGES)
      : messages
  ), [messages]);

  const scheduleTextareaAutosize = useCallback((el: HTMLTextAreaElement | null = inputRef.current) => {
    if (!el || typeof window === "undefined") return;
    if (autosizeFrameRef.current !== null) {
      window.cancelAnimationFrame(autosizeFrameRef.current);
    }
    autosizeFrameRef.current = window.requestAnimationFrame(() => {
      autosizeFrameRef.current = null;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    });
  }, []);

  useEffect(() => () => {
    if (autosizeFrameRef.current !== null) {
      window.cancelAnimationFrame(autosizeFrameRef.current);
      autosizeFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    scheduleTextareaAutosize(inputRef.current);
  }, [input, scheduleTextareaAutosize]);

  /* Health check */
  useEffect(() => {
    fetch(`${getBackendUrl()}/health`)
      .then(async r => {
        if (!r.ok) { setBackendStatus("offline"); return; }
        setBackendStatus("online");
        const data = await r.json();
        const available: string[] = data.models_available ?? [];
        const filtered = ALL_MODELS.filter(m => available.includes(m.requires));
        if (filtered.length > 0) {
          setAvailableModels(filtered);
          setModel(prev => filtered.some(m => m.id === prev) ? prev : filtered[0].id);
        }
      })
      .catch(() => setBackendStatus("offline"));
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  /* Image handling */
  const attachImage = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target?.result as string;
      const b64 = dataUrl.split(",")[1] ?? "";
      setImage({ b64, mime: file.type, preview: dataUrl, name: file.name });
    };
    reader.readAsDataURL(file);
  }, []);

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) attachImage(f);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) attachImage(f);
  };

  /* Paste image from clipboard */
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) { attachImage(f); break; }
        }
      }
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [attachImage]);

  /* Send message */
  async function send() {
    const q = input.trim();
    if (!q || loading) return;

    const selectedModel = availableModels.find(m => m.id === model) ?? availableModels[0];

    setInput("");
    const userMsg: ExtendedMessage = {
      id: Date.now().toString(),
      role: "user",
      content: q,
      image: image ?? undefined,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);
    setImage(null);
    setLoading(true);

    abortRef.current = new AbortController();

    try {
      if (model === "nvidia-direct") {
        /* ── Streaming path ── */
        const assistantId = (Date.now() + 1).toString();
        setMessages(prev => [...prev, {
          id: assistantId, role: "assistant",
          content: "", streaming: true, timestamp: new Date(),
        }]);

        await streamNvidiaResponse(
          `${getBackendUrl()}/chat/nvidia-direct`,
          {
            question: q,
            image_b64:   image?.b64  ?? undefined,
            image_mime:  image?.mime ?? undefined,
            enable_thinking: false,   // thinking mode is very slow; set true for deep reasoning
          },
          (delta, isThinking) => {
            setMessages(prev => prev.map(m => {
              if (m.id !== assistantId) return m;
              if (isThinking) return { ...m, thinking: (m.thinking ?? "") + delta };
              return { ...m, content: m.content + delta };
            }));
          },
          () => {
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, streaming: false } : m
            ));
          },
          abortRef.current.signal,
        );
      } else {
        /* ── Non-streaming path (RAG / Gemini) ── */
        const res = await fetch(`${getBackendUrl()}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q, model }),
          signal: abortRef.current.signal,
        });
        if (!res.ok) throw new Error(`Backend error ${res.status}`);
        const data = await res.json();
        setMessages(prev => [...prev, {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: data.answer,
          sources: data.sources,
          timestamp: new Date(),
        }]);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setMessages(prev => [...prev, {
        id: (Date.now() + 2).toString(),
        role: "assistant",
        content: `**Error:** ${(err as Error).message}\n\nCheck that the backend is running at ${getBackendUrl()}`,
        timestamp: new Date(),
      }]);
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  function stopGeneration() {
    abortRef.current?.abort();
    setLoading(false);
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const currentModel = availableModels.find(m => m.id === model) ?? ALL_MODELS[0];
  const supportsVision = currentModel?.vision ?? false;

  return (
    <div
      className="chat-shell"
      style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}
      onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="chat-drag-overlay" style={{
          position: "absolute", inset: 0, zIndex: 100,
          background: "rgba(14,165,233,0.12)",
          border: "2px dashed var(--accent)",
          borderRadius: 8, display: "flex", alignItems: "center",
          justifyContent: "center", pointerEvents: "none",
        }}>
          <span style={{ fontSize: 18, color: "var(--accent-strong)", fontFamily: "var(--font-serif)" }}>
            Drop image to attach
          </span>
        </div>
      )}

      {/* Header */}
      <div className="chat-header" style={{
        padding: "14px 20px", borderBottom: "1px solid var(--border)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        background: "var(--bg-card)", flexShrink: 0,
      }}>
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
            AI Clinical Assistant
          </h2>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
            {currentModel.desc} {supportsVision ? "· Vision" : ""}
          </p>
        </div>

        <div className="chat-header-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Status dot */}
          <div className="chat-status-pill" style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: backendStatus === "online" ? "var(--green)"
                : backendStatus === "offline" ? "var(--red)" : "var(--amber)",
              boxShadow: backendStatus === "online" ? "0 0 6px var(--green)" : "none",
            }} />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {backendStatus === "online" ? "Online" : backendStatus === "offline" ? "Offline" : "…"}
            </span>
          </div>

          {/* Model picker */}
          <div className="chat-model-picker" style={{ position: "relative" }}>
            <button
              className="chat-model-button"
              onClick={() => setShowModel(v => !v)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "5px 10px", fontSize: 12,
                background: "var(--bg-subtle)", border: "1px solid var(--border)",
                borderRadius: 6, cursor: "pointer", color: "var(--text-secondary)",
              }}
            >
              <span>{currentModel.icon}</span>
              <span>{currentModel.label}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="m6 9 6 6 6-6"/>
              </svg>
            </button>
            {showModel && (
              <div className="chat-model-menu" style={{
                position: "absolute", right: 0, top: "calc(100% + 6px)",
                background: "var(--bg-card)", border: "1px solid var(--border)",
                borderRadius: 8, padding: 6, minWidth: 220, zIndex: 50,
                boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
              }}>
                {availableModels.map(m => (
                  <button
                    key={m.id}
                    className="chat-model-option"
                    onClick={() => { setModel(m.id); setShowModel(false); }}
                    style={{
                      width: "100%", padding: "8px 10px", textAlign: "left",
                      background: model === m.id ? "var(--accent-glow)" : "transparent",
                      border: "none", borderRadius: 6, cursor: "pointer",
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: model === m.id ? 600 : 400 }}>
                      {m.icon} {m.label}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{m.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="chat-messages" style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        {messages.length === 0 && (
          <div className="chat-empty" style={{ margin: "auto 0", paddingTop: 24 }}>
            <p style={{
              fontFamily: "var(--font-serif)", fontStyle: "italic",
              fontSize: 18, color: "var(--text-muted)", marginBottom: 20, textAlign: "center",
            }}>
              Ask a clinical question
            </p>
            <div className="chat-suggestion-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, maxWidth: 540, margin: "0 auto" }}>
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  className="chat-suggestion"
                  onClick={() => setInput(s)}
                  style={{
                    padding: "9px 12px", textAlign: "left", fontSize: 12,
                    color: "var(--text-secondary)", background: "var(--bg-card)",
                    border: "1px solid var(--border)", borderRadius: 8,
                    cursor: "pointer", lineHeight: 1.4,
                    transition: "border-color .14s",
                  }}
                  onMouseEnter={e => { (e.currentTarget).style.borderColor = "var(--accent-dim)"; }}
                  onMouseLeave={e => { (e.currentTarget).style.borderColor = "var(--border)"; }}
                >{s}</button>
              ))}
            </div>
          </div>
        )}

        {renderedMessages.map(msg => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}

        {loading && !messages.find(m => m.streaming) && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <AvatarIcon role="assistant" />
            <div style={{ padding: "10px 14px", background: "var(--bg-card)", borderRadius: 10, border: "1px solid var(--border)" }}>
              <ThinkingDots />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="chat-composer" style={{
        padding: "12px 16px", borderTop: "1px solid var(--border)",
        background: "var(--bg-card)", flexShrink: 0,
      }}>
        {/* Image preview */}
        {image && (
          <div className="chat-attachment-preview" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
            <img
              src={image.preview}
              alt={image.name}
              style={{ height: 56, width: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {image.name}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Image attached</div>
            </div>
            <button
              className="chat-icon-button"
              onClick={() => setImage(null)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>
        )}

        <div className="chat-composer-row" style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          {/* Image attach button */}
          {supportsVision && (
            <>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFilePick} />
              <button
                className="chat-icon-button"
                onClick={() => fileRef.current?.click()}
                title="Attach image (or paste / drag-drop)"
                style={{
                  width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                  background: image ? "var(--accent-glow)" : "var(--bg-subtle)",
                  border: `1px solid ${image ? "var(--accent)" : "var(--border)"}`,
                  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  color: image ? "var(--accent-strong)" : "var(--text-muted)",
                  transition: "all .14s",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <path d="m21 15-5-5L5 21"/>
                </svg>
              </button>
            </>
          )}

          <textarea
            className="chat-input"
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={supportsVision ? "Ask a question or describe an image… (Shift+Enter for new line)" : "Ask a clinical question… (Shift+Enter for new line)"}
            rows={1}
            style={{
              flex: 1, resize: "none", border: "1px solid var(--border)",
              borderRadius: 8, padding: "8px 12px",
              fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14,
              color: "var(--text-primary)", background: "var(--bg-subtle)",
              outline: "none", lineHeight: 1.5,
              minHeight: 38, maxHeight: 120, overflowY: "auto",
            }}
            onInput={e => scheduleTextareaAutosize(e.currentTarget)}
            onFocus={e => { e.currentTarget.style.borderColor = "var(--accent-dim)"; }}
            onBlur={e => { e.currentTarget.style.borderColor = "var(--border)"; }}
          />

          {loading ? (
            <button
              className="chat-icon-button"
              onClick={stopGeneration}
              title="Stop generating"
              style={{
                width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                background: "var(--red-glow)", border: "1px solid var(--red-dim)",
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--red-dim)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            </button>
          ) : (
            <button
              className="chat-icon-button"
              onClick={send}
              disabled={!input.trim() && !image}
              title="Send (Enter)"
              style={{
                width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                background: (input.trim() || image) ? "var(--accent)" : "var(--bg-subtle)",
                border: "none", cursor: (input.trim() || image) ? "pointer" : "not-allowed",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: (input.trim() || image) ? "#fff" : "var(--text-muted)",
                transition: "background .14s",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>
              </svg>
            </button>
          )}
        </div>

        <div className="chat-composer-hint" style={{ marginTop: 6, fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", letterSpacing: "0.1em" }}>
          {supportsVision ? "Vision enabled · paste or drag an image to attach" : "Enter to send · Shift+Enter for new line"}
        </div>
      </div>
    </div>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────────── */

function AvatarIcon({ role }: { role: "user" | "assistant" }) {
  return (
    <div className="chat-avatar" style={{
      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
      background: role === "assistant" ? "var(--accent-glow)" : "var(--bg-subtle)",
      border: `1px solid ${role === "assistant" ? "var(--accent-dim)" : "var(--border)"}`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 12,
    }}>
      {role === "assistant" ? "⚡" : "👤"}
    </div>
  );
}

function ThinkingDots() {
  return (
    <div style={{ display: "flex", gap: 4, padding: "2px 0" }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          width: 6, height: 6, borderRadius: "50%",
          background: "var(--text-muted)",
          animation: "pulse-dot 1.2s ease-in-out infinite",
          animationDelay: `${i * 0.2}s`,
        }} />
      ))}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ExtendedMessage }) {
  const isUser = msg.role === "user";
  const [showThinking, setShowThinking] = useState(false);

  return (
    <div className="chat-message-row" style={{ display: "flex", gap: 10, alignItems: "flex-start", flexDirection: isUser ? "row-reverse" : "row" }}>
      <AvatarIcon role={msg.role as "user" | "assistant"} />

      <div className="chat-message-stack" style={{ maxWidth: "78%", display: "flex", flexDirection: "column", gap: 4, alignItems: isUser ? "flex-end" : "flex-start" }}>
        {/* Image attachment (user side) */}
        {msg.image && (
          <img
            src={msg.image.preview}
            alt={msg.image.name}
            style={{ maxWidth: 240, maxHeight: 180, borderRadius: 8, border: "1px solid var(--border)", objectFit: "cover" }}
          />
        )}

        {/* Thinking block (collapsible) */}
        {msg.thinking && (
          <div style={{ width: "100%" }}>
            <button
              className="chat-thinking-toggle"
              onClick={() => setShowThinking(v => !v)}
              style={{
                background: "none", border: "none", cursor: "pointer", padding: "2px 0",
                fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d={showThinking ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
              </svg>
              {msg.streaming ? "Thinking…" : `Reasoning (${msg.thinking.length} chars)`}
            </button>
            {showThinking && (
              <div className="chat-thinking-panel" style={{
                padding: "8px 12px", marginTop: 2,
                background: "var(--bg-subtle)", border: "1px solid var(--border)",
                borderRadius: 8, fontSize: 12, color: "var(--text-muted)",
                fontStyle: "italic", lineHeight: 1.5, whiteSpace: "pre-wrap",
                maxHeight: 200, overflowY: "auto",
              }}>
                {msg.thinking}
              </div>
            )}
          </div>
        )}

        {/* Thinking indicator when streaming but no content yet */}
        {msg.streaming && !msg.content && !msg.thinking && (
          <div className="chat-bubble" style={{ padding: "10px 14px", background: "var(--bg-card)", borderRadius: "12px 12px 12px 3px", border: "1px solid var(--border)" }}>
            <ThinkingDots />
          </div>
        )}

        {/* Text bubble */}
        {(msg.content || (msg.streaming && msg.content)) && (
          <div className="chat-bubble" style={{
            padding: "10px 14px",
            background: isUser ? "var(--accent)" : "var(--bg-card)",
            color: isUser ? "#fff" : "var(--text-primary)",
            borderRadius: isUser ? "12px 12px 3px 12px" : "12px 12px 12px 3px",
            border: isUser ? "none" : "1px solid var(--border)",
            fontSize: 14, lineHeight: 1.6,
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            <MarkdownText text={msg.content} />
            {msg.streaming && <BlinkCursor />}
          </div>
        )}

        {/* Sources */}
        {msg.sources && msg.sources.length > 0 && (
          <div className="chat-sources" style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
            {msg.sources.slice(0, 4).map((s: {source: string; page?: number}, i: number) => (
              <span key={i} style={{
                fontSize: 10, padding: "2px 7px", borderRadius: 999,
                background: "var(--accent-glow)", color: "var(--accent-strong)",
                border: "1px solid rgba(14,165,233,0.2)",
                fontFamily: "var(--font-mono)", letterSpacing: "0.1em",
              }}>
                {s.source}{s.page ? ` p.${s.page}` : ""}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BlinkCursor() {
  return (
    <span style={{
      display: "inline-block", width: 2, height: "1em",
      background: "currentColor", marginLeft: 2, verticalAlign: "text-bottom",
      animation: "pulse-dot 0.8s step-end infinite",
    }} />
  );
}

function MarkdownText({ text }: { text: string }) {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const isCode = line.startsWith("```") || line.startsWith("    ");
        const bold = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        return (
          <span key={i} style={isCode ? { fontFamily: "var(--font-mono)", fontSize: 12, opacity: 0.9 } : {}}>
            <span dangerouslySetInnerHTML={{ __html: bold }} />
            {i < lines.length - 1 && <br />}
          </span>
        );
      })}
    </>
  );
}
