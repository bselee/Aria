"""
Barcode reader for label artwork.
Usage:
    python barcode-read.py <image_path>           # Read barcodes from an image
    python barcode-read.py <pdf_path> <out_png>   # Convert PDF to PNG, then read barcodes

Returns JSON array of {type, data} for each detected barcode.
"""

import sys
import json
import os

def read_barcodes(image_path):
    """Read all barcodes from an image file."""
    from pyzbar.pyzbar import decode
    from PIL import Image
    img = Image.open(image_path)
    codes = decode(img)
    return [{"type": c.type, "data": c.data.decode("utf-8")} for c in codes]

if len(sys.argv) < 2:
    print(json.dumps([]))
    sys.exit(0)

arg1 = sys.argv[1]

if arg1.lower().endswith('.pdf'):
    # PDF mode: convert to PNG first, then read barcode
    import fitz
    import tempfile
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        out_png = f.name
    doc = fitz.open(arg1)
    page = doc[0]
    pix = page.get_pixmap(dpi=200)
    pix.save(out_png)
    doc.close()
    result = read_barcodes(out_png)
    os.unlink(out_png)
else:
    # Direct image mode
    result = read_barcodes(arg1)

print(json.dumps(result))
