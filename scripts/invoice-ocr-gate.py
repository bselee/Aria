#!/usr/bin/env python3
"""
invoice-ocr-gate.py — render page 1 of a PDF and OCR it for the Bill.com
pre-send gate.

PURPOSE
    Pure extraction primitive for src/lib/intelligence/ap/invoice-ocr-gate.ts.
    Renders page 1 at 300 DPI via PyMuPDF, runs tesseract CLI, and prints a
    JSON object with the raw text plus the specific signals the gate needs:
      - invoice-number candidates (INVOICE # / NUMBER / PRO NUMBER / INV #)
      - ticket-number signal (weight tickets are NOT invoices)
      - customer/account-number contaminants (AAA Cooper "1159492")

    The TypeScript side makes the PASS/BLOCK decision; this script only
    extracts. Never raises — on any failure it prints {"ok": false, ...}.

USAGE
    python invoice-ocr-gate.py <input.pdf> [<out.png>]

OUTPUT (JSON on stdout)
    {
      "ok": true,
      "rendered": true,
      "dpi": 300,
      "invoiceNumberHits": ["64058402", ...],
      "ticketHits": true|false,
      "customerNumberHits": ["1159492", ...],
      "rawText": "<first 2500 chars of OCR text>"
    }
"""

import json
import re
import subprocess
import sys
import tempfile
import os


def render_page1(pdf_path, out_png, dpi=300):
    """Render page 1 to PNG via PyMuPDF. Returns (ok, err_msg)."""
    try:
        import pymupdf  # noqa: F401
    except ImportError:
        try:
            import fitz as pymupdf  # older installs
        except ImportError:
            return False, "pymupdf not installed"

    try:
        doc = pymupdf.open(pdf_path)
        if doc.page_count == 0:
            return False, "PDF has no pages"
        page = doc[0]
        pix = page.get_pixmap(dpi=dpi)
        pix.save(out_png)
        doc.close()
        return True, None
    except Exception as e:  # noqa: BLE001
        return False, f"render failed: {e}"


def ocr_png(png_path):
    """Run tesseract CLI on a PNG. Returns (text, ok)."""
    try:
        out = subprocess.run(
            ["tesseract", png_path, "stdout", "--psm", "6"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        # tesseract writes to stdout even on partial success; accept any text
        return out.stdout, True
    except FileNotFoundError:
        return "", False
    except Exception as e:  # noqa: BLE001
        return f"{e}", False


_INVOICE_PATTERNS = [
    re.compile(r"INVOICE\s*#\s*([A-Z0-9][A-Z0-9\-. ]{2,})", re.IGNORECASE),
    re.compile(r"INVOICE\s*(?:NO\.?|NUMBER)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-. ]{2,})", re.IGNORECASE),
    re.compile(r"PRO\s*(?:NO\.?|NUMBER|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-. ]{2,})", re.IGNORECASE),
    re.compile(r"INV\s*#\s*([A-Z0-9][A-Z0-9\-. ]{2,})", re.IGNORECASE),
]

_TICKET_PATTERN = re.compile(r"TICKET\s*#", re.IGNORECASE)

# AAA Cooper customer number — the identifier Bill.com mis-reads as the
# invoice number. Redaction must remove every occurrence before send.
# NOTE: "3746570" (SHIPPER number) is intentionally NOT flagged — it sits in
# a labeled "SHIPPER" field and appears legitimately on every invoice, so it
# would false-alarm every send. Only 1159492 is the redaction target.
_CUSTOMER_PATTERNS = [
    re.compile(r"0*1159492"),
]

# Words that must NOT be treated as an invoice-number token.
_STOPWORDS = {"INQUIRIES", "INQUIRY", "NUMBER", "NO", "DATE", "PAGE", "TOTAL"}


def extract(text):
    """Extract the gate's signals from OCR text."""
    text = text or ""
    inv_hits = []
    for pat in _INVOICE_PATTERNS:
        for m in pat.finditer(text):
            token = m.group(1).strip()
            # trim trailing loose letters/whitespace artifacts
            token = re.sub(r"\s+", "", token)
            if len(token) >= 2 and token.upper() not in _STOPWORDS:
                inv_hits.append(token)
    ticket_hits = bool(_TICKET_PATTERN.search(text))
    cust_hits = []
    for pat in _CUSTOMER_PATTERNS:
        for m in pat.finditer(text):
            cust_hits.append(m.group(0))
    # de-dupe preserving order
    inv_hits = list(dict.fromkeys(inv_hits))
    cust_hits = list(dict.fromkeys(cust_hits))
    return inv_hits, ticket_hits, cust_hits


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: invoice-ocr-gate.py <pdf> [<png>]"}))
        return 1

    pdf_path = sys.argv[1]
    out_png = sys.argv[2] if len(sys.argv) > 2 else None

    if not os.path.exists(pdf_path):
        print(json.dumps({"ok": False, "error": "pdf not found"}))
        return 1

    tmp_owned = False
    if not out_png:
        fd, out_png = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        tmp_owned = True

    try:
        ok, err = render_page1(pdf_path, out_png)
        if not ok:
            print(json.dumps({"ok": False, "rendered": False, "error": err}))
            return 1

        text, ocr_ok = ocr_png(out_png)
        if not ocr_ok:
            print(json.dumps({"ok": False, "rendered": True, "error": "tesseract not available"}))
            return 1

        inv_hits, ticket_hits, cust_hits = extract(text)
        print(json.dumps({
            "ok": True,
            "rendered": True,
            "dpi": 300,
            "invoiceNumberHits": inv_hits,
            "ticketHits": ticket_hits,
            "customerNumberHits": cust_hits,
            "rawText": (text or "")[:2500],
        }))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "rendered": False, "error": str(e)}))
        return 1
    finally:
        if tmp_owned and os.path.exists(out_png):
            try:
                os.remove(out_png)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
