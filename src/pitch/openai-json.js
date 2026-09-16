// Strict-JSON call to the OpenAI Responses API (same pattern as news-summaries).

import { fetchJson } from "../lib/http.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

const responseText = (response) => {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("");
};

export async function openAiJson({ apiKey, model, input, name, schema, effort = "low", request = fetchJson, timeoutMs = 45_000 }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");
  const response = await request(RESPONSES_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      reasoning: { effort },
      store: false,
      input,
      text: { format: { type: "json_schema", name, strict: true, schema } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    return JSON.parse(responseText(response));
  } catch {
    throw new Error(`OpenAI returned malformed ${name} output.`);
  }
}
