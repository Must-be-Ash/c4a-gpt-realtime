import { randomUUID } from "node:crypto";

export class PreviewStore {
  #currentId = null;
  #previews = new Map();

  constructor({ ttlMs = 120_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  create(order, previewResult = null) {
    if (this.#currentId) {
      const previous = this.#previews.get(this.#currentId);
      if (previous && previous.status === "pending") {
        previous.status = "superseded";
      }
    }

    const createdAt = this.now();
    const item = {
      id: randomUUID(),
      order: structuredClone(order),
      previewResult,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: "pending",
    };
    this.#previews.set(item.id, item);
    this.#currentId = item.id;
    return structuredClone(item);
  }

  get(id) {
    const item = this.#previews.get(id);
    return item ? structuredClone(item) : null;
  }

  consume(id) {
    const item = this.claim(id);
    this.complete(id);
    return item;
  }

  claim(id) {
    const item = this.#previews.get(id);
    if (!item) throw new Error("Order preview was not found.");
    if (item.status === "executed") throw new Error("Order preview was already executed.");
    if (item.status === "executing") throw new Error("Order preview is already executing.");
    if (item.status === "superseded") throw new Error("Order preview was superseded by a newer preview.");
    if (item.status !== "pending") throw new Error(`Order preview is ${item.status}.`);
    if (this.now() > item.expiresAt) {
      item.status = "expired";
      throw new Error("Order preview expired; create a new preview.");
    }

    item.status = "executing";
    return structuredClone(item);
  }

  release(id) {
    const item = this.#previews.get(id);
    if (!item || item.status !== "executing") throw new Error("Order preview is not executing.");
    item.status = "pending";
    return structuredClone(item);
  }

  complete(id, executionResult = null) {
    const item = this.#previews.get(id);
    if (!item || item.status !== "executing") throw new Error("Order preview is not executing.");
    item.status = "executed";
    item.executionResult = executionResult;
    return structuredClone(item);
  }
}
