export function normalizeMicroManagerNote(note: string): string {
  return note
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const SUPPRESSED_NORMALIZED_PHRASES = new Set([
  "stop",
  "stop here",
  "stop now",
  "halt",
  "abort",
  "done",
  "task done",
  "task complete",
  "complete",
  "finished",
  "ok",
  "okay",
  "ok done",
  "no issue",
  "no issues",
  "no issue continue",
  "no concerns",
  "no concern",
  "nothing to add",
  "nothing to flag",
  "nothing to report",
  "no notes",
  "no further input",
  "no further input needed",
  "no further input required",
  "no further report",
  "no further report needed",
  "lgtm",
  "looks good",
  "all good",
  "agent is on track",
  "agent on track",
  "on track",
  "continue",
  "carry on",
]);

const DEFAULT_HISTORY_CAPACITY = 4096;

export class MicroManagerEmissionGuard {
  readonly #capacity: number;
  #consumedThisUpdate = false;
  #seen = new Set<string>();
  #seenOrder: string[] = [];

  constructor(options: { capacity?: number } = {}) {
    this.#capacity = options.capacity ?? DEFAULT_HISTORY_CAPACITY;
  }

  beginUpdate(): void {
    this.#consumedThisUpdate = false;
  }

  reset(): void {
    this.#seen.clear();
    this.#seenOrder = [];
    this.#consumedThisUpdate = false;
  }

  accept(note: string): boolean {
    const key = normalizeMicroManagerNote(note);
    if (!key || SUPPRESSED_NORMALIZED_PHRASES.has(key)) return false;
    if (this.#seen.has(key) || this.#consumedThisUpdate) return false;

    this.#consumedThisUpdate = true;
    this.#seen.add(key);
    this.#seenOrder.push(key);
    if (this.#seenOrder.length > this.#capacity) {
      const stale = this.#seenOrder.shift();
      if (stale !== undefined) this.#seen.delete(stale);
    }
    return true;
  }
}
