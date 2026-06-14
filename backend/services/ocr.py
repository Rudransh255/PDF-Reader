import pytesseract
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

from pypdf import PdfReader



def _ocr_available():
    try:
        import pytesseract  # noqa: F401
        from pdf2image import convert_from_path  # noqa: F401
        return True
    except Exception:
        return False


def ocr_pdf_path(path, dpi=200, lang="eng"):
    """Run OCR over every page of a PDF given its file path. Returns text."""
    import pytesseract
    from pdf2image import convert_from_path

    images = convert_from_path(path, dpi=dpi)
    out = []
    for i, image in enumerate(images):
        page_text = pytesseract.image_to_string(image, lang=lang)
        if page_text.strip():
            out.append(page_text)
        print(f"OCR page {i + 1}/{len(images)}: {len(page_text)} chars")
    return "\n".join(out)


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

    digital_pages = []
    needs_ocr = []
    for idx, page in enumerate(reader.pages):
        t = page.extract_text() or ""
        if len(t.strip()) >= min_chars_per_page:
            digital_pages.append((idx, t))
        else:
            needs_ocr.append(idx)

    # If nothing needs OCR, return the fast path
    if not needs_ocr:
        text = "\n".join(t for _, t in digital_pages)
        return {"text": text, "method": "text", "pages": n, "ocr_pages": 0}

    # Some/all pages need OCR
    if not _ocr_available():
        # OCR not installed: return whatever digital text we have, flag it
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

    # Render only the pages that need OCR
    ocr_text_by_index = {}
    images = convert_from_path(path, dpi=dpi)
    for idx in needs_ocr:
        if idx < len(images):
            page_text = pytesseract.image_to_string(images[idx], lang=lang)
            if page_text.strip():
                ocr_text_by_index[idx] = page_text
            print(f"OCR fallback page {idx + 1}: {len(page_text)} chars")

    # Stitch pages back in original order
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