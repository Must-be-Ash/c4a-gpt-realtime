import { ARTIFACT_LIMITS } from "../src/shared/artifact-schema.js";

const X402_NAVIGATION_TOOLS = new Set([
  "discover_services",
  "get_service",
  "get_openapi_spec",
  "search",
  "discover_api_endpoints",
  "check_endpoint_schema",
]);
const CANDIDATE_NAME_KEYS = ["full_name", "display_name", "name"];
const CANDIDATE_SUBTITLE_KEYS = ["headline", "job_title", "current_title", "title", "position"];
const CANDIDATE_DETAIL_KEYS = ["summary", "about", "bio", "description"];
const CANDIDATE_IMAGE_KEYS = ["avatar_url", "photo_url", "profile_picture_url", "image_url", "picture", "image"];
const CANDIDATE_LINK_KEYS = ["linkedin_url", "github_url", "twitter_url", "x_url", "profile_url", "website", "url"];
const CANDIDATE_SIGNAL_KEYS = [
  "headline", "job_title", "current_title", "position", "email", "company", "location",
  ...CANDIDATE_IMAGE_KEYS,
  "linkedin_url", "github_url", "twitter_url", "x_url", "profile_url",
];

const isObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const clip = (value, length) => String(value ?? "").slice(0, length);
const humanize = (value) => clip(value, 80)
  .replace(/^coinbase[_-]?/i, "")
  .replace(/[_-]+/g, " ")
  .replace(/\b\w/g, (character) => character.toUpperCase())
  .trim() || "Result";

const displayValue = (value, maxLength = 240) => {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value.toLocaleString("en-US", { maximumFractionDigits: 8 })
      : "—";
  }
  if (typeof value === "string") return clip(value, maxLength);
  try {
    return clip(JSON.stringify(value), maxLength);
  } catch {
    return clip(value, maxLength);
  }
};

const isUrl = (value) => typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value);
const firstValue = (record, keys) => {
  for (const key of keys) {
    if (record[key] != null && record[key] !== "") return record[key];
  }
  return undefined;
};
const candidateName = (record) => firstValue(record, CANDIDATE_NAME_KEYS)
  || [record.first_name, record.last_name].filter(Boolean).join(" ")
  || (
    typeof record.title === "string"
    && isUrl(record.url)
    && /(?:linkedin\.com\/in|github\.com\/[^/]+\/?$)/i.test(record.url)
      ? record.title
      : ""
  );
const hasCandidateProfileData = (record) => Boolean(
  firstValue(record, CANDIDATE_SIGNAL_KEYS)
  || record.first_name
  || record.last_name
  || (isObject(record.socials) && Object.keys(record.socials).some((key) => isUrl(record.socials[key])))
);

export function x402FailureMessage(value) {
  const cause = value?.data?.cause || value?.cause || value?.providerError?.cause;
  const status = Number(value?.statusCode ?? value?.status ?? value?.data?.statusCode ?? value?.data?.status);
  const failed = value?.ok === false
    || status >= 400
    || value?.success === false
    || value?.data?.success === false
    || value?.providerError?.success === false
    || Boolean(value?.cause)
    || Boolean(value?.data?.cause)
    || Boolean(value?.providerError?.cause)
    || value?.type === "before_payment"
    || value?.data?.type === "before_payment";
  if (!failed) return null;
  if (cause === "insufficient_balance") return "The selected payment account has insufficient funds.";
  return String(
    value?.data?.error
    || value?.providerError?.error
    || value?.data?.message
    || value?.providerError?.message
    || value?.error
    || value?.message
    || value?.data?.cause
    || value?.cause
    || `Request failed (${status || "unknown"})`
  );
}

const mcpTextContent = (result, separator = "") => result?.content
  ?.filter((item) => item?.type === "text" && typeof item.text === "string")
  .map((item) => item.text)
  .join(separator) || "";

export function classifyX402Result(toolName, result = null) {
  const normalizedName = String(toolName ?? "").trim();
  const navigation = X402_NAVIGATION_TOOLS.has(normalizedName);
  if (result?.isError === true) {
    const failure = mcpTextContent(result, " ").replace(/^Error:\s*/i, "").trim()
      || "x402 tool call failed.";
    return { data: null, navigation, failure, autoDisplay: false };
  }
  const data = unwrapToolResult(result);
  const failure = x402FailureMessage(data);
  const empty = !failure && isEmptyToolResult(data);
  return { data, navigation, failure, empty, autoDisplay: !navigation && !failure && !empty };
}

