"""
Tesseract OCR sidecar for Modelgov's `tesseract` document provider.

Contract (packages/api/src/services/documents/tesseract.ts):
    POST /extract  {"base64": "<document bytes>"}  ->  {"text": str, "pages": int}
    GET  /health                                   ->  {"status": "ok"}

Status codes matter to the caller: the adapter treats 4xx as DocumentClientError
(the document is bad — do not retry) and 5xx as DocumentProviderError (transient
— the gateway may retry or fall back). So a corrupt upload must be a 4xx, and
only an actual OCR crash may be a 5xx.

No model, no network egress, no hallucination surface: Tesseract either reads
the glyphs or it does not.
"""

import base64
import binascii
import io
import os
import subprocess
import tempfile

from flask import Flask, jsonify, request
from PIL import Image
import pytesseract

app = Flask(__name__)

# Bound the work a single request can cause. A 200-page fax at 300dpi would
# otherwise pin a CPU for minutes inside the gateway's request timeout.
MAX_BYTES = int(os.environ.get("TESSERACT_MAX_BYTES", 32 * 1024 * 1024))
MAX_PAGES = int(os.environ.get("TESSERACT_MAX_PAGES", 50))
# Rasterization DPI for PDFs. 300 is the usual accuracy/-speed sweet spot for
# Tesseract; below ~200 small print degrades badly.
PDF_DPI = int(os.environ.get("TESSERACT_PDF_DPI", 300))
LANG = os.environ.get("TESSERACT_LANG", "eng")


class BadDocument(Exception):
    """Caller's fault — becomes a 4xx so the adapter will not retry."""


def _ocr_image(img: Image.Image) -> str:
    # Grayscale first: Tesseract's own binarization does better on L than on a
    # colour image, and it cuts memory on large scans.
    if img.mode not in ("L", "1"):
        img = img.convert("L")
    return pytesseract.image_to_string(img, lang=LANG).strip()


def _is_pdf(data: bytes) -> bool:
    return data[:5] == b"%PDF-"


def _ocr_pdf(data: bytes) -> tuple[str, int]:
    """Rasterize with poppler, then OCR each page. Returns (text, page_count)."""
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.pdf")
        with open(src, "wb") as fh:
            fh.write(data)

        # pdftoppm is the reliable rasterizer here; -r sets DPI, -l caps pages.
        proc = subprocess.run(
            ["pdftoppm", "-png", "-r", str(PDF_DPI), "-l", str(MAX_PAGES), src,
             os.path.join(tmp, "page")],
            capture_output=True,
            timeout=600,
        )
        # pdftoppm exits non-zero on an unreadable/encrypted PDF. That is the
        # document's problem, not the service's.
        pages = sorted(f for f in os.listdir(tmp) if f.startswith("page") and f.endswith(".png"))
        if proc.returncode != 0 and not pages:
            detail = proc.stderr.decode("utf-8", "replace")[:300]
            raise BadDocument(f"could not rasterize PDF: {detail}")
        if not pages:
            raise BadDocument("PDF produced no rasterized pages")

        texts = []
        for name in pages:
            with Image.open(os.path.join(tmp, name)) as img:
                texts.append(_ocr_image(img))

        # Blank line between pages so a caller splitting on form feed or blank
        # lines can still tell pages apart in the flat text.
        return "\n\n".join(texts).strip(), len(pages)


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.post("/extract")
def extract():
    payload = request.get_json(silent=True) or {}
    b64 = payload.get("base64")
    if not isinstance(b64, str) or not b64:
        return jsonify(error="body must be {\"base64\": \"<document>\"}"), 400

    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        return jsonify(error="base64 payload is not valid base64"), 400

    if not data:
        return jsonify(error="document is empty"), 400
    if len(data) > MAX_BYTES:
        return jsonify(error=f"document exceeds {MAX_BYTES} bytes"), 413

    try:
        if _is_pdf(data):
            text, pages = _ocr_pdf(data)
        else:
            with Image.open(io.BytesIO(data)) as img:
                text, pages = _ocr_image(img), 1
    except BadDocument as exc:
        return jsonify(error=str(exc)), 422
    except (Image.UnidentifiedImageError, OSError) as exc:
        # Unreadable bytes: the document is bad, so 4xx (no retry).
        return jsonify(error=f"unreadable document: {exc}"), 422
    except subprocess.TimeoutExpired:
        return jsonify(error="rasterization timed out"), 504
    except pytesseract.TesseractError as exc:
        # OCR itself failed — that IS our problem, so 5xx (retryable).
        return jsonify(error=f"tesseract failed: {exc}"), 500

    return jsonify(text=text, pages=pages)


if __name__ == "__main__":
    # Threaded so one slow multi-page PDF does not block health checks.
    app.run(host="0.0.0.0", port=8080, threaded=True)
