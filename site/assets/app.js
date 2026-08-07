/**
 * OpenAI WebUI — front-end logic.
 *
 * All calls go to /api/, which NGinX proxies to the OpenAI-compatible API
 * while injecting the Authorization header. The API key never reaches the
 * browser.
 */

import { renderMarkdown } from "./markdown.js";
import { readPdf, isPdf } from "./pdf.js";
import { LANGUAGES, applyTranslations, formatNumber, getLanguage, setLanguage, t } from "./i18n.js";

const API_BASE = "/api";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Shown in the "file too large" message, so the number and the limit cannot drift apart. */
const MAX_FILE_MB = MAX_FILE_BYTES / 1024 / 1024;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|ya?ml|log|ini|conf|toml|xml|html?|css|js|ts|jsx|tsx|py|go|rs|java|kt|rb|php|sh|sql)$/i;

/**
 * The two image formats every backend decodes. Anything else — WebP, AVIF,
 * HEIC, BMP, TIFF — is re-encoded by the browser before being sent: LM Studio,
 * llama.cpp and Ollama answer a `data:image/webp` part with a 400 even when the
 * vision model behind them would have handled the pixels perfectly well. Same
 * reasoning as the PDF: the page does the work the backend refuses to do.
 */
const SAFE_IMAGE_TYPES = /^image\/(png|jpe?g)$/i;

/** Matches the PDF page images, for the same reason: base64 is paid in full. */
const IMAGE_QUALITY = 0.85;

/**
 * Ceiling on the area of a re-encoded image, in pixels.
 *
 * WebKit on iOS caps a canvas at 16,777,216 px (4096 × 4096) and, past it, hands
 * back a blank canvas instead of raising — which encodes into a perfectly valid
 * and perfectly useless JPEG that no guard on the data URL can tell apart from a
 * real one. A 48 Mpx HEIC out of a recent iPhone reaches that. Staying under it
 * also keeps the alpha scan cheap.
 */
const MAX_IMAGE_PIXELS = 16_000_000;

const thread = document.getElementById("thread");
const emptyState = document.getElementById("empty-state");
const modelSelect = document.getElementById("model-select");
const pdfModeSelect = document.getElementById("pdf-mode");
const thinkModeSelect = document.getElementById("think-mode");
const composer = document.getElementById("composer");
const promptInput = document.getElementById("prompt");
const sendButton = document.getElementById("send-button");
const attachButton = document.getElementById("attach-button");
const fileInput = document.getElementById("file-input");
const attachmentList = document.getElementById("attachments");
const statusLine = document.getElementById("status");
const newChatButton = document.getElementById("new-chat");
const langSelect = document.getElementById("lang-select");
const optionsButton = document.getElementById("options-button");
const optionsMenu = document.getElementById("options-menu");

/** @type {Array<{role: string, content: unknown}>} */
let history = [];
/** @type {Array<{name: string, type: string, kind: string, dataUrl?: string, dataUrls?: string[], text?: string, pageCount?: number, note?: string}>} */
let attachments = [];
let busy = false;
/** Cleared if the backend rejects `stream_options` (non-OpenAI providers). */
let usageSupported = true;
/** Cleared if the backend rejects the parameters turning reasoning off. */
let noThinkingSupported = true;
/** Set when that refusal happened on the running request, to say so once it ends. */
let thinkingRefused = false;
/** Aborts the running generation; null when idle. */
let inFlight = null;

/* --------------------------------------------------------- options menu */

/**
 * The panel holding the four settings — model, thinking, PDF, language. It stays
 * open while they are being changed, since one visit to the menu often adjusts
 * more than one of them, and closes on a click outside, on `Escape` or on the
 * button itself.
 */
function setUpOptionsMenu() {
  const setOpen = (open) => {
    optionsMenu.hidden = !open;
    // Read by a screen reader off the button, hence kept in step by hand: the
    // `hidden` attribute of the panel says nothing about the button.
    optionsButton.setAttribute("aria-expanded", String(open));
  };

  optionsButton.addEventListener("click", () => setOpen(optionsMenu.hidden));

  // The button is left out on purpose: `pointerdown` fires before `click`, so
  // closing here would let the button's own handler reopen the panel right after.
  document.addEventListener("pointerdown", (event) => {
    if (optionsMenu.hidden) return;
    if (optionsMenu.contains(event.target) || optionsButton.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || optionsMenu.hidden) return;
    setOpen(false);
    // Closing must not drop the focus into the void: it goes back to what opened
    // the panel, so tabbing carries on from there.
    optionsButton.focus();
  });
}

/* -------------------------------------------------------------- language */

/**
 * Fills the language picker and keeps the interface in step with it. Switching
 * language redraws the labels, the tooltips and the attachment chips, but leaves
 * the messages already on screen alone: a conversation held in one language
 * stays readable as it was written, and only the interface follows.
 */
function setUpLanguagePicker() {
  for (const { code, flag, name } of LANGUAGES) {
    const option = document.createElement("option");
    option.value = code;
    // An option holds text and nothing else, so the flag is an emoji rather than
    // an image: no markup is allowed in there. The name follows it, and is what
    // actually identifies the language: the flag alone says nothing to a screen
    // reader, and nothing at all on Windows, where no font ships flag glyphs and
    // the browser falls back to the bare letter pair. It stays in `title` and
    // `aria-label` too, for the closed select, which shows the selected option
    // ellipsised if the panel is narrow.
    option.textContent = `${flag} ${name}`;
    option.title = name;
    option.setAttribute("aria-label", name);
    langSelect.append(option);
  }
  langSelect.value = getLanguage();

  langSelect.addEventListener("change", () => {
    setLanguage(langSelect.value);
    // Not driven by an attribute: the chips are rebuilt from the attachment list.
    renderAttachments();
  });

  // The stored or browser-guessed language, applied to the English markup.
  setLanguage(getLanguage());
}

/* ---------------------------------------------------------------- models */

async function loadModels() {
  try {
    const response = await fetch(`${API_BASE}/models`);
    if (!response.ok) throw new Error(await describeError(response));

    const models = (await response.json()).data ?? [];
    models.sort((a, b) => a.id.localeCompare(b.id));
    if (models.length === 0) throw new Error(t("model.none"));

    modelSelect.innerHTML = "";
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.id;
      modelSelect.append(option);
    }

    const preferred = localStorage.getItem("openai-webui.model");
    if (preferred && models.some((m) => m.id === preferred)) {
      modelSelect.value = preferred;
    } else {
      const chat = models.find((m) => /^(gpt|o\d)/.test(m.id));
      modelSelect.value = (chat ?? models[0]).id;
    }
    showFullModelName();
  } catch (error) {
    modelSelect.innerHTML = "";
    const option = document.createElement("option");
    // Attribute rather than plain text: this option outlives a language change.
    option.dataset.i18n = "model.unavailable";
    option.textContent = t("model.unavailable");
    modelSelect.append(option);
    setStatus(t("status.modelsFailed", { error: error.message }), true);
  }
}

/**
 * Puts the selected identifier in the tooltip of the select. The box has a fixed
 * width, like the three next to it, so a long identifier is shown ellipsised: the
 * tooltip is where the whole of it stays readable.
 */
function showFullModelName() {
  modelSelect.title = modelSelect.value;
}

modelSelect.addEventListener("change", () => {
  localStorage.setItem("openai-webui.model", modelSelect.value);
  showFullModelName();
});

/* --------------------------------------------------------------- pdf mode */

/**
 * How a joined PDF is turned into something the model accepts. Read at
 * attachment time rather than at send time: the file is converted the moment it
 * is joined, so changing the menu afterwards only affects the next attachment.
 *
 * Unlike the model, the choice is deliberately not remembered: forcing text or
 * images answers one document, so it goes back to Auto on a reload and on a new
 * conversation rather than silently applying to the next PDF.
 */
const DEFAULT_PDF_MODE = "auto";
pdfModeSelect.value = DEFAULT_PDF_MODE;

/* ----------------------------------------------------------- think mode */

/**
 * Parameters added to the request when the thinking menu is on "Off". There is
 * no standard for it, so the three spellings in use are sent together and each
 * backend picks the one it knows, ignoring the others:
 *
 * - `reasoning_effort: "none"` — OpenAI and the providers that copy it;
 * - `reasoning: { enabled: false, exclude: true }` — OpenRouter;
 * - `chat_template_kwargs: { enable_thinking: false }` — vLLM, LM Studio and
 *   llama.cpp, which pass it to the model's chat template (Qwen3 and the like).
 *
 * A backend strict about unknown fields answers a 400 instead: `postCompletion`
 * then retries without them and says so, rather than leaving the menu looking
 * like it worked.
 */
const NO_THINKING = {
  reasoning_effort: "none",
  reasoning: { enabled: false, exclude: true },
  chat_template_kwargs: { enable_thinking: false },
};

