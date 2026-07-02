import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"]);
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export interface RenderedPages {
  /** Absolute page-image paths, in order. */
  pages: string[];
  /** Remove any temp files created for this render (no-op for image inputs).
   * The caller MUST call this once the pages have been consumed. */
  cleanup: () => Promise<void>;
}

/**
 * Render an input document to one image per page. PDFs are rasterized with
 * `pdftoppm` (poppler) into a temp dir; image files are used as-is. Returns the
 * page paths plus a `cleanup()` that deletes the temp dir (so rasterized PDF
 * pages don't accumulate in the OS temp dir across runs).
 */
export async function renderPages(inputPath: string): Promise<RenderedPages> {
  const ext = path.extname(inputPath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    return { pages: [path.resolve(inputPath)], cleanup: async () => {} };
  }
  if (ext !== ".pdf") {
    throw new Error(`unsupported input '${ext}'. Use a PDF or an image (${[...IMAGE_EXTS].join(", ")}).`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "ocr-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  const prefix = path.join(dir, "page");
  try {
    // -r 150 dpi is enough for OCR + vision while keeping the base64 small.
    await exec("pdftoppm", ["-png", "-r", "150", path.resolve(inputPath), prefix]);
    const files = (await readdir(dir))
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort();
    if (files.length === 0) throw new Error("pdftoppm produced no pages");
    return { pages: files.map((f) => path.join(dir, f)), cleanup };
  } catch (err) {
    // Don't leak the temp dir if rasterization/scan fails.
    await cleanup();
    throw new Error(
      `pdftoppm failed (is poppler installed? \`brew install poppler\`): ${(err as Error).message}`,
    );
  }
}

/** Run Tesseract OCR on an image and return the extracted text. */
export async function ocrText(imagePath: string): Promise<string> {
  try {
    const { stdout } = await exec("tesseract", [imagePath, "stdout"], { maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    throw new Error(
      `tesseract failed (is it installed? \`brew install tesseract\`): ${(err as Error).message}`,
    );
  }
}

/** Read an image and return a base64 `data:` URI for the vision model. */
export async function imageDataUrl(imagePath: string): Promise<string> {
  const ext = path.extname(imagePath).toLowerCase();
  const mime = MIME[ext] ?? "image/png";
  const b64 = (await readFile(imagePath)).toString("base64");
  return `data:${mime};base64,${b64}`;
}
