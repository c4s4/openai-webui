/**
 * Markdown rendering for model output.
 *
 * marked parses the Markdown, highlight.js colours the fenced code blocks, and
 * DOMPurify has the last word: the input is untrusted model output, so nothing
 * reaches the DOM without going through the sanitizer. A `<script>` or an
 * `onerror=` handled by the model is stripped before insertion.
 *
 * The three libraries are pinned and committed under assets/vendor/, so the app
 * fetches nothing at runtime and the deployment stays a plain file copy.
 */

import { marked } from "./vendor/marked.esm.js";
import hljs from "./vendor/highlight.esm.min.js";
import DOMPurify from "./vendor/purify.esm.min.js";

marked.use({
  gfm: true,
  breaks: true, // a lone newline is a line break, as in every chat interface
  renderer: {
    code({ text, lang }) {
      // The info string may carry more than the language: "js title=app.js".
      const name = (lang || "").trim().split(/\s+/)[0].toLowerCase();
      const language = name && hljs.getLanguage(name) ? name : null;
      // highlight.js escapes what it emits; without a known language we escape
      // the code ourselves rather than trusting auto-detection.
      const body = language ? hljs.highlight(text, { language }).value : escapeHtml(text);
      const classes = language ? `hljs language-${language}` : "hljs";
      return `<pre><code class="${classes}">${body}</code></pre>`;
    },

    // Raw HTML written by the model is shown as text rather than rendered: a
    // `<div>` in an explanation is meant to be read, and the sanitizer would
    // otherwise make some of it silently disappear.
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

// Links leave the app, so they open in a new tab and never hand over the opener.
// Done after sanitising, so model markup cannot override these attributes.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(text) {
  if (!text) return "";
  return DOMPurify.sanitize(marked.parse(text), { ADD_ATTR: ["target"] });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
