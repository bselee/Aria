/** @file ChatPanel — v2: Floating AI assistant with vision, markdown, copy, paste
 *  @purpose Collapsible chat overlay with textarea, file/paste image support,
 *           markdown rendering, code copy, message copy, timestamps.
 *           All Telegram goes through Aria's bot (separate PM2 process).
 *           Available on every dashboard page.
 *  @author Hermia
 *  @created 2026-06-02
 *  @deps react, lucide-react, MarkdownRenderer
 */

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  MessageCircle,
  X,
  Send,
  Bot,
  User,
  ChevronDown,
  Copy,
  Check,
  Paperclip,
  Image,
  Trash2,
  Loader2,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";

/* ── Types ───────────────────────────────────────────────────── */

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  id: string;
  ts: number;
  images?: { dataUrl: string; name: string }[];
}

interface PendingImage {
  dataUrl: string;
  name: string;
  uploading: boolean;
  description?: string;
}

/* ── Constants ────────────────────────────────────────────────── */

const STORAGE_KEY = "aria-chat-messages-v2";
const MAX_MESSAGES = 100;

/* ── Helpers ─────────────────────────────────────────────────── */

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function truncateFilename(name: string, max = 24): string {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf(".");
  if (ext > 0) {
    const suffix = name.slice(ext);
    return name.slice(0, max - suffix.length - 3) + "..." + suffix;
  }
  return name.slice(0, max - 3) + "...";
}

/* ── Component ───────────────────────────────────────────────── */

