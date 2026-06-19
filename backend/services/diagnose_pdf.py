"""
Run this from your backend folder, with the venv active, to see exactly what
extraction returns for your PDF:

    cd backend
    venv\Scripts\activate
    python diagnose_pdf.py "C:\path\to\your.pdf"

It tells you: whether OCR packages import, how much text the digital layer has,
and what the full OCR-aware extractor returns.
"""

import sys

pdf = sys.argv[1] if len(sys.argv) > 1 else None
if not pdf:
    print("Usage: python diagnose_pdf.py <path-to-pdf>")
    raise SystemExit(1)

print("=== 1. Are OCR packages importable in THIS environment? ===")
try:
    import pytesseract
    from pdf2image import convert_from_path
    print("  pytesseract + pdf2image: OK")
    try:
        print("  tesseract version:", pytesseract.get_tesseract_version())
    except Exception as e:
        print("  tesseract NOT reachable:", e)
except Exception as e:
    print("  OCR packages NOT importable here:", e)

print("\n=== 2. Digital text layer (pypdf only) ===")
from pypdf import PdfReader
r = PdfReader(pdf)
total = 0
for i, page in enumerate(r.pages):
    t = page.extract_text() or ""
    total += len(t.strip())
    print(f"  page {i+1}: {len(t.strip())} chars")
print(f"  TOTAL digital chars: {total}  (pages: {len(r.pages)})")

print("\n=== 3. OCR-aware extractor (services/ocr.py) ===")
try:
    from services.ocr import extract_pdf_text
    res = extract_pdf_text(pdf)
    print("  method:", res["method"])
    print("  pages:", res["pages"], "ocr_pages:", res.get("ocr_pages"))
    print("  total chars:", len(res["text"]))
    print("  first 200 chars:", repr(res["text"][:200]))
    if res.get("warning"):
        print("  warning:", res["warning"])
except Exception as e:
    print("  extract_pdf_text failed:", repr(e))