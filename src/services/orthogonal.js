import { fetchJson } from "../lib/http.js";

const API_ROOT = "https://api.orthogonal.com";
const PAYMENT_ROOTS = {
  x402: "https://x402.orthogonal.com",
  mpp: "https://mpp.orthogonal.com",
};

const cleanPath = (value) => {
  const path = String(value ?? "").trim();
  return path ? `/${path.replace(/^\/+/, "")}` : "";
};

const apiSlug = (api, fallback = "") => String(
  api?.slug ?? api?.api ?? api?.id ?? api?.name ?? fallback,
).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");

const payableEndpoint = (endpoint, slug) => {
  const path = cleanPath(endpoint?.path);
  if (!slug || !path || endpoint?.isPayable === false) return { ...endpoint };
  return {
    ...endpoint,
    x402Url: endpoint?.x402Url ?? `${PAYMENT_ROOTS.x402}/${slug}${path}`,
    mppUrl: endpoint?.mppUrl ?? `${PAYMENT_ROOTS.mpp}/${slug}${path}`,
  };
};

const normalizeApi = (api) => {
  const slug = apiSlug(api);
  const endpoints = Array.isArray(api?.endpoints)
    ? api.endpoints.map((endpoint) => payableEndpoint(endpoint, slug))
    : api?.endpoint
      ? [payableEndpoint(api.endpoint, slug)]
      : [];
  return { ...api, slug, endpoints };
};

export function normalizeOrthogonalCatalog(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload.results)) {
    return { ...payload, results: payload.results.map(normalizeApi) };
  }
  if (Array.isArray(payload.apis)) {
    return { ...payload, apis: payload.apis.map(normalizeApi) };
  }
  const slug = apiSlug(payload.api, payload.api);
  const endpoint = payload.endpoint ? payableEndpoint(payload.endpoint, slug) : payload.endpoint;
  return { ...payload, ...(endpoint ? { endpoint } : {}) };
}

export function createOrthogonalDiscoveryClient({ apiKey, request = fetchJson } = {}) {
  const call = async (path, { method = "POST", body } = {}) => {
    if (!apiKey) throw new Error("ORTHOGONAL_API_KEY is not configured.");
    return normalizeOrthogonalCatalog(await request(`${API_ROOT}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
  };

  return {
    search: ({ prompt, limit = 5 }) => call("/v1/search", { body: { prompt, limit } }),
    details: ({ api, path }) => call("/v1/details", { body: { api, path } }),
    list: ({ limit = 20, offset = 0 } = {}) => {
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      return call(`/v1/list-endpoints?${query}`, { method: "GET" });
    },
  };
}