/**
 * Like the PDF menu and unlike the model, the choice is deliberately not
 * remembered: cutting the reasoning out answers one question in a hurry, so the
 * menu goes back to Auto on a reload and on a new conversation rather than
 * silently applying to everything that follows.
 */
const DEFAULT_THINK_MODE = "auto";
thinkModeSelect.value = DEFAULT_THINK_MODE;

thinkModeSelect.addEventListener("change", () => {
  // A backend may well accept the parameters for one model and refuse them for
  // another: touching the menu gives them a fresh chance.
  noThinkingSupported = true;
});

/* ----------------------------------------------------------- attachments */

attachButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  for (const file of fileInput.files) {
    if (file.size > MAX_FILE_BYTES) {
      const limit = t("unit.megabytes", { count: MAX_FILE_MB });
      setStatus(t("status.tooLarge", { name: file.name, limit }), true);
      continue;
    }
    try {
      // Extracting a large PDF takes a moment: say what is going on.
      setStatus(t("status.reading", { name: file.name }));
      attachments.push(await readFile(file));
      setStatus("");
    } catch (error) {
      setStatus(t("status.readFailed", { name: file.name, error: error.message }), true);
    }
  }
  fileInput.value = "";
  renderAttachments();
});

/**
 * No allow-list here: any file is accepted and forwarded, it is up to the model
 * to say what it can do with it. Only the transport shape is decided locally —
 * images as `image_url`, text inlined in the message, PDF read on the spot as
 * text or as page images depending on the PDF menu, anything else base64 in a
 * `file` part.
 *
 * A `note` is stored as a key and its parameters rather than as a finished
 * sentence, so the chips follow a language change made after the file was read.
 */
async function readFile(file) {
  if (file.type.startsWith("image/")) return readImage(file);
  if (isPdf(file)) {
    const { pageCount, text, images } = await readPdf(file, pdfModeSelect.value);
    if (images) {
      return {
        name: file.name,
        type: "application/pdf",
        kind: "images",
        pageCount,
        dataUrls: images,
        note: { key: "note.pdfImages", params: { count: pageCount } },
      };
    }
    return {
      name: file.name,
      type: "application/pdf",
      kind: "text",
      pageCount,
      text,
      note: { key: "note.pdfText", params: { count: pageCount } },
    };
  }
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.test(file.name)) {
    return { name: file.name, type: file.type || "text/plain", kind: "text", text: await file.text() };
  }
  return { name: file.name, type: file.type, kind: "file", dataUrl: await toDataUrl(file) };
}

/**
 * PNG and JPEG go through untouched; the rest is decoded by the browser and
 * re-encoded. If the browser cannot decode it either — HEIC outside Safari, an
 * exotic TIFF — the original is sent as it is and the backend has the last word,
 * which is no worse than before and leaves the door open to a backend that copes.
 */
async function readImage(file) {
  if (SAFE_IMAGE_TYPES.test(file.type)) {
    return { name: file.name, type: file.type, kind: "image", dataUrl: await toDataUrl(file) };
  }
  try {
    setStatus(t("status.converting", { name: file.name }));
    const { type, dataUrl } = await reencodeImage(file);
    setStatus("");
    return {
      name: file.name,
      type,
      kind: "image",
      dataUrl,
      note: {
        key: "note.converted",
        params: { format: type === "image/png" ? "PNG" : "JPEG" },
      },
    };
  } catch {
    setStatus("");
    return { name: file.name, type: file.type, kind: "image", dataUrl: await toDataUrl(file) };
  }
}

/**
 * Decodes an image through `createImageBitmap` — which follows what the browser
 * itself supports, so WebP and AVIF are covered everywhere and HEIC on Safari —
 * and re-encodes it at its original dimensions. No downscaling below the canvas
 * ceiling: unlike a rendered PDF page, an attached image is the document, and a
 * screenshot of code becomes unreadable a few hundred pixels lower. Above it, the
 * choice is between a smaller picture and a blank one.
 */
async function reencodeImage(file) {
  const bitmap = await createImageBitmap(file);
  // Only a picture over the ceiling is touched, and only by what it takes to fit
  // under it; anything smaller keeps its pixels one for one.
  const scale = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / (bitmap.width * bitmap.height)));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
  canvas.height = Math.max(1, Math.floor(bitmap.height * scale));

  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  // PNG only when transparency would be lost, because a photo re-encoded
  // losslessly weighs ten times more and the request body pays that in base64.
  const type = hasAlpha(context, canvas) ? "image/png" : "image/jpeg";
  const dataUrl = canvas.toDataURL(type, IMAGE_QUALITY);
  canvas.width = 0;
  canvas.height = 0;

  // toDataURL falls back to PNG when it cannot honour the type, and to
  // `data:,` when the canvas is too large for the browser.
  if (!dataUrl.startsWith(`data:${type};base64,`)) throw new Error(t("error.encode"));
  return { type, dataUrl };
}

