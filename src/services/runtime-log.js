import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SENSITIVE_KEY = /(authorization|cookie|secret|private.?key|api.?key|password|token)$/i;
const MAX_DEPTH = 10;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_STRING_LENGTH = 50_000;

function redactValue(value, seen, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]` : value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause ? redactValue(value.cause, seen, depth + 1) : undefined,
    };
  }
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, seen, depth + 1));
  }
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item, seen, depth + 1);
  }
  return output;
}

export function redactLogValue(value) {
  return redactValue(value, new WeakSet());
}

export function createRuntimeLogger({ filePath, consoleWriter = console.log, errorWriter = console.error }) {
  let directoryReady = false;
  let writes = Promise.resolve();

  const log = (event, details = {}) => {
    const entry = redactLogValue({ time: new Date().toISOString(), event, ...details });
    const line = JSON.stringify(entry);
    consoleWriter(line);
    writes = writes
      .catch(() => undefined)
      .then(async () => {
        if (!directoryReady) {
          await mkdir(dirname(filePath), { recursive: true });
          directoryReady = true;
        }
        await appendFile(filePath, `${line}\n`, "utf8");
      })
      .catch((error) => errorWriter(`Runtime log write failed: ${error.message}`));
    return entry;
  };

  return { log, flush: () => writes, filePath };
}
