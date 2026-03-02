"use client";

import { useEffect, useRef, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import { MessageSquare, Radio, Bot, Send, Loader2 } from "lucide-react";

type ChatLog = {
    id: string;
    created_at: string;
    source: "telegram" | "slack";
    role: "user" | "assistant";
    content: string;
    metadata: any;
};

export default function ChatMirror() {
    const [logs, setLogs] = useState<ChatLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [input, setInput] = useState("");
    const [sending, setSending] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const send = async () => {
        const text = input.trim();
        if (!text || sending) return;
        setInput("");
        setSending(true);
        try {
            await fetch("/api/dashboard/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: text }),
            });
        } catch (e: any) {
            console.error("Send error:", e.message);
        } finally {
            setSending(false);
            textareaRef.current?.focus();
        }
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (!files.length || sending) return;
        setSending(true);
        for (const file of files) {
            try {
                const base64 = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve((reader.result as string).split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
                await fetch("/api/dashboard/upload", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ filename: file.name, mimeType: file.type, base64 }),
                });
            } catch (err: any) {
                console.error("Upload error:", err.message);
            }
        }
        setSending(false);
        textareaRef.current?.focus();
    };

    useEffect(() => {
        const supabase = createBrowserClient();

        const fetchLogs = async () => {
            const { data } = await supabase
                .from("sys_chat_logs")
                .select("*")
                .order("created_at", { ascending: false })
                .limit(50);

            if (data) setLogs(data.reverse());
            setLoading(false);
        };

        fetchLogs();

        const subscription = supabase
            .channel("sys_chat_logs_changes")
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "sys_chat_logs" },
                (payload: any) => {
                    setLogs((current) => [...current, payload.new as ChatLog].slice(-50));
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(subscription);
        };
    }, []);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [logs]);

    if (loading) {
        return (
            <div className="flex flex-col h-full">
                <MirrorHeader />
                <div className="flex-1 flex flex-col items-center justify-center text-zinc-500">
                    <div className="w-6 h-6 border-2 border-neon-blue border-t-transparent rounded-full animate-spin mb-4" />
                    <p className="font-mono text-sm tracking-widest uppercase">Connecting to Feed...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            <MirrorHeader />

            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 bg-[#0c0c0e] scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent">
                {logs.length === 0 && (
                    <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 py-20">
                        <Radio className="w-8 h-8 mb-3 opacity-30" />
                        <p className="font-mono text-xs tracking-widest uppercase">Awaiting transmissions...</p>
                    </div>
                )}

                {logs.map((log) => {
                    // Slack detection — full-width amber card
                    if (log.source === "slack") {
                        return (
                            <div key={log.id} className="w-full">
                                <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-3">
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">
                                            Slack #{log.metadata?.channel || "unknown"}
                                        </span>
                                        {log.metadata?.matchedProduct && (
                                            <span className="text-[10px] font-mono text-zinc-400 truncate">
                                                → {log.metadata.matchedProduct}
                                            </span>
                                        )}
                                        <span className="ml-auto text-[10px] font-mono text-zinc-600 shrink-0">
                                            {new Date(log.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                        </span>
                                    </div>
                                    <p className="text-xs text-zinc-300 leading-relaxed">{log.content}</p>
                                    {log.metadata?.userName && (
                                        <p className="text-[10px] text-zinc-600 mt-1 font-mono">
                                            from {log.metadata.userName}
                                            {log.metadata.activePO ? ` · PO: ${log.metadata.activePO}` : ""}
                                        </p>
                                    )}
                                </div>
                            </div>
                        );
                    }

                    // Telegram messages — chat bubble style
                    const isUser = log.role === "user";
                    const fromDash = log.metadata?.from === "dashboard";
                    return (
                        <div key={log.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                            <div className={`max-w-[85%] flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
                                {!isUser && (
                                    <div className="flex items-center gap-1.5 ml-1">
                                        <Bot className="w-3 h-3 text-neon-blue opacity-70" />
                                        <span className="text-[10px] font-mono uppercase tracking-widest text-neon-blue opacity-70">Aria</span>
                                    </div>
                                )}
                                {isUser && fromDash && (
                                    <span className="text-[10px] font-mono text-zinc-600 mr-1">dash</span>
                                )}
                                <div
                                    className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${isUser
                                            ? "bg-zinc-800 text-zinc-200 rounded-br-none"
                                            : "bg-neon-blue/10 border border-neon-blue/20 text-blue-100 rounded-bl-none font-mono"
                                        }`}
                                >
                                    {log.content}
                                </div>
                                <span className="text-[10px] font-mono text-zinc-600 mx-1">
                                    {new Date(log.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                </span>
                            </div>
                        </div>
                    );
                })}

                <div ref={bottomRef} />
            </div>

            {/* Bidirectional Input */}
            <div className="p-3 border-t border-zinc-800 bg-zinc-900 shrink-0">
                <form
                    className={`relative flex items-end gap-2 bg-[#0c0c0e] border rounded-lg p-2 transition-all shadow-inner focus-within:ring-1 focus-within:ring-neon-blue/20 ${dragOver ? "border-neon-blue/60 bg-neon-blue/5" : "border-zinc-700/50 focus-within:border-neon-blue/50"}`}
                    onSubmit={(e) => e.preventDefault()}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
                    onDrop={handleDrop}
                >
                    <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                send();
                            }
                        }}
                        disabled={sending}
                        className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 resize-none min-h-[40px] max-h-[120px] overflow-y-auto p-2 focus:outline-none disabled:opacity-50"
                        placeholder="Message Aria… or drop a file (Enter to send)"
                        rows={1}
                    />
                    <button
                        type="button"
                        onClick={send}
                        disabled={!input.trim() || sending}
                        className="p-2 shrink-0 text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors self-end rounded mb-0.5"
                    >
                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    </button>
                </form>
            </div>
        </div>
    );
}

function MirrorHeader() {
    return (
        <header className="px-4 py-3 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-md flex justify-between items-center shrink-0">
            <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-zinc-400" />
                <h2 className="text-xs font-semibold text-zinc-300 tracking-wider uppercase font-mono">Aria Chat</h2>
            </div>
            <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                    <span className="text-[10px] font-mono text-blue-400 uppercase tracking-widest">TG</span>
                    <span className="flex h-1.5 w-1.5 rounded-full bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.8)] animate-pulse" />
                </span>
                <span className="flex items-center gap-1.5">
                    <span className="text-[10px] font-mono text-amber-400 uppercase tracking-widest">Slack</span>
                    <span className="flex h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)] animate-pulse" />
                </span>
            </div>
        </header>
    );
}
