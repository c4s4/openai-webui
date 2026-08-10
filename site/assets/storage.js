/**
 * The two remembered settings — the language and the model — behind a pair of
 * functions that never throw.
 *
 * `localStorage` is not always there to be read: a browser told to block storage
 * for the site raises on the very first access rather than handing back an empty
 * store. Read at module load, as the language is, that exception takes the whole
 * page down — no script at all, and an interface frozen on "Loading models…".
 * Losing the memory of a choice is a far smaller thing than losing the page, so
 * a failure here is answered with "nothing stored" and the defaults that follow
 * from it.
 */

/** The value stored under `key`, or null — unreadable storage included. */
export function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value` under `key` if storage allows it, and says nothing if it does not. */
export function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked or full: the choice holds for this page and no longer */
  }
}