/**
 * True as soon as one pixel is not fully opaque.
 *
 * Read in horizontal bands rather than in one call: the pixels of a 16 Mpx image
 * weigh 64 MB as a single `ImageData`, which is a lot to allocate on a phone for
 * a question usually settled in the first rows. A photo, being opaque, is the
 * case that does run to the end — and it is the one that pays the least for a
 * buffer a few megabytes wide.
 */
function hasAlpha(context, canvas) {
  const BAND_HEIGHT = 256;

  for (let top = 0; top < canvas.height; top += BAND_HEIGHT) {
    const height = Math.min(BAND_HEIGHT, canvas.height - top);
    const { data } = context.getImageData(0, top, canvas.width, height);
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 255) return true;
    }
  }
  return false;
}

function toDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(t("error.read")));
    reader.readAsDataURL(file);
  });
}

/** The note of an attachment, in the language in force right now; "" if it has none. */
function noteText(attachment) {
  return attachment.note ? t(attachment.note.key, attachment.note.params) : "";
}

function renderAttachments() {
  attachmentList.innerHTML = "";
  attachmentList.hidden = attachments.length === 0;

  attachments.forEach((attachment, index) => {
    const item = document.createElement("li");
    const note = noteText(attachment);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = attachment.name;
    // Which shape the PDF took, since in Auto the page decides: reading the
    // chip is the only way to know whether the text layer was found.
    if (note) name.title = `${attachment.name} — ${note}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.i18nTitle = "attachment.remove";
    remove.title = t("attachment.remove");
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      attachments.splice(index, 1);
      renderAttachments();
    });

    item.append(name);
    if (note) {
      const tag = document.createElement("span");
      tag.className = "note";
      tag.textContent = note;
      item.append(tag);
    }
    item.append(remove);
    attachmentList.append(item);
  });
}

/* -------------------------------------------------------------- composer */

promptInput.addEventListener("input", autoGrow);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

function autoGrow() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${promptInput.scrollHeight}px`;
}

newChatButton.addEventListener("click", () => {
  if (busy) return;
  history = [];
  attachments = [];
  pdfModeSelect.value = DEFAULT_PDF_MODE;
  thinkModeSelect.value = DEFAULT_THINK_MODE;
  renderAttachments();
  thread.innerHTML = "";
  thread.append(emptyState);
  emptyState.hidden = false;
  setStatus("");
});

// While generating, the same button stops the stream instead of submitting.
sendButton.addEventListener("click", (event) => {
  if (!busy) return;
  event.preventDefault();
  inFlight?.abort();
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;

  const text = promptInput.value.trim();
  if (!text && attachments.length === 0) return;
  if (!modelSelect.value) {
    setStatus(t("status.pickModel"), true);
    return;
  }

  const sent = attachments;
  attachments = [];
  renderAttachments();
  promptInput.value = "";
  autoGrow();

  const bubble = appendMessage("user", text, sent);
  history.push({ role: "user", content: buildUserContent(text, sent) });

  // Kept for the turn that never gets an answer: `streamCompletion` hands it
  // back to the composer rather than leaving it on screen unanswered.
  await streamCompletion({ node: bubble.closest(".message"), text, files: sent });
});

function buildUserContent(text, files) {
  const parts = [];
  if (text) parts.push({ type: "text", text });

  for (const file of files) {
    if (file.kind === "image") {
      parts.push({ type: "image_url", image_url: { url: file.dataUrl } });
    } else if (file.kind === "images") {
      // Pages sent one image after the other, announced first: without the
      // caption the model has no idea what the burst of images is, nor in which
      // order to read them.
      parts.push({
        type: "text",
        text: t("attached.images", { name: file.name, count: file.pageCount }),
      });
      for (const url of file.dataUrls) {
        parts.push({ type: "image_url", image_url: { url } });
      }
    } else if (file.kind === "file") {
      parts.push({ type: "file", file: { filename: file.name, file_data: file.dataUrl } });
    } else {
      const note = noteText(file);
      const caption = t("attached.text", { name: file.name, origin: note ? ` (${note})` : "" });
      parts.push({ type: "text", text: `${caption}\n\n${file.text}` });
    }
  }
  return parts;
}

/* --------------------------------------------------------------- request */

/**
 * Sends the completion request. Two of the parameters are optional extras a
 * backend may refuse with a 400: `stream_options`, which asks for a final chunk
 * with the token counts, and the fields turning reasoning off. On a 400 they are
 * dropped one at a time to find the culprit — the token counts first, since
 * losing them only costs an estimate from the chunk count, while losing the
 * thinking switch changes the answer and is worth a message.
 *
 * Each refusal is remembered for the rest of the session, so the search happens
 * once per backend and not on every message.
 */
async function postCompletion() {
  const send = (extra) =>
    fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelSelect.value, messages: history, stream: true, ...extra }),
      signal: inFlight.signal,
    });

  const usage = usageSupported ? { stream_options: { include_usage: true } } : {};
  const noThinking = thinkModeSelect.value === "off" && noThinkingSupported ? NO_THINKING : {};

  const response = await send({ ...usage, ...noThinking });
  if (response.status !== 400) return response;

  // Only remember a fallback if dropping the extra really is what fixed the
  // request, not an unrelated 400 (bad model, oversized input…).
  if (usageSupported) {
    const retry = await send({ ...noThinking });
    if (retry.ok) {
      usageSupported = false;
      return retry;
    }
  }

  if (Object.keys(noThinking).length > 0) {
    const retry = await send({ ...usage });
    if (retry.ok) {
      noThinkingSupported = false;
      thinkingRefused = true;
      return retry;
    }
    // Neither alone was enough: try without both before giving up.
    if (usageSupported) {
      const bare = await send({});
      if (bare.ok) {
        usageSupported = false;
        noThinkingSupported = false;
        thinkingRefused = true;
        return bare;
      }
    }
  }

  return response;
}

