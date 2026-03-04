"use client";

import { useEffect, useRef, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import { MessageSquare, Radio, Bot, Send, Loader2, Plus, Paperclip, FolderPlus, X, Zap, ChevronDown } from "lucide-react";

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
    const [menuOpen, setMenuOpen] = useState(false);
    const [botMenuOpen, setBotMenuOpen] = useState(false);
    const [watchedFolders, setWatchedFolders] = useState<string[]>([]);
    const bottomRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const botMenuRef = useRef<HTMLDivElement>(null);

    // Collapse state — persisted to localStorage
    const [isCollapsed, setIsCollapsed] = useState(false);
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-chat-collapsed");
        if (s === "true") setIsCollapsed(true);
    }, []);
    useEffect(() => { localStorage.setItem("aria-dash-chat-collapsed", String(isCollapsed)); }, [isCollapsed]);

    const BOT_COMMANDS = [
        { label: "Run build risk analysis", text: "Run the 30-day build risk analysis." },
        { label: "Show recent invoices", text: "Show me the most recent invoices." },
        { label: "Show recent POs", text: "What's the status of our recent purchase orders?" },
        { label: "Search Internet", text: "Search the web for: " },
        { label: "Look up product", text: "Look up product SKU: " },
    ];

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setMenuOpen(false);
            }
            if (botMenuRef.current && !botMenuRef.current.contains(event.target as Node)) {
                setBotMenuOpen(false);
            }
        }
        if (menuOpen || botMenuOpen) {
            document.addEventListener("mousedown", handleClickOutside);
        }
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [menuOpen, botMenuOpen]);

    const processInvoice = async (log: ChatLog) => {
        try {
            const res = await fetch("/api/dashboard/invoice-action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action_type: log.metadata.action_type,
                    filename: log.metadata.filename,
                    bufferBase64: log.metadata.bufferBase64,
                    vendorName: log.metadata.vendorName,
                    total: log.metadata.total
                }),
            });
            if (!res.ok) {
                const err = await res.json();
                console.error("Failed to process invoice:", err);
                alert("Failed to process invoice: " + (err.error || "Unknown error"));
            } else {
                console.log("Triggered invoice processing");
            }
        } catch (e: any) {
            console.error("Action error:", e.message);
            alert("Action error: " + e.message);
        }
    };

    const send = async () => {
        const text = input.trim();
        if (!text || sending) return;
        setInput("");
        setSending(true);

        // Optimistic UI update
        const tempId = `temp-${Date.now()}`;
        setLogs(curr => [...curr, ({
            id: tempId,
            created_at: new Date().toISOString(),
            source: "telegram",
            role: "user",
            content: text,
            metadata: { from: "dashboard", isTemp: true }
        } as ChatLog)].slice(-50));

        try {
            const res = await fetch("/api/dashboard/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: text }),
            });
            const data = await res.json();

            if (data.reply) {
                // Keep the UI resilient if Realtime fails
                setLogs(curr => {
                    const exists = curr.find(c => c.content === data.reply && Math.abs(new Date(c.created_at).getTime() - Date.now()) < 5000);
                    if (exists) return curr;
                    return [...curr, ({
                        id: `temp-ast-${Date.now()}`,
                        created_at: new Date().toISOString(),
                        source: "telegram",
                        role: "assistant",
                        content: data.reply,
                        metadata: { from: "dashboard", isTemp: true }
                    } as ChatLog)].slice(-50);
                });
            }
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

    const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (!files.length || sending) return;
        setMenuOpen(false);
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
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleWatchFolder = async () => {
        setMenuOpen(false);
        const folderPath = window.prompt("Enter local absolute folder path on this PC (e.g. C:\\Users\\...\\Downloads):");
        if (!folderPath) return;
        try {
            const res = await fetch("/api/dashboard/watch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "add", folderPath })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            if (data.folders) setWatchedFolders(data.folders);
        } catch (e: any) {
            alert("Error watching folder: " + e.message);
        }
    };

    const handleUnwatchFolder = async (folderPath: string) => {
        try {
            const res = await fetch("/api/dashboard/watch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "remove", folderPath })
            });
            const data = await res.json();
            if (data.folders) setWatchedFolders(data.folders);
        } catch (e: any) {
            console.error("Unwatch error:", e.message);
        }
    };

    useEffect(() => {
        fetch("/api/dashboard/watch").then(res => res.json()).then(data => {
            if (data.folders) setWatchedFolders(data.folders);
        }).catch(() => { });
    }, []);

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
            <div className="flex flex-col h-full bg-zinc-900/50">
                <MirrorHeader isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} />
                {!isCollapsed && (
                    <div className="flex-1 flex flex-col items-center justify-center text-zinc-500">
                        <div className="w-6 h-6 border-2 border-neon-blue border-t-transparent rounded-full animate-spin mb-4" />
                        <p className="font-mono text-sm tracking-widest uppercase">Connecting to Feed...</p>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-zinc-900/50">
            <MirrorHeader isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} />

            {!isCollapsed && (
                <>
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
                                            {!isUser && log.metadata?.action_type === 'invoice_ready' && (
                                                <div className="mt-3">
                                                    <button
                                                        onClick={() => processInvoice(log)}
                                                        className="bg-neon-blue/20 hover:bg-neon-blue/40 text-neon-blue font-bold font-mono text-[10px] uppercase tracking-wider px-3 py-1.5 rounded transition-all shadow-sm flex items-center gap-1.5"
                                                    >
                                                        <span>⚡ Execute Send & Match PO</span>
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                        <span className="text-[10px] font-mono text-zinc-600 mx-1">
                                            {new Date(log.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                        </span>
                                    </div>
                                </div>
                            );
                        })}

                        {sending && (
                            <div className="flex justify-start animate-pulse">
                                <div className="max-w-[85%] flex flex-col gap-1 items-start">
                                    <div className="flex items-center gap-1.5 ml-1">
                                        <Bot className="w-3 h-3 text-neon-blue opacity-70" />
                                        <span className="text-[10px] font-mono uppercase tracking-widest text-neon-blue opacity-70">Aria working...</span>
                                    </div>
                                    <div className="rounded-lg px-4 py-3.5 bg-neon-blue/5 border border-neon-blue/20 rounded-bl-none flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 bg-neon-blue/60 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                                        <span className="w-1.5 h-1.5 bg-neon-blue/60 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                                        <span className="w-1.5 h-1.5 bg-neon-blue/60 rounded-full animate-bounce"></span>
                                    </div>
                                </div>
                            </div>
                        )}

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
                            <div className="flex items-center self-end mb-0.5 shrink-0 gap-1">
                                <div ref={menuRef} className="relative">
                                    <button
                                        type="button"
                                        onClick={() => { setMenuOpen(!menuOpen); setBotMenuOpen(false); }}
                                        className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors rounded"
                                        title="Attach or watch folder"
                                    >
                                        <Plus className={`w-4 h-4 transition-transform ${menuOpen ? 'rotate-45' : ''}`} />
                                    </button>

                                    {/* Plus Menu Popover */}
                                    {menuOpen && (
                                        <div className="absolute bottom-full left-0 mb-2 w-56 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-50 flex flex-col">
                                            <button
                                                type="button"
                                                onClick={() => fileInputRef.current?.click()}
                                                className="flex items-center gap-2 px-3 py-2.5 text-xs text-zinc-300 hover:bg-zinc-700/50 text-left transition-colors"
                                            >
                                                <Paperclip className="w-3.5 h-3.5" />
                                                Upload specific file(s)
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleWatchFolder}
                                                className="flex items-center gap-2 px-3 py-2.5 text-xs text-zinc-300 hover:bg-zinc-700/50 text-left transition-colors border-t border-zinc-700/50"
                                            >
                                                <FolderPlus className="w-3.5 h-3.5" />
                                                Watch local folder…
                                            </button>

                                            {watchedFolders.length > 0 && (
                                                <div className="border-t border-zinc-700/50 max-h-40 overflow-y-auto">
                                                    <div className="px-3 py-1.5 text-[9px] uppercase tracking-widest text-zinc-500 font-mono bg-zinc-800/80 sticky top-0">
                                                        Watched Folders
                                                    </div>
                                                    {watchedFolders.map(folder => (
                                                        <div key={folder} className="flex items-center justify-between px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-700/30 group">
                                                            <span className="truncate mr-2 flex-1" title={folder}>
                                                                {folder.split('\\').pop() || folder}
                                                            </span>
                                                            <button
                                                                type="button"
                                                                onClick={() => handleUnwatchFolder(folder)}
                                                                className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 text-zinc-500 transition-all rounded"
                                                                title="Stop watching"
                                                            >
                                                                <X className="w-3 h-3" />
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <input
                                    type="file"
                                    multiple
                                    className="hidden"
                                    ref={fileInputRef}
                                    onChange={handleFileInput}
                                />

                                <div ref={botMenuRef} className="relative">
                                    <button
                                        type="button"
                                        onClick={() => { setBotMenuOpen(!botMenuOpen); setMenuOpen(false); }}
                                        className={`p-2 transition-colors rounded hover:bg-zinc-800/50 ${botMenuOpen ? 'text-neon-blue' : 'text-zinc-500 hover:text-neon-blue'}`}
                                        title="Bot Commands"
                                    >
                                        <Zap className="w-4 h-4" />
                                    </button>

                                    {/* Bot Menu Popover */}
                                    {botMenuOpen && (
                                        <div className="absolute bottom-full left-0 mb-2 w-52 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-50 flex flex-col py-1">
                                            <div className="px-3 py-1.5 text-[9px] uppercase tracking-widest text-zinc-400 font-mono border-b border-zinc-700/50 mb-1">
                                                Quick Commands
                                            </div>
                                            {BOT_COMMANDS.map((cmd, idx) => (
                                                <button
                                                    key={idx}
                                                    type="button"
                                                    onClick={() => {
                                                        setInput(cmd.text);
                                                        setBotMenuOpen(false);
                                                        textareaRef.current?.focus();
                                                    }}
                                                    className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700/50 text-left transition-colors"
                                                >
                                                    <Bot className="w-3.5 h-3.5 opacity-50 text-neon-blue" />
                                                    {cmd.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

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
                    </div >
                </>
            )}
        </div >
    );
}

function MirrorHeader({ isCollapsed, setIsCollapsed }: { isCollapsed: boolean, setIsCollapsed: (v: boolean) => void }) {
    return (
        <header className="px-4 py-3 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-md flex justify-between items-center shrink-0">
            <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-zinc-400" />
                <h2 className="text-xs font-semibold text-zinc-300 tracking-wider uppercase font-mono">Chat Mirror</h2>
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
                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors ml-1"
                >
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
                </button>
            </div>
        </header>
    );
}
