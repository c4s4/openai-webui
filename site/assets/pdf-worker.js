/**
 * Entry point for the pdf.js worker.
 *
 * The worker is a separate JavaScript global scope, so the polyfills installed
 * on the main page do not reach it — and its font-stream decompression does the
 * same `for await (… of stream)` that Safari cannot run. Evaluating the
 * polyfills first here covers both threads; the re-export keeps pdf.js's
 * fake-worker fallback working, which reads WorkerMessageHandler off this very
 * module.
 */

import "./polyfills.js";

export * from "./vendor/pdf.worker.min.js";