export function isEmptyToolResult(value) {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (!isObject(value)) return false;
  if (Object.keys(value).length === 0) return true;
  const count = value.total_results ?? value.totalResults ?? value.count
    ?? value.pagination?.total_results ?? value.pagination?.totalResults;
  if (Number(count) === 0) return true;
  const resultKeys = ["results", "records", "items", "data", "people", "candidates", "jobs", "companies"];
  const presentArrays = resultKeys
    .filter((key) => Object.hasOwn(value, key) && Array.isArray(value[key]));
  if (presentArrays.length > 0) return presentArrays.every((key) => value[key].length === 0);
  for (const key of ["data", "result", "response", "payload"]) {
    if (Object.hasOwn(value, key) && (isObject(value[key]) || Array.isArray(value[key]))) {
      return isEmptyToolResult(value[key]);
    }
  }
  const metadataKeys = new Set([
    "success", "ok", "status", "statusCode", "pagination", "message", "requestId",
    "paymentInfo", "route",
  ]);
  return Object.keys(value).every((key) => metadataKeys.has(key));
}

export function unwrapToolResult(result) {
  if (result?.structuredContent != null) return result.structuredContent;
  if (!Array.isArray(result?.content)) return result;
  const text = mcpTextContent(result);
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function tableBlock(title, rows) {
  const records = [];
  for (const row of rows) {
    if (isObject(row)) records.push(row);
    if (records.length === ARTIFACT_LIMITS.tableRows) break;
  }
  const columns = [];
  const seen = new Set();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
      if (columns.length === ARTIFACT_LIMITS.tableColumns) break;
    }
    if (columns.length === ARTIFACT_LIMITS.tableColumns) break;
  }
  if (!columns.length) return null;
  return {
    type: "table",
    title: clip(humanize(title), 120),
    columns: columns.map(humanize),
    rows: records.map((record) => columns.map((column) => displayValue(record[column]))),
  };
}

function candidateCardsBlock(title, rows) {
  const candidates = [];
  let hasProfileData = false;
  for (const row of rows) {
    if (!isObject(row) || !candidateName(row)) return null;
    if (hasCandidateProfileData(row)) hasProfileData = true;
    if (candidates.length < ARTIFACT_LIMITS.cards) candidates.push(row);
  }
  if (!candidates.length || !hasProfileData) return null;

  return {
    type: "cards",
    title: clip(humanize(title), 120),
    items: candidates.map((candidate) => {
      const links = [];
      const email = String(candidate.email ?? "").trim();
      if (/^[^\s@]+@[^\s@]+$/.test(email)) links.push({ label: "Email", url: `mailto:${email}` });
      for (const key of CANDIDATE_LINK_KEYS) {
        if (links.length === ARTIFACT_LIMITS.cardLinks) break;
        if (isUrl(candidate[key])) links.push({ label: humanize(key.replace(/_url$/, "")), url: candidate[key] });
      }
      if (isObject(candidate.socials)) {
        for (const label of Object.keys(candidate.socials)) {
          if (links.length === ARTIFACT_LIMITS.cardLinks) break;
          const url = candidate.socials[label];
          if (isUrl(url) && !links.some((link) => link.url === url)) links.push({ label: humanize(label), url });
        }
      }
      const name = candidateName(candidate);
      const subtitle = firstValue(candidate, CANDIDATE_SUBTITLE_KEYS);
      const imageUrl = firstValue(candidate, CANDIDATE_IMAGE_KEYS);
      const detail = firstValue(candidate, CANDIDATE_DETAIL_KEYS)
        || [candidate.company, candidate.location].filter(Boolean).join(" · ");
      return {
        title: clip(name, 160),
        subtitle: subtitle ? clip(subtitle, 160) : null,
        detail: detail ? clip(detail, 500) : null,
        imageUrl: isUrl(imageUrl) ? imageUrl : null,
        links,
      };
    }),
  };
}

function listBlock(title, values) {
  const items = values.slice(0, ARTIFACT_LIMITS.listItems).map((value, index) => {
    if (isObject(value)) {
      const entries = Object.entries(value);
      const [firstKey, firstValue] = entries[0] ?? ["Item", index + 1];
      return {
        title: clip(`${humanize(firstKey)}: ${displayValue(firstValue, 120)}`, 160),
        detail: entries.length > 1
          ? clip(entries.slice(1).map(([key, item]) => `${humanize(key)}: ${displayValue(item, 120)}`).join(" · "), 360)
          : null,
        tag: null,
        tone: "neutral",
      };
    }
    return { title: clip(displayValue(value, 160), 160), detail: null, tag: null, tone: "neutral" };
  });
  return items.length ? { type: "list", title: clip(humanize(title), 120), items } : null;
}

