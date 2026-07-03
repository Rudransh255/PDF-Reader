
from pypdf import PdfReader
import os
import logging

log = logging.getLogger("pdfbuddy.ocr")

                                                                             
TESSERACT_EXE = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

def _configure_tesseract():
    if os.path.exists(TESSERACT_EXE):
        import pytesseract
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_EXE

                                                                              

def _ocr_available():
    try:
        import pytesseract              
        from pdf2image import convert_from_path              
        _configure_tesseract()
                                                                              
        ver = pytesseract.get_tesseract_version()
        log.info("OCR available: tesseract %s", ver)
        return True
    except Exception as e:
                                                                                 
        log.warning("OCR not available — %s: %s", type(e).__name__, e)
        log.warning("  (looked for tesseract at: %s)", TESSERACT_EXE)
        return False

def ocr_pdf_path(path, dpi=200, lang="eng"):
    """Run OCR over every page of a PDF given its file path. Returns text."""
    import pytesseract
    from pdf2image import convert_from_path
    _configure_tesseract()

    images = convert_from_path(path, dpi=dpi)
    out = []
    for i, image in enumerate(images):
        page_text = pytesseract.image_to_string(image, lang=lang)
        if page_text.strip():
            out.append(page_text)
        log.info("OCR page %d/%d: %d chars", i + 1, len(images), len(page_text))
    return "\n".join(out)

# resource bounds so one hostile/huge upload can't exhaust the server:
# pages beyond MAX_PAGES are skipped, and OCR (the expensive path — each page
# becomes a full bitmap) is limited to the first MAX_OCR_PAGES scanned pages.
MAX_PAGES = 1500
MAX_OCR_PAGES = 40


def extract_pdf_text(path, min_chars_per_page=20, dpi=200, lang="eng"):
    """
    Extract text from a PDF, using the digital text layer where available and
    OCR where it is missing.

    Returns a dict: {
      "text": full extracted text,
      "method": "text" | "ocr" | "mixed" | "empty",
      "pages": page count,
      "ocr_pages": number of pages that needed OCR,
    }
    """
    reader = PdfReader(path)
    n = len(reader.pages)
    page_cap_warning = None
    if n > MAX_PAGES:
        page_cap_warning = f"Only the first {MAX_PAGES} of {n} pages were processed."

    digital_pages = []
    needs_ocr = []
    for idx, page in enumerate(reader.pages):
        if idx >= MAX_PAGES:
            break
        t = page.extract_text() or ""
        if len(t.strip()) >= min_chars_per_page:
            digital_pages.append((idx, t))
        else:
            needs_ocr.append(idx)

    if not needs_ocr:
        text = "\n".join(t for _, t in digital_pages)
        out = {"text": text, "method": "text", "pages": n, "ocr_pages": 0}
        if page_cap_warning:
            out["warning"] = page_cap_warning
        return out

    if not _ocr_available():
                                                                          
        text = "\n".join(t for _, t in digital_pages)
        return {
            "text": text,
            "method": "text" if digital_pages else "empty",
            "pages": n,
            "ocr_pages": 0,
            "warning": "Some pages have no text layer and OCR is not installed.",
        }

    import pytesseract
    from pdf2image import convert_from_path

    ocr_targets = needs_ocr[:MAX_OCR_PAGES]
    ocr_cap_warning = None
    if len(needs_ocr) > len(ocr_targets):
        ocr_cap_warning = (f"OCR ran on the first {len(ocr_targets)} of "
                           f"{len(needs_ocr)} scanned pages.")

    ocr_text_by_index = {}
    for idx in ocr_targets:
        try:
            # convert one page at a time: rasterizing the whole document at
            # once holds every page bitmap in memory simultaneously
            images = convert_from_path(path, dpi=dpi,
                                       first_page=idx + 1, last_page=idx + 1)
            if not images:
                continue
            gray = images[0].convert("L")
            bw = gray.point(lambda x: 0 if x < 140 else 255, "1")
            page_text = pytesseract.image_to_string(
                bw, lang=lang, config="--psm 3"
            )
        except Exception as e:
            log.error("OCR error on page %d: %s: %s", idx + 1, type(e).__name__, e)
            page_text = ""
        if page_text.strip():
            ocr_text_by_index[idx] = page_text
        log.info("OCR fallback page %d: %d chars (lang=%s, dpi=%d)",
                 idx + 1, len(page_text), lang, dpi)

    parts = []
    for idx in range(min(n, MAX_PAGES)):
        digital = next((t for i, t in digital_pages if i == idx), None)
        if digital is not None:
            parts.append(digital)
        elif idx in ocr_text_by_index:
            parts.append(ocr_text_by_index[idx])

    text = "\n".join(parts)
    method = "ocr" if not digital_pages else "mixed"
    out = {"text": text, "method": method, "pages": n, "ocr_pages": len(ocr_text_by_index)}
    warnings = [w for w in (page_cap_warning, ocr_cap_warning) if w]
    if warnings:
        out["warning"] = " ".join(warnings)
    return out