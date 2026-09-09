/**
 * Web APIs that pdf.js 6 assumes but Safari does not provide, installed only
 * where they are missing.
 *
 * Every entry is feature-detected: on an engine that already has the API this
 * file changes nothing, so it costs nothing to load in every browser and in
 * both threads (the main page and the pdf.js worker each evaluate their own
 * copy).
 *
 * - `Promise.withResolvers` — Safari before 17.4. pdf.js calls it when a
 *   PDFWorker is constructed and on every worker round-trip; without it,
 *   getDocument rejects before any page can be read.
 *
 * - `URL.parse` — Safari before 17.4. pdf.js uses it to compare the worker URL
 *   against the page origin (PDFWorker._isSameOrigin). Unlike `new URL`, it
 *   returns null on an unparseable input instead of throwing, and that is what
 *   pdf.js relies on.
 *
 * - Async iteration over ReadableStream — no Safari release has shipped
 *   `ReadableStream.prototype[Symbol.asyncIterator]`. pdf.js 6 reads the text
 *   layer with `for await (const chunk of stream)` in getTextContent, and its
 *   worker does the same when decompressing font streams; on Safari both throw
 *   "undefined is not a function". The iterator below follows the Web Streams
 *   spec: one reader for the lifetime of the iteration, cancellation through
 *   `return()`/`throw()` unless preventCancel is set (as in values()), and the
 *   lock released exactly once on every exit path — including after the final
 *   chunk, since pdf.js drains a stream to the end without ever calling
 *   return().
 */

if (!Promise.withResolvers) {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

if (typeof URL !== "undefined" && !URL.parse) {
  URL.parse = function parse(input, base) {
    try {
      return new URL(input, base);
    } catch {
      return null;
    }
  };
}

if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  const makeAsyncIterator = (stream, preventCancel) => {
    let closed = false;
    let reader = null;

    /** Releases the lock if we still hold it; a no-op once closed. */
    const release = () => {
      if (!closed) {
        closed = true;
        reader?.releaseLock();
        reader = null;
      }
    };

    return {
      [Symbol.asyncIterator]() {
        return this;
      },

      next() {
        if (closed) return Promise.resolve({ value: undefined, done: true });
        try {
          reader ??= stream.getReader();
          return reader.read().then(
            (chunk) => {
              // The end of the stream closes the iterator and frees the lock;
              // pdf.js never calls return() after it.
              if (chunk.done) release();
              return chunk;
            },
            (error) => {
              release();
              throw error;
            }
          );
        } catch (error) {
          release();
          return Promise.reject(error);
        }
      },

      return(value) {
        if (closed) return Promise.resolve({ value, done: true });
        const r = reader;
        closed = true;
        reader = null;
        if (preventCancel) {
          r?.releaseLock();
          return Promise.resolve({ value, done: true });
        }
        // cancel() releases the lock itself on success; only release it again
        // if cancellation failed and we still hold it.
        return stream.cancel(value).then(
          () => ({ value, done: true }),
          (error) => {
            r?.releaseLock();
            throw error;
          }
        );
      },

      throw(error) {
        if (closed) return Promise.reject(error);
        const r = reader;
        closed = true;
        reader = null;
        if (preventCancel) {
          r?.releaseLock();
          return Promise.reject(error);
        }
        // The iterator rejects with the original error whatever cancel does.
        return stream.cancel(error).then(
          () => {
            throw error;
          },
          () => {
            r?.releaseLock();
            throw error;
          }
        );
      },
    };
  };

  ReadableStream.prototype[Symbol.asyncIterator] = function () {
    return makeAsyncIterator(this, false);
  };

  if (!ReadableStream.prototype.values) {
    ReadableStream.prototype.values = function values() {
      return makeAsyncIterator(this, true);
    };
  }
}
