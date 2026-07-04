// Tiny promise-based semaphore for bounding concurrency.
// Used to protect upstream backends and the gateway itself under load.

export class Semaphore {
  /**
   * @param {number} max Maximum concurrent holders. 0 = unlimited.
   */
  constructor(max) {
    this.max = max;
    this.active = 0;
    /** @type {Array<() => void>} */
    this.queue = [];
  }

  get available() {
    if (this.max === 0) return Infinity;
    return Math.max(0, this.max - this.active);
  }

  /**
   * @returns {Promise<void>} resolves when a slot is acquired.
   */
  async acquire() {
    if (this.max === 0 || this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Run `fn` while holding a slot; always releases (even on error).
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
