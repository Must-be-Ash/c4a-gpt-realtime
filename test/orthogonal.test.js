import assert from "node:assert/strict";
import test from "node:test";

import {
  createOrthogonalDiscoveryClient,
  normalizeOrthogonalCatalog,
} from "../src/services/orthogonal.js";

test("normalizes Orthogonal catalog entries into AgentCash-payable URLs", () => {
  const normalized = normalizeOrthogonalCatalog({
    success: true,
    results: [{
      name: "Apollo.io",
      slug: "apollo",
      verified: true,
      endpoints: [{
        path: "/v1/people/match",
        method: "POST",
        description: "Enrich a person",
        price: "0.03",
        isPayable: true,
      }],
    }],
  });

  assert.equal(normalized.results[0].endpoints[0].x402Url, "https://x402.orthogonal.com/apollo/v1/people/match");
  assert.equal(normalized.results[0].endpoints[0].mppUrl, "https://mpp.orthogonal.com/apollo/v1/people/match");
});

test("does not manufacture payment URLs for explicitly non-payable endpoints", () => {
  const normalized = normalizeOrthogonalCatalog({
    results: [{ slug: "free-api", endpoints: [{ path: "/lookup", isPayable: false }] }],
  });

  assert.equal(normalized.results[0].endpoints[0].x402Url, undefined);
  assert.equal(normalized.results[0].endpoints[0].mppUrl, undefined);
});

test("uses Orthogonal only for authenticated discovery and returns endpoint payment details", async () => {
  const calls = [];
  const client = createOrthogonalDiscoveryClient({
    apiKey: "orth_test",
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/v1/search")) return { success: true, results: [] };
      return {
        success: true,
        api: { slug: "apollo" },
        endpoint: { path: "/v1/people/match", isPayable: true },
        usage: { x402: "https://x402.orthogonal.com/apollo/v1/people/match" },
      };
    },
  });

  await client.search({ prompt: "find developer relations candidates", limit: 5 });
  const details = await client.details({ api: "apollo", path: "/v1/people/match" });

  assert.equal(calls[0].options.headers.authorization, "Bearer orth_test");
  assert.equal(details.usage.x402, "https://x402.orthogonal.com/apollo/v1/people/match");
  assert.equal(calls.some(({ url }) => url.endsWith("/v1/run")), false);
});

test("lists the Orthogonal catalog through its read-only GET endpoint", async () => {
  const calls = [];
  const client = createOrthogonalDiscoveryClient({
    apiKey: "orth_test",
    request: async (url, options) => {
      calls.push({ url, options });
      return { apis: [{ slug: "hunter", endpoints: [{ path: "/email-finder" }] }] };
    },
  });

  const result = await client.list({ limit: 25, offset: 50 });
  assert.match(calls[0].url, /\/v1\/list-endpoints\?limit=25&offset=50$/);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(result.apis[0].endpoints[0].x402Url, "https://x402.orthogonal.com/hunter/email-finder");
});

test("fails clearly when Orthogonal discovery is not configured", async () => {
  const client = createOrthogonalDiscoveryClient({ apiKey: "" });
  await assert.rejects(client.search({ prompt: "find an API" }), /ORTHOGONAL_API_KEY/);
});
