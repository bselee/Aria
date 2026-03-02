"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Terminal } from "lucide-react";

type Message = {
    role: "user" | "assistant" | "system";
    content: string;
};

export default function AgentTerminal() {
    const [messages, setMessages] = useState<Message[]>([
        { role: "system", content: "Connected to Aria Core. Ready for commands. Try '/reconcile' or ask a question." }
    ]);
    const [input, setInput] = useState("");
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim()) return;

        const userMsg = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userMsg }]);

        try {
            const response = await fetch('/api/dashboard/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: [...messages, { role: "user", content: userMsg }] }),
            });

            if (!response.ok) throw new Error('API Error');
            const data = await response.json();

            setMessages(prev => [...prev, {
                role: "assistant",
                content: data.message || "No response received."
            }]);
        } catch (error) {
            setMessages(prev => [...prev, {
                role: "system",
                content: "Error: Connection to Aria Core failed. Please try again."
            }]);
        }
    };

    return (
        <div className="flex flex-col h-full">
            <header className="px-4 py-3 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-md flex justify-between items-center shrink-0">
                <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-zinc-400" />
                    <h2 className="text-xs font-semibold text-zinc-300 tracking-wider uppercase font-mono">Aria Comm-Link</h2>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-emerald-500 uppercase tracking-widest">Online</span>
                    <span className="flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse"></span>
                </div>
            </header>

            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 bg-[#0c0c0e]">
                {messages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div
                            className={`max-w-[85%] rounded-lg p-3 text-sm ${msg.role === "system"
                                ? "bg-transparent text-zinc-500 font-mono text-xs w-full text-center border border-zinc-800/50 block"
                                : msg.role === "user"
                                    ? "bg-zinc-800 text-zinc-200 rounded-br-none"
                                    : "bg-neon-blue/10 border border-neon-blue/20 text-blue-100 rounded-bl-none font-mono"
                                }`}
                        >
                            {msg.role === "assistant" && <div className="text-[10px] uppercase tracking-widest text-neon-blue mb-1 opacity-70">Aria</div>}
                            {msg.content}
                        </div>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>

            <div className="p-4 border-t border-zinc-800 bg-[#0f0f11] shrink-0">
                <form onSubmit={handleSubmit} className="relative flex items-center">
                    <span className="absolute left-3 text-neon-purple font-mono font-bold text-lg">~</span>
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Command Aria..."
                        className="w-full bg-zinc-900/50 border border-zinc-800 rounded-lg py-3 pl-8 pr-10 text-sm focus:outline-none focus:ring-1 focus:ring-neon-purple focus:border-neon-purple transition-all placeholder:text-zinc-600 font-mono text-zinc-200"
                    />
                    <button
                        type="submit"
                        disabled={!input.trim()}
                        className="absolute right-2 p-1.5 rounded-md text-zinc-500 hover:text-neon-purple hover:bg-neon-purple/10 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
                    >
                        <Send className="w-4 h-4" />
                    </button>
                </form>
            </div>
        </div>
    );
}