async function streamCompletion(turn) {
  setBusy(true);
  setStatus(t("status.generating"));
  thinkingRefused = false;

  const bubble = appendMessage("assistant", "");

  const answerNode = document.createElement("div");
  answerNode.className = "answer";
  const head = createAnswerHead(modelSelect.value);
  const reasoning = createReasoningBlock();
  bubble.append(head.node, reasoning.details, answerNode);

  let raw = "";       // content stream, <think> tags included
  let answer = "";    // content minus the reasoning
  let thoughts = "";  // reasoning from the dedicated field
  let thinking = "";  // reasoning to display, both sources merged
  let repaintQueued = false;
  let repaintHandle = 0;
  let streaming = true; // false once the stream is over: no cursor after that

  const repaint = () => {
    answerNode.innerHTML = renderMarkdown(answer);
    // Only the answer gets per-block copy buttons: reasoning is throwaway.
    addCodeCopyButtons(answerNode);
    // The cursor belongs to whichever part is currently being written.
    answerNode.classList.toggle("cursor", streaming && answer !== "");
    reasoning.update(thinking, answer !== "");
    thread.scrollTop = thread.scrollHeight;
  };

  const requestedAt = performance.now();
  let firstTokenAt = null;
  let lastTokenAt = null;
  let deltaCount = 0;
  let usage = null;

  // Keeps whatever was produced: on a normal end, and on a stop too.
  const keepWhatWeHave = (interrupted) => {
    repaint();
    reasoning.finish();
    // Reasoning alone, on a stop before the first word of the answer: nothing
    // worth remembering, and an empty assistant message is what some backends
    // reject on the next turn.
    if (answer) history.push({ role: "assistant", content: answer });
    appendMetrics(appendFooter(bubble, answer), { requestedAt, firstTokenAt, lastTokenAt, deltaCount, usage, interrupted });
    // The refusal of the no-thinking parameters outlives the generation: it is
    // the only trace left that the menu did not apply to this answer.
    if (thinkingRefused) setStatus(t("status.thinkingUnsupported"), true);
    else setStatus(interrupted ? t("status.stopped") : "");
    // The footer and the metrics grow the bubble after the last repaint scroll:
    // without this, they stay hidden under the composer.
    thread.scrollTop = thread.scrollHeight;
  };

  inFlight = new AbortController();

  try {
    const response = await postCompletion();
    if (!response.ok || !response.body) throw new Error(await describeError(response));

    for await (const data of readSse(response.body)) {
      if (data === "[DONE]") break;
      const chunk = JSON.parse(data);
      if (chunk.usage) usage = chunk.usage;

      const delta = chunk.choices?.[0]?.delta;
      // Dedicated reasoning field: reasoning_content (LM Studio, vLLM,
      // DeepSeek) or reasoning (OpenRouter and others).
      const thought = delta?.reasoning_content ?? delta?.reasoning;
      const content = delta?.content;
      if (!thought && !content) continue;

      lastTokenAt = performance.now();
      if (firstTokenAt === null) firstTokenAt = lastTokenAt;
      deltaCount += 1;

      if (thought) thoughts += thought;
      if (content) raw += content;

      // Models without a reasoning field inline it as <think>…</think>.
      const split = splitThinking(raw);
      answer = split.answer;
      thinking = thoughts + split.thinking;

      // Re-rendering the whole Markdown on every chunk would be quadratic;
      // one repaint per animation frame is both cheaper and smoother.
      if (!repaintQueued) {
        repaintQueued = true;
        repaintHandle = requestAnimationFrame(() => {
          repaintQueued = false;
          repaint();
        });
      }
    }

    repaint(); // guarantees the final state, whatever the last frame did

    if (!answer && !thoughts) throw new Error(t("error.empty"));
    keepWhatWeHave(false);
  } catch (error) {
    // A stop is not a failure: the partial answer is worth keeping.
    if (error.name === "AbortError" && (answer || thinking)) {
      keepWhatWeHave(true);
    } else if (error.name === "AbortError") {
      bubble.closest(".message").remove();
      giveTurnBack(turn);
      setStatus(t("status.stoppedEarly"));
    } else {
      bubble.closest(".message").remove();
      giveTurnBack(turn);
      appendMessage("error", t("error.prefix", { message: error.message }));
      setStatus(error.message, true);
    }
  } finally {
    // Order matters: a frame queued during the stream would otherwise fire
    // after this block and put the cursor back.
    streaming = false;
    cancelAnimationFrame(repaintHandle);
    inFlight = null;
    head.stopSpinner();
    answerNode.classList.remove("cursor");
    setBusy(false);
  }
}