function addObjectBlocks(blocks, value, heading, depth = 0) {
  if (blocks.length >= ARTIFACT_LIMITS.blocks) return;
  const entries = Object.entries(value);
  const links = entries.filter(([, item]) => isUrl(item));
  const scalars = entries.filter(([, item]) => !isObject(item) && !Array.isArray(item) && !isUrl(item));
  if (scalars.length) {
    blocks.push({
      type: "key_value",
      title: heading ? clip(humanize(heading), 120) : null,
      items: scalars.slice(0, ARTIFACT_LIMITS.keyValues).map(([key, item]) => ({ label: clip(humanize(key), 100), value: displayValue(item, 300) })),
    });
  }
  if (links.length && blocks.length < ARTIFACT_LIMITS.blocks) {
    blocks.push({
      type: "links",
      title: heading ? `${clip(humanize(heading), 108)} links` : "Links",
      items: links.slice(0, ARTIFACT_LIMITS.links).map(([key, url]) => ({ label: clip(humanize(key), 160), url, detail: null })),
    });
  }
  for (const [key, item] of entries) {
    if (blocks.length >= ARTIFACT_LIMITS.blocks) break;
    if (Array.isArray(item)) {
      const block = item.length > 0 && item.every(isObject)
        ? candidateCardsBlock(key, item) || tableBlock(key, item)
        : listBlock(key, item);
      if (block) blocks.push(block);
    } else if (isObject(item) && depth < 2) {
      addObjectBlocks(blocks, item, key, depth + 1);
    }
  }
}

export function buildToolResultArtifact({ title, source, result }) {
  const value = result;
  const blocks = [];

  if (Array.isArray(value)) {
    const block = value.length > 0 && value.every(isObject)
      ? candidateCardsBlock("Results", value) || tableBlock("Results", value)
      : listBlock("Results", value);
    if (block) blocks.push(block);
  } else if (isObject(value)) {
    addObjectBlocks(blocks, value, null);
  } else if (value != null && value !== "") {
    blocks.push({ type: "text", title: null, body: clip(displayValue(value, 1_200), 1_200), tone: "neutral" });
  }

  if (!blocks.length) {
    blocks.push({ type: "text", title: null, body: "No records were returned.", tone: "neutral" });
  }

  return {
    title: clip(title || "Tool result", 120),
    subtitle: "Rendered from the completed tool result.",
    source: source ? clip(source, 120) : null,
    blocks: blocks.slice(0, ARTIFACT_LIMITS.blocks),
  };
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const timestampFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const finiteNumber = (value) => value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const usd = (value) => {
  const number = finiteNumber(value);
  return number == null ? "—" : usdFormatter.format(number);
};
const shortTimestamp = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? displayValue(value) : timestampFormatter.format(date);
};

export function buildSmartMoneyArtifact(result) {
  const lean = ["bullish", "bearish"].includes(result.lean) ? result.lean : "mixed";
  const leanTone = lean === "bullish" ? "positive" : lean === "bearish" ? "negative" : "neutral";
  const topTrades = Array.isArray(result.topTrades) ? result.topTrades.slice(0, 8) : [];
  const tradeCount = finiteNumber(result.tradeCount);
  const bullishActivity = finiteNumber(result.bullishActivityUsd);
  const bearishActivity = finiteNumber(result.bearishActivityUsd);
  const netBias = finiteNumber(result.netBiasUsd);
  const blocks = [
    {
      type: "metrics",
      title: null,
      items: [
        { label: "Lean", value: humanize(lean), detail: tradeCount == null ? "Trade count unavailable" : `${tradeCount} returned trades`, tone: leanTone },
        { label: "Bullish activity", value: usd(bullishActivity), detail: null, tone: "positive" },
        { label: "Bearish activity", value: usd(bearishActivity), detail: null, tone: "negative" },
        { label: "Net bias", value: usd(netBias), detail: null, tone: netBias > 0 ? "positive" : netBias < 0 ? "negative" : "neutral" },
      ],
    },
  ];
  if (topTrades.length) {
    blocks.push({
      type: "table",
      title: "Largest trades",
      columns: ["Trader", "Side", "Action", "Value", "Signal", "Time"],
      rows: topTrades.map((trade) => [
        displayValue(trade.traderLabel || "Unlabeled", 240),
        displayValue(trade.side),
        displayValue(trade.action),
        usd(trade.valueUsd),
        humanize(trade.signal),
        shortTimestamp(trade.timestamp),
      ]),
    });
  }
  return {
    title: `${clip(result.symbol || "Crypto", 15)} · smart money`,
    subtitle: result.payment
      ? "Nansen-labeled perpetual trades · paid via x402"
      : "Nansen-labeled perpetual trades",
    source: clip(result.source || "Nansen", 120),
    blocks,
  };
}

export const toolTitle = (name) => humanize(name);