export function ChatPanel() {
  /* ── State ─────────────────────────────────────────────────── */
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [maximized, setMaximized] = useState(false);

  const chatEnd = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── Load / save messages ─────────────────────────────────── */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed.slice(-MAX_MESSAGES));
        }
      }
    } catch {
      /* ignore corrupt storage */
    }
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(messages.slice(-MAX_MESSAGES))
      );
    }
  }, [messages]);

  /* ── Auto-scroll ───────────────────────────────────────────── */
  useEffect(() => {
    if (chatEnd.current) {
      chatEnd.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading]);

  /* ── Focus textarea when panel opens ────────────────────────── */
  useEffect(() => {
    if (open && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 150);
    }
  }, [open]);

  /* ── Auto-grow textarea ────────────────────────────────────── */
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 180) + "px";
    }
  }, []);

  useEffect(() => {
    autoGrow();
  }, [input, autoGrow]);

  /* ── File → base64 helper ──────────────────────────────────── */
  const fileToDataUrl = useCallback(
    (file: File): Promise<string> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    },
    []
  );

  /* ── Handle paste (clipboard images) ────────────────────────── */
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const dataUrl = await fileToDataUrl(file);
          setPendingImages((prev) => [
            ...prev,
            {
              dataUrl,
              name: `Screenshot_${Date.now()}.png`,
              uploading: false,
            },
          ]);
          return;
        }
      }
    },
    [fileToDataUrl]
  );

  /* ── Handle file selection ──────────────────────────────────── */
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) {
          const dataUrl = await fileToDataUrl(file);
          setPendingImages((prev) => [
            ...prev,
            { dataUrl, name: file.name, uploading: false },
          ]);
        }
      }
      // Reset so same file can be selected again
      e.target.value = "";
    },
    [fileToDataUrl]
  );

  /* ── Remove pending image ──────────────────────────────────── */
  const removePendingImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /* ── Upload a single image to dashboard upload API ──────────── */
  const uploadImage = useCallback(
    async (img: PendingImage): Promise<string> => {
      const base64 = img.dataUrl.split(",")[1];
      const mimeType = img.dataUrl.split(";")[0].split(":")[1];

      const res = await fetch("/api/dashboard/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: img.name,
          mimeType,
          base64,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error || `Upload failed: ${res.status}`);
      }

      const data = await res.json();
      return data.reply || "[Image analyzed]";
    },
    []
  );

  /* ── Send message ───────────────────────────────────────────── */
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    const hasImages = pendingImages.length > 0;

    if (!text && !hasImages) return;
    if (loading) return;

    setInput("");
    setError(null);

    const userMsg: ChatMessage = {
      role: "user",
      content: text || "(image upload)",
      id: `u-${Date.now()}`,
      ts: Date.now(),
      images: hasImages
        ? pendingImages.map((img) => ({
            dataUrl: img.dataUrl,
            name: img.name,
          }))
        : undefined,
    };

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      id: `a-${Date.now()}`,
      ts: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setLoading(true);

    try {
      // Build context: upload images first, get descriptions
      let imageContext = "";
      if (hasImages) {
        const descriptions: string[] = [];
        for (let i = 0; i < pendingImages.length; i++) {
          setPendingImages((prev) => {
            const updated = [...prev];
            updated[i] = { ...updated[i], uploading: true };
            return updated;
          });
          const desc = await uploadImage(pendingImages[i]);
          descriptions.push(
            `[Image: ${pendingImages[i].name}]\n${desc}`
          );
          setPendingImages((prev) => {
            const updated = [...prev];
            updated[i] = { ...updated[i], uploading: false };
            return updated;
          });
        }
        imageContext = descriptions.join("\n\n");
        setPendingImages([]);
      }

      // Build message array for chat API
      const chatMessages = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // If we have image context, prepend it as a system message
      if (imageContext) {
        chatMessages.unshift({
          role: "system",
          content: `The user shared the following image(s). Use this analysis as context:\n\n${imageContext}`,
        });
      }

      const res = await fetch("/api/dashboard/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ messages: chatMessages }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ") && !line.includes("[DONE]")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.text) {
                fullText += data.text;
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last && last.id === assistantMsg.id) {
                    updated[updated.length - 1] = {
                      ...last,
                      content: fullText,
                    };
                  }
                  return updated;
                });
              }
            } catch {
              /* skip parse errors */
            }
          }
        }
      }

      // Finalize the message
      if (fullText) {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.id === assistantMsg.id) {
            updated[updated.length - 1] = { ...last, content: fullText };
          }
          return updated;
        });
      }
    } catch (err: any) {
      setError(err?.message || "Chat failed");
      setMessages((prev) => prev.filter((m) => m.id !== assistantMsg.id));
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, pendingImages, uploadImage]);

  /* ── Key handler (textarea) ─────────────────────────────────── */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter sends (without Shift)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    // Escape closes panel
    if (e.key === "Escape") {
      setOpen(false);
    }
  };

  /* ── Copy message content to clipboard ──────────────────────── */
  const CopyButton = ({ text, className }: { text: string; className?: string }) => {
    const [copied, setCopied] = useState(false);

    return (
      <button
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          });
        }}
        className={`opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-gray-700/50 ${className || ""}`}
        title="Copy message"
      >
        {copied ? (
          <Check size={12} className="text-green-400" />
        ) : (
          <Copy size={12} className="text-zinc-500" />
        )}
      </button>
    );
  };

  /* ── Clear chat ────────────────────────────────────────────── */
  const clearChat = () => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
    setError(null);
  };

  /* ── Panel dimensions ──────────────────────────────────────── */
  const panelWidth = maximized ? "min-w-[90vw]" : "w-[520px]";
  const panelHeight = maximized
    ? "h-[80vh]"
    : "max-h-[calc(100vh-8rem)] min-h-[460px]";
  const toggleIcon = maximized ? Minimize2 : Maximize2;

  /* ── Render ────────────────────────────────────────────────── */
  return (
    <>
      {/* ── Toggle FAB ──────────────────────────────────────── */}
      <button
        onClick={() => setOpen(!open)}
        className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg hover:bg-indigo-500 transition-all duration-200 hover:scale-105 active:scale-95"
        title="Toggle AI Assistant"
      >
        {open ? <X size={20} /> : <MessageCircle size={20} />}
      </button>

      {/* ── Chat panel ──────────────────────────────────────── */}
      {open && (
        <div
          className={`fixed bottom-20 right-4 z-50 flex flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl transition-all duration-200 ${panelWidth} ${panelHeight}`}
          style={{ resize: maximized ? "none" : "horizontal", overflow: "hidden" }}
        >
          {/* ── Header ──────────────────────────────────────── */}
          <div className="flex items-center justify-between border-b border-gray-700 px-4 py-2.5 shrink-0">
            <div className="flex items-center gap-2">
              <Bot size={18} className="text-indigo-400" />
              <span className="font-semibold text-sm text-zinc-100">Aria</span>
              {loading && (
                <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                  <Loader2 size={10} className="animate-spin" />
                  thinking
                </span>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setMaximized(!maximized)}
                className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors rounded hover:bg-gray-800"
                title={maximized ? "Minimize" : "Maximize"}
              >
                {maximized ? (
                  <Minimize2 size={14} />
                ) : (
                  <Maximize2 size={14} />
                )}
              </button>
              <button
                onClick={clearChat}
                className="px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                title="Clear chat history"
              >
                Clear
              </button>
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors rounded hover:bg-gray-800"
              >
                <ChevronDown size={14} />
              </button>
            </div>
          </div>

          {/* ── Messages ────────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 scrollbar-thin">
            {messages.length === 0 && !loading && (
              <div className="flex flex-col items-center justify-center h-full text-center text-zinc-500 px-4">
                <Bot size={36} className="mb-3 opacity-30" />
                <p className="text-xs text-zinc-600 mb-1">AI Operations Assistant</p>
                <p className="text-[11px] text-zinc-600">
                  Paste screenshots, drop images, or ask about
                </p>
                <p className="text-[11px] text-zinc-600">
                  purchasing, inventory, and operations.
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-2 group ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                {msg.role === "assistant" && (
                  <Bot
                    size={16}
                    className="mt-2 shrink-0 text-indigo-400 self-start"
                  />
                )}

                <div
                  className={`relative max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === "user"
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-800 text-zinc-200"
                  }`}
                >
                  {/* Copy button (top-right on hover) */}
                  {msg.content && (
                    <CopyButton
                      text={msg.content}
                      className="absolute -top-1 -right-1"
                    />
                  )}

                  {/* User message: show image thumbnails + text */}
                  {msg.role === "user" ? (
                    <div className="space-y-1.5">
                      {msg.images && msg.images.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {msg.images.map((img, i) => (
                            <div
                              key={i}
                              className="relative group/image"
                              title={img.name}
                            >
                              <img
                                src={img.dataUrl}
                                alt={img.name}
                                className="max-h-28 rounded border border-indigo-500/30 object-contain"
                              />
                              <span className="absolute bottom-0.5 left-0.5 bg-black/60 text-[9px] text-zinc-300 px-1 rounded truncate max-w-[100px]">
                                {truncateFilename(img.name)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {msg.content && msg.content !== "(image upload)" && (
                        <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {msg.content}
                        </p>
                      )}
                    </div>
                  ) : (
                    /* Assistant message: render markdown */
                    msg.content ? (
                      <MarkdownRenderer content={msg.content} />
                    ) : loading && msg.id === messages[messages.length - 1]?.id ? (
                      <span className="inline-flex gap-0.5 items-center h-5">
                        <span
                          className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
                          style={{ animationDelay: "0ms" }}
                        />
                        <span
                          className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
                          style={{ animationDelay: "150ms" }}
                        />
                        <span
                          className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
                          style={{ animationDelay: "300ms" }}
                        />
                      </span>
                    ) : null
                  )}

                  {/* Timestamp */}
                  {msg.content && (
                    <div
                      className={`text-[9px] mt-1 ${
                        msg.role === "user"
                          ? "text-indigo-300/60 text-right"
                          : "text-zinc-600"
                      }`}
                    >
                      {formatTime(msg.ts)}
                    </div>
                  )}
                </div>

                {msg.role === "user" && (
                  <User
                    size={16}
                    className="mt-2 shrink-0 text-indigo-300 self-start"
                  />
                )}
              </div>
            ))}

            {error && (
              <div className="rounded-lg bg-rose-900/30 px-3 py-2 text-[11px] text-rose-400 border border-rose-800">
                {error}
              </div>
            )}

            <div ref={chatEnd} />
          </div>

          {/* ── Input area ──────────────────────────────────── */}
          <div className="border-t border-gray-700 px-3 py-2.5 shrink-0">
            {/* Pending image thumbnails */}
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {pendingImages.map((img, i) => (
                  <div
                    key={i}
                    className="relative group/img rounded-lg overflow-hidden border border-gray-600"
                  >
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      className="h-14 w-20 object-cover"
                    />
                    <button
                      onClick={() => removePendingImage(i)}
                      className="absolute top-0.5 right-0.5 bg-black/60 rounded-full p-0.5 opacity-0 group-hover/img:opacity-100 transition-opacity hover:bg-red-700/80"
                      title="Remove"
                    >
                      <Trash2 size={10} className="text-white" />
                    </button>
                    <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[8px] text-zinc-300 px-1 truncate text-center">
                      {truncateFilename(img.name, 18)}
                    </span>
                    {img.uploading && (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                        <Loader2 size={12} className="animate-spin text-white" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 items-end">
              {/* File picker button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center justify-center rounded-lg bg-gray-800 p-2 text-zinc-400 hover:text-zinc-200 hover:bg-gray-700 transition-colors border border-gray-700 shrink-0"
                title="Attach image"
                disabled={loading}
              >
                <Paperclip size={16} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Ask about purchasing, orders, or inventory... (Paste screenshots)"
                disabled={loading}
                rows={1}
                className="flex-1 rounded-lg bg-gray-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 border border-gray-700 focus:outline-none focus:border-indigo-500 disabled:opacity-50 resize-none min-h-[38px] max-h-[180px]"
                style={{ lineHeight: "1.4" }}
              />

              {/* Send button */}
              <button
                onClick={sendMessage}
                disabled={(!input.trim() && pendingImages.length === 0) || loading}
                className="flex items-center justify-center rounded-lg bg-indigo-600 px-3 py-2 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0 h-[38px]"
                title="Send message (Enter)"
              >
                {loading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Send size={16} />
                )}
              </button>
            </div>

            {/* Hint text */}
            <div className="mt-1 text-[9px] text-zinc-600 text-right">
              Enter to send · Shift+Enter new line · Paste screenshots
            </div>
          </div>
        </div>
      )}
    </>
  );
}