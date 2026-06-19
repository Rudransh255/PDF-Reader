

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

def ocr_pdf_path(path, dpi=300, lang="eng"):
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

def extract_pdf_text(path, min_chars_per_page=20, dpi=300, lang="eng"):
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

    digital_pages = []
    needs_ocr = []
    for idx, page in enumerate(reader.pages):
        t = page.extract_text() or ""
        if len(t.strip()) >= min_chars_per_page:
            digital_pages.append((idx, t))
        else:
            needs_ocr.append(idx)

    if not needs_ocr:
        text = "\n".join(t for _, t in digital_pages)
        return {"text": text, "method": "text", "pages": n, "ocr_pages": 0}

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

    ocr_text_by_index = {}
    images = convert_from_path(path, dpi=dpi)
    for idx in needs_ocr:
        if idx < len(images):
            try:

                                                                         
                gray = images[idx].convert("L")
                bw = gray.point(lambda x: 0 if x < 140 else 255, "1")
                page_text = pytesseract.image_to_string(
                    bw, lang=lang, config="--psm 3"
                )
            except Exception as e:
                log.error("OCR error on page %d: %s: %s", idx + 1, type(e).__name__, e)
                page_text = ""
            if page_text.strip():
                ocr_text_by_index[idx] = page_text
            log.info("OCR fallback page %d: %d chars (lang=%s, dpi=%d, image=%s)",
                     idx + 1, len(page_text), lang, dpi, images[idx].size)

    parts = []
    for idx in range(n):
        digital = next((t for i, t in digital_pages if i == idx), None)
        if digital is not None:
            parts.append(digital)
        elif idx in ocr_text_by_index:
            parts.append(ocr_text_by_index[idx])

    text = "\n".join(parts)
    method = "ocr" if not digital_pages else "mixed"
    return {"text": text, "method": method, "pages": n, "ocr_pages": len(ocr_text_by_index)}