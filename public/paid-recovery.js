const normalizeIntent = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const requestFingerprint = (toolName, argumentsValue) => JSON.stringify({
  toolName,
  arguments: canonicalize(argumentsValue),
});

const endpointOf = (argumentsValue) => String(
  argumentsValue?.url ?? argumentsValue?.origin ?? argumentsValue?.endpoint ?? "catalog",
);

export function createPaidAttemptTracker({ maxIntents = 20 } = {}) {
  const attemptsByIntent = new Map();

  return {
    register({ intent, toolName, argumentsValue }) {
      const key = normalizeIntent(intent) || String(toolName || "paid request");
      let record = attemptsByIntent.get(key);
      if (!record) {
        if (attemptsByIntent.size >= maxIntents) attemptsByIntent.delete(attemptsByIntent.keys().next().value);
        record = { fingerprints: new Set(), endpoints: new Set() };
        attemptsByIntent.set(key, record);
      }
      const fingerprint = requestFingerprint(toolName, argumentsValue);
      const duplicate = record.fingerprints.has(fingerprint);
      if (!duplicate) {
        record.fingerprints.add(fingerprint);
        record.endpoints.add(endpointOf(argumentsValue));
      }
      return {
        duplicate,
        attemptCount: record.fingerprints.size,
        distinctEndpointCount: record.endpoints.size,
      };
    },

    clear(intent) {
      attemptsByIntent.delete(normalizeIntent(intent));
    },
  };
}

export function classifyPaidFailure({ failure, empty, data }) {
  if (empty) return "empty_result";
  const status = Number(data?.statusCode ?? data?.status ?? data?.data?.statusCode ?? data?.data?.status);
  const provider = data?.providerError ?? data?.data?.providerError;
  if (
    [400, 409, 422].includes(status)
    || Array.isArray(data?.validationErrors)
    || Array.isArray(provider?.validationErrors)
    || provider?._orthogonal?.expected_schema
  ) return "invalid_request";
  if (failure) return "provider_failure";
  return null;
}