/**
 * Hands a turn that got no answer back to the composer: its text and its files
 * come back where they were typed, and the message leaves the thread and the
 * history together. Retrying is then one keystroke away, instead of retyping in
 * front of a message the model will never see again.
 *
 * The text is only put back into an empty field: something typed while the
 * answer was streaming belongs to the reader, not to us. The turn then stays in
 * the thread and in the history, which is coherent too — just not retryable.
 */
function giveTurnBack(turn) {
  if (promptInput.value.trim() !== "") return;

  history.pop();
  turn.node.remove();
  promptInput.value = turn.text;
  autoGrow();
  // Ahead of anything joined in the meantime: they were sent first.
  attachments = [...turn.files, ...attachments];
  renderAttachments();

  // Nothing left in the thread: back to the welcome screen rather than to a
  // blank page. A message appended after this call hides it again.
  if (!thread.querySelector(".message")) emptyState.hidden = false;
}

/* ------------------------------------------------------------- reasoning */

/**
 * Header line of an assistant answer, identical whether the model reasons or
 * not: the model name, followed by a spinner that turns from the request to the
 * end of the generation.
 */
function createAnswerHead(modelName) {
  const node = document.createElement("div");
  node.className = "answer-head";

  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.dataset.i18nAria = "status.generating";
  spinner.setAttribute("aria-label", t("status.generating"));

  const model = document.createElement("span");
  model.className = "model-name";
  model.textContent = modelName;

  node.append(model, spinner);

  return {
    node,
    stopSpinner() {
      spinner.remove();
    },
  };
}

// Two four-pointed sparks: the brain it replaces collapsed into a blur at the
// 18px this line is drawn at, where these stay legible.
const SPARKLES_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M11 4.4l1.5 3.9 3.9 1.5-3.9 1.5-1.5 3.9-1.5-3.9L5.6 9.8l3.9-1.5Z"/>' +
  '<path d="M17.6 15.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z"/></svg>';

// A drawn chevron rather than the "▸" glyph: it scales to any size and sits on
// the exact centre of the line, which the glyph's own metrics never do.
const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';

/**
 * Collapsible reasoning panel, sitting under the header line and shown only
 * when the model actually reasons. Its first line holds nothing but the fold
 * handle and a sparkles icon: the panel stays open while thinking, folds by itself
 * once the answer starts, and the handle keeps the reasoning one click away.
 */
function createReasoningBlock() {
  const details = document.createElement("details");
  details.className = "reasoning";
  details.hidden = true;
  details.open = true;

  const summary = document.createElement("summary");

  // Only the handle toggles the panel: the rest of the line is inert (see the
  // pointer-events rules in the stylesheet).
  const handle = document.createElement("span");
  handle.className = "reasoning-handle";
  handle.setAttribute("role", "button");
  handle.dataset.i18nAria = "reasoning.toggle";
  handle.setAttribute("aria-label", t("reasoning.toggle"));
  handle.innerHTML = CHEVRON_ICON;

  const sparkles = document.createElement("span");
  sparkles.className = "reasoning-sparkles";
  sparkles.innerHTML = SPARKLES_ICON;

  summary.append(handle, sparkles);

  const body = document.createElement("div");
  body.className = "reasoning-body";

  details.append(summary, body);
  let foldedOnce = false;

  return {
    details,

    update(text, answerStarted) {
      if (!text) return;
      details.hidden = false;

      // Follow the latest words, unless the reader scrolled up to re-read
      // something: then leave their position alone.
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;

      body.innerHTML = renderMarkdown(text);
      if (atBottom) body.scrollTop = body.scrollHeight;
      // Fold once, when the answer begins; a manual re-open is never undone.
      if (answerStarted && !foldedOnce) {
        foldedOnce = true;
        details.open = false;
      }
    },

    finish() {
      details.open = false;
    },
  };
}

/**
 * Separates inline reasoning from the answer. Models that lack a dedicated
 * reasoning field wrap it in <think>…</think>. Called on the whole accumulated
 * text, so a tag split across two SSE chunks is never mis-parsed.
 */
function splitThinking(raw) {
  let thinking = "";
  let answer = "";
  let rest = raw;

  while (rest !== "") {
    const open = rest.match(/<(think|thinking)>/i);
    if (!open) {
      answer += rest;
      break;
    }
    answer += rest.slice(0, open.index);

    const after = rest.slice(open.index + open[0].length);
    const close = after.match(new RegExp(`</${open[1]}>`, "i"));
    if (!close) {
      thinking += after; // block still open: everything left is reasoning
      break;
    }
    thinking += after.slice(0, close.index);
    rest = after.slice(close.index + close[0].length);
  }

  // Answers usually start with the newlines that followed </think>: trimming
  // them keeps "the answer has started" from being triggered by whitespace.
  return { thinking, answer: answer.trimStart() };
}

/** Yields the payload of each `data:` line of an SSE stream. */
async function* readSse(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  }
}

async function describeError(response) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.error?.message ?? "";
  } catch {
    /* non-JSON body (e.g. an NGinX error page) */
  }
  return detail || `HTTP ${response.status} ${response.statusText}`;
}

/* ------------------------------------------------------------ rendering */

function appendMessage(role, text, files = []) {
  emptyState.hidden = true;

  const message = document.createElement("div");
  message.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  if (files.length > 0) {
    const list = document.createElement("ul");
    list.className = "files";
    for (const file of files) {
      const item = document.createElement("li");
      const note = noteText(file);
      item.textContent = note ? `📎 ${file.name} (${note})` : `📎 ${file.name}`;
      list.append(item);
    }
    bubble.append(list);
  }

  message.append(bubble);
  // Prompts get their own copy button, on their right: they are plain text, so
  // there is nothing to strip before copying.
  if (role === "user" && text !== "") {
    message.append(createCopyButton(text, { titleKey: "copy.prompt", className: "prompt-copy" }));
  }
  thread.append(message);
  thread.scrollTop = thread.scrollHeight;
  return bubble;
}

const COPY_ICON =
  '<svg class="icon-copy" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8A1.5 1.5 0 0 1 13.5 20h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Shown in place of the copy icon while the "copied" state lasts.
const CHECK_ICON =
  '<svg class="icon-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Copy-to-clipboard button. With a label it names itself and reports the result
 * in words; without one it stays icon-only and says it all in the tooltip.
 *
 * Both texts are named by their key and mirrored into `data-i18n` attributes, so
 * a language change reaches the buttons of messages already on screen. The only
 * seam: switching language during the 1.8 s "copied" state ends it early, which
 * is exactly what the timer was about to do anyway.
 */
function createCopyButton(text, { titleKey, labelKey = "", className = "" }) {
  const title = t(titleKey);
  const button = document.createElement("button");
  button.type = "button";
  button.className = className ? `copy-button ${className}` : "copy-button";
  button.dataset.i18nTitle = titleKey;
  button.dataset.i18nAria = titleKey;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = COPY_ICON + CHECK_ICON;

  let tag = null;
  if (labelKey) {
    tag = document.createElement("span");
    tag.dataset.i18n = labelKey;
    tag.textContent = t(labelKey);
    button.append(tag);
  }

  let revert;
  button.addEventListener("click", async () => {
    const copied = await copyToClipboard(text);
    const outcome = t(copied ? "copy.done" : "copy.failed");
    if (tag) tag.textContent = outcome;
    else button.title = outcome;

    // Dropping the classes and forcing a reflow restarts the animation, so a
    // second click gives feedback too instead of silently doing nothing.
    button.classList.remove("copied", "failed");
    void button.offsetWidth;
    button.classList.add(copied ? "copied" : "failed");

    clearTimeout(revert);
    revert = setTimeout(() => {
      if (tag) tag.textContent = t(labelKey);
      else button.title = t(titleKey);
      button.classList.remove("copied", "failed");
    }, 1800);
  });

  return button;
}

/**
 * Copy button in the top-right corner of every code block of an answer.
 *
 * Each block is wrapped rather than hosting the button directly: `pre` scrolls
 * sideways, and an absolutely positioned child of it would drift away with the
 * code. Re-run after every repaint, on markup that has just been rebuilt from
 * scratch, so there is nothing to clean up first.
 */
function addCodeCopyButtons(root) {
  for (const pre of root.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    pre.replaceWith(wrapper);
    wrapper.append(
      pre,
      createCopyButton(code.textContent, { titleKey: "copy.code", className: "code-copy" }),
    );
  }
}

/**
 * Footer under an answer, holding the copy button and the metrics.
 * The button copies the Markdown source, not the rendered text.
 */
function appendFooter(bubble, markdown) {
  const footer = document.createElement("div");
  footer.className = "message-footer";
  bubble.append(footer);

  if (!markdown) return footer; // reasoning only: nothing worth copying

  footer.append(createCopyButton(markdown, { titleKey: "copy.answer", labelKey: "copy.label" }));
  return footer;
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* denied or unavailable: fall through */
  }

  // The Clipboard API needs a secure origin, which a plain-HTTP deployment is
  // not (localhost aside). This path still works there.
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

/**
 * Adds a "tokens · duration · tok/s" line under an answer.
 *
 * Throughput is measured over the total time, from sending the request to the
 * last token, so queueing, prompt processing and reasoning all count against
 * it — that is what the user actually waited for. The time-to-first-token and
 * the token breakdown are one hover away, in the tooltip.
 */
function appendMetrics(container, { requestedAt, firstTokenAt, lastTokenAt, deltaCount, usage, interrupted }) {
  if (firstTokenAt === null) return;

  const tokens = usage?.completion_tokens ?? deltaCount;
  // Total time: from sending the request to the last token, prompt processing
  // and time-to-first-token included.
  const totalSeconds = (lastTokenAt - requestedAt) / 1000;
  const latencySeconds = (firstTokenAt - requestedAt) / 1000;

  // `count` rather than `tokens`: the same value picks the plural form and fills
  // the placeholder, so a one-token answer does not read "1 tokens".
  let text = t("metrics.main", { count: tokens, seconds: formatNumber(totalSeconds) });
  if (totalSeconds > 0) text += t("metrics.rate", { rate: formatNumber(tokens / totalSeconds) });
  if (!usage) text += t("metrics.estimated");
  // A stopped stream never delivers the usage chunk, hence the estimate above.
  if (interrupted) text += t("metrics.interrupted");

  const footer = document.createElement("div");
  footer.className = "metrics";
  footer.textContent = text;

  const detail = [t("metrics.latency", { seconds: formatNumber(latencySeconds) })];
  if (usage) {
    detail.push(
      t("metrics.breakdown", {
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        total: usage.total_tokens,
      }),
    );
  } else {
    detail.push(t("metrics.noUsage"));
  }
  footer.title = detail.join(" — ");

  container.append(footer);
}

function setBusy(value) {
  busy = value;
  attachButton.disabled = value;

  // The send button becomes the stop button while generating. Which of the two
  // it is lives in the attributes, so a language change picks the right one up
  // instead of putting "Send" back on a running generation.
  sendButton.classList.toggle("stop", value);
  const key = value ? "stop.title" : "send.title";
  sendButton.dataset.i18nTitle = key;
  sendButton.dataset.i18nAria = key;
  applyTranslations(sendButton);
}

function setStatus(message, isError = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", isError);
}

// Language first: the model list, and any error it produces, are then already
// written in the right one.
setUpLanguagePicker();
setUpOptionsMenu();
loadModels();
