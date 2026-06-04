/** @file MarkdownRenderer — lightweight markdown-to-React without deps
 *  @purpose Renders assistant messages as formatted markdown in ChatPanel.
 *           No external libraries needed (npm install is slow on this host).
 *           Handles bold, italic, code blocks + inline code, links, lists.
 *  @author Hermia
 *  @created 2026-06-02
 *  @deps react
 */

"use client";

import React, { useState, useCallback } from "react";
import { Check, Copy } from "lucide-react";

/* ── Escape HTML ─────────────────────────────────────────────── */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ── Code block component with copy button ───────────────────── */

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [code]);

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden border border-gray-700 bg-gray-950">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-900 border-b border-gray-700">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono">
          {language || "code"}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Copy code"
        >
          {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[12px] leading-relaxed">
        <code className="text-zinc-200 font-mono">{code}</code>
      </pre>
    </div>
  );
}

/* ── Inline code span ────────────────────────────────────────── */

function InlineCode({ code }: { code: string }) {
  return (
    <code className="px-1 py-0.5 rounded bg-gray-800 text-indigo-300 text-[11px] font-mono">
      {code}
    </code>
  );
}

/* ── Inline formatting helpers ────────────────────────────────── */

function renderBoldItalic(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Bold: **text**
    const boldMatch = remaining.match(/^([\s\S]*?)\*\*([^*]+)\*\*([\s\S]*)/);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(boldMatch[1]);
      parts.push(<strong key={`b-${parts.length}`}>{boldMatch[2]}</strong>);
      remaining = boldMatch[3];
      continue;
    }

    // Italic: *text*
    const italicMatch = remaining.match(/^([\s\S]*?)\*([^*]+)\*([\s\S]*)/);
    if (italicMatch) {
      if (italicMatch[1]) parts.push(italicMatch[1]);
      parts.push(<em key={`i-${parts.length}`}>{italicMatch[2]}</em>);
      remaining = italicMatch[3];
      continue;
    }

    // Nothing left — plain text
    parts.push(remaining);
    break;
  }

  return parts;
}

function renderInlineSimple(text: string): React.ReactNode[] {
  const segments: React.ReactNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Links: [text](url)
    const linkMatch = remaining.match(
      /^([\s\S]*?)\[([^\]]+)\]\(([^)]+)\)([\s\S]*)/
    );
    if (linkMatch) {
      if (linkMatch[1]) segments.push(...renderBoldItalic(linkMatch[1]));
      segments.push(
        <a
          key={`ln-${segments.length}`}
          href={linkMatch[3]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-400 underline hover:text-indigo-300"
        >
          {linkMatch[2]}
        </a>
      );
      remaining = linkMatch[4];
      continue;
    }

    // Inline code: `code` — must process before bold/italic
    const codeMatch = remaining.match(/^([\s\S]*?)`([^`]+)`([\s\S]*)/);
    if (codeMatch) {
      if (codeMatch[1]) segments.push(...renderBoldItalic(codeMatch[1]));
      segments.push(<InlineCode key={`ic-${segments.length}`} code={codeMatch[2]} />);
      remaining = codeMatch[3];
      continue;
    }

    // No more markers — render remaining with bold/italic
    segments.push(...renderBoldItalic(remaining));
    break;
  }

  return segments;
}

/* ── Tokeniser ────────────────────────────────────────────────── */

interface Token {
  type: "codeblock" | "text" | "list" | "empty-line";
  content: string;
  language?: string;
  items?: string[];
}

function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block fenced with ```
    if (line.trimStart().startsWith("```")) {
      const language = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      tokens.push({
        type: "codeblock",
        content: codeLines.join("\n"),
        language: language || undefined,
      });
      continue;
    }

    // Bullet list items (group consecutive)
    if (/^\s*[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      tokens.push({ type: "list", content: "", items });
      continue;
    }

    // Ordered list items
    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      tokens.push({ type: "list", content: "", items });
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      tokens.push({ type: "empty-line", content: "" });
      i++;
      continue;
    }

    // Plain text
    tokens.push({ type: "text", content: line });
    i++;
  }

  return tokens;
}

/* ── Main MarkdownRenderer component ─────────────────────────── */

export function MarkdownRenderer({ content }: { content: string }) {
  if (!content) return null;

  const tokens = tokenise(content);

  return (
    <div className="space-y-1 text-sm leading-relaxed [&_p]:my-0">
      {tokens.map((token, i) => {
        switch (token.type) {
          case "codeblock":
            return (
              <CodeBlock
                key={`cb-${i}`}
                language={token.language || ""}
                code={token.content}
              />
            );

          case "list":
            return (
              <ul
                key={`ul-${i}`}
                className="list-disc list-inside space-y-0.5 text-zinc-200"
              >
                {token.items?.map((item, j) => (
                  <li key={j}>
                    <span>{renderInlineSimple(escapeHtml(item))}</span>
                  </li>
                ))}
              </ul>
            );

          case "empty-line":
            return <div key={`el-${i}`} className="h-2" />;

          case "text":
          default: {
            // Check for heading: ## text
            const headingMatch = token.content.match(/^(#{1,3})\s(.+)/);
            if (headingMatch) {
              const level = headingMatch[1].length;
              const sizes: Record<number, string> = {
                1: "text-base font-bold text-zinc-100 mt-3 mb-1",
                2: "text-sm font-semibold text-zinc-100 mt-2 mb-1",
                3: "text-[13px] font-semibold text-zinc-200 mt-1 mb-0.5",
              };
              const Tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
              return (
                <Tag key={`h-${i}`} className={sizes[level] || sizes[3]}>
                  {renderInlineSimple(escapeHtml(headingMatch[2]))}
                </Tag>
              );
            }

            // Horizontal rule
            if (/^---+\s*$/.test(token.content)) {
              return <hr key={`hr-${i}`} className="border-gray-700 my-2" />;
            }

            return (
              <p key={`p-${i}`} className="text-zinc-200">
                {renderInlineSimple(escapeHtml(token.content))}
              </p>
            );
          }
        }
      })}
    </div>
  );
}