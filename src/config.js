import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const integer = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: integer(process.env.PORT, 4173),
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1",
  realtimeVoice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
  summaryModel: process.env.OPENAI_SUMMARY_MODEL ?? "gpt-5.6-luna",
  exaApiKey: process.env.EXA_API_KEY ?? "",
  spongeApiKey: process.env.SPONGE_API_KEY ?? "",
  orthogonalApiKey: process.env.ORTHOGONAL_API_KEY ?? "",
  coinbaseEnv: process.env.COINBASE_ENV ?? "live",
  defaultProduct: process.env.DEFAULT_PRODUCT ?? "HYPE-USD",
  previewTtlMs: integer(process.env.PREVIEW_TTL_MS, 120_000),
};

export const publicConfig = () => ({
  defaultProduct: config.defaultProduct,
  realtimeModel: config.realtimeModel,
  realtimeVoice: config.realtimeVoice,
  readiness: {
    openAi: Boolean(config.openAiApiKey),
    exa: Boolean(config.exaApiKey),
    sponge: Boolean(config.spongeApiKey),
    orthogonal: Boolean(config.orthogonalApiKey),
    coinbase: Boolean(process.env.COINBASE_KEY_ID && process.env.COINBASE_KEY_SECRET),
  },
});
