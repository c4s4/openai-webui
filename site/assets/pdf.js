/**
 * PDF reading, in the browser.
 *
 * Most OpenAI-compatible backends only accept text and images on
 * chat/completions: a PDF sent as a `file` content part is rejected with a 400
 * (LM Studio, llama.cpp, Ollama). Rather than depend on a server-side
 * ingestion pipeline, the page reads the document itself, either inlining its
 * text layer or rendering its pages as images, which every model can handle.
 *
 * Two shapes, because neither covers everything: the text layer is cheap and
 * exact but absent from a scanned document, and images carry the layout, the
 * figures and the handwriting but cost far more tokens and need a vision model.
 */

import * as pdfjs from "./vendor/pdf.esm.min.js";
import { t } from "./i18n.js";

// The worker is a module worker; pdf.js spawns it from this URL.
pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.js", import.meta.url).href;

/** Longest edge, in pixels, of a rendered page: enough to read 8pt body text. */
const MAX_EDGE = 1600;

/** JPEG rather than PNG: a rendered page compresses ten times better. */
const IMAGE_TYPE = "image/jpeg";
const IMAGE_QUALITY = 0.85;

/**
 * Reads a PDF the way `mode` asks for.
 *
 * - `text`  : the text layer only, and an error if there is none.
 * - `image` : the pages rendered as images, whatever the text layer holds.
 * - `auto`  : the text layer, falling back to images when it is empty — a
 *             scanned document then still goes through, at the price of tokens.
 *
 * @param {File|Blob} file
 * @param {"auto"|"text"|"image"} mode
 * @returns {Promise<{pageCount: number, text?: string, images?: string[]}>}
 */
export async function readPdf(file, mode = "auto") {
  const data = new Uint8Array(await file.arrayBuffer());
  const loading = pdfjs.getDocument({ data });
  const pdf = await loading.promise;

  try {
    if (mode !== "image") {
      const text = await extractText(pdf);
      if (hasText(text)) return { pageCount: pdf.numPages, text };
      // No text layer at all: a scanned PDF. Better to say so than to send an
      // empty message the model would answer at random.
      if (mode === "text") throw new Error(t("error.noPdfText"));
    }
    return { pageCount: pdf.numPages, images: await renderImages(pdf) };
  } finally {
    // Releases the document and shuts the worker down.
    await loading.destroy();
  }
}

/** True for a file the reader should be given, MIME type or extension. */
export function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/**
 * Text of the document, one `--- page N/total ---` marker per page so the model
 * can cite a page number.
 *
 * The marker stays in English whatever the interface language: it is a structural
 * separator the model parses, not a sentence it reads, and keeping it constant
 * keeps a document's transcript comparable across languages.
 */
async function extractText(pdf) {
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    // Items carry the layout: `hasEOL` marks the end of a visual line.
    const text = content.items.map((item) => (item.hasEOL ? `${item.str}\n` : item.str)).join("");
    pages.push(`--- page ${number}/${pdf.numPages} ---\n${text.trim()}`);
    page.cleanup();
  }
  return pages.join("\n\n");
}

/** Renders every page to a data URL, scaled so its longest edge is MAX_EDGE. */
async function renderImages(pdf) {
  const images = [];
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });

  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const base = page.getViewport({ scale: 1 });
    // Never upscale: a poster-sized page is shrunk, a small one is left alone,
    // since blowing it up would only cost tokens.
    const viewport = page.getViewport({
      scale: Math.min(1, MAX_EDGE / Math.max(base.width, base.height)),
    });

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    // A PDF page is transparent where nothing is drawn, and a transparent
    // pixel flattens to black in JPEG: paint the paper first.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: context, viewport }).promise;
    images.push(canvas.toDataURL(IMAGE_TYPE, IMAGE_QUALITY));
    page.cleanup();
  }

  canvas.width = 0;
  canvas.height = 0;
  return images;
}

/** True if the extraction found anything besides the page markers. */
function hasText(text) {
  return text.replace(/--- page \d+\/\d+ ---/g, "").trim() !== "";
}
