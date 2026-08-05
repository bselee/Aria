#!/usr/bin/env python
"""
@file scripts/web_search.py
@purpose Free web search and extraction — replaces Firecrawl/Browserbase with DDGS + requests.
@author Hermia
@created 2026-08-05
@deps ddgs, requests, beautifulsoup4
@usage
  python scripts/web_search.py search "query" [--max 5]
  python scripts/web_search.py extract "https://..." [--text]
  python scripts/web_search.py fetch "https://..."  # raw HTML
"""

import argparse
import json
import sys
from typing import Optional

import requests
from bs4 import BeautifulSoup

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def search(query: str, max_results: int = 5) -> list[dict]:
    """Search DuckDuckGo and return results as structured dicts."""
    from ddgs import DDGS
    results = []
    try:
        for r in DDGS().text(query, max_results=max_results):
            results.append({
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "snippet": r.get("body", ""),
            })
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
    return results


def extract(url: str, text_only: bool = False) -> dict:
    """Fetch a URL and extract readable content."""
    resp = requests.get(url, timeout=15, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()

    content_type = resp.headers.get("Content-Type", "")
    result = {
        "url": url,
        "status": resp.status_code,
        "content_type": content_type,
        "size_bytes": len(resp.content),
    }

    if "text/html" in content_type:
        soup = BeautifulSoup(resp.text, "html.parser")
        # Remove script/style
        for tag in soup(["script", "style", "nav", "footer", "header"]):
            tag.decompose()
        if text_only:
            lines = [l.strip() for l in soup.get_text(separator="\n").split("\n") if l.strip()]
            result["text"] = "\n".join(lines)
            result["text_lines"] = len(lines)
        else:
            result["title"] = soup.title.string if soup.title else None
            result["html"] = resp.text[:200_000]  # cap
    elif content_type.startswith("text/"):
        result["text"] = resp.text[:200_000]
    else:
        result["binary"] = True

    return result


def fetch_raw(url: str, output_path: Optional[str] = None) -> None:
    """Download a URL to a file. For images/PDFs to feed vision_analyze."""
    resp = requests.get(url, timeout=30, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()

    if output_path:
        with open(output_path, "wb") as f:
            f.write(resp.content)
        print(json.dumps({"saved": output_path, "size": len(resp.content), "type": resp.headers.get("Content-Type", "")}))
    else:
        # Print to stdout (careful with binary)
        ct = resp.headers.get("Content-Type", "")
        if ct.startswith("text/") or ct == "application/json":
            print(resp.text[:200_000])
        else:
            print(json.dumps({"binary": True, "size": len(resp.content), "type": ct}))


def main():
    parser = argparse.ArgumentParser(description="Free web search & extraction")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("search")
    p.add_argument("query", type=str)
    p.add_argument("--max", type=int, default=5)

    p = sub.add_parser("extract")
    p.add_argument("url", type=str)
    p.add_argument("--text", action="store_true", help="Text-only output")

    p = sub.add_parser("fetch")
    p.add_argument("url", type=str)
    p.add_argument("--output", "-o", type=str, default=None)

    args = parser.parse_args()

    if args.command == "search":
        results = search(args.query, args.max)
        print(json.dumps(results, indent=2, ensure_ascii=False))
    elif args.command == "extract":
        result = extract(args.url, args.text)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif args.command == "fetch":
        fetch_raw(args.url, args.output)


if __name__ == "__main__":
    main()
