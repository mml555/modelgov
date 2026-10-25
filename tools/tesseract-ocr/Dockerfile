# Tesseract OCR sidecar for Modelgov's `tesseract` document provider.
# Self-hosted, no API key, no network egress.
FROM python:3.12-slim

# tesseract-ocr: the engine. poppler-utils: pdftoppm, for rasterizing PDFs.
# Both pinned by the base image's apt snapshot; no version pin here because
# Debian slim only carries one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       tesseract-ocr \
       tesseract-ocr-eng \
       poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./

EXPOSE 8080

# gunicorn rather than Flask's dev server: OCR requests are CPU-bound and long,
# and the dev server serializes them. Two workers with a generous timeout keeps
# a multi-page PDF from tripping the worker kill.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "2", \
     "--timeout", "600", "app:app"]
