import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const parseJson = (value) => { if (!value) return null; try { return JSON.parse(value); } catch { return null; } };
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
  // Hosted web + phone capability (off by default for local dev).
  enableWebPhone: /^(1|true|yes)$/i.test(process.env.ENABLE_WEB_PHONE ?? ""),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  vapiWebhookSecret: process.env.VAPI_WEBHOOK_SECRET ?? "",
  vapiAgentId: process.env.VAPI_AGENT_ID ?? "",
  vapiPhoneNumber: process.env.VAPI_PHONE_NUMBER ?? "",
  // Direct OpenAI Realtime over SIP (no Vapi) — pick any realtime model incl. gpt-live-1.
  enableOpenAiSip: /^(1|true|yes)$/i.test(process.env.ENABLE_OPENAI_SIP ?? ""),
  openAiSipModel: process.env.OPENAI_SIP_MODEL ?? "gpt-realtime-2.1",
  // Which OpenAI agent answers the Telnyx number when runtime/settings.json is absent.
  openAiSipDefaultAgent: process.env.OPENAI_SIP_AGENT ?? "gpt-live-1",
  // gpt-live-1 (GPT-Live API) delegation backend model.
  openAiLiveBackendModel: process.env.OPENAI_LIVE_BACKEND_MODEL ?? "gpt-5.6-luna",
  openAiLiveReasoningEffort: process.env.OPENAI_LIVE_REASONING_EFFORT ?? "low",
  // Realtime-path latency knobs. Turn detection as JSON (see openai-sip.js DEFAULT_TURN_DETECTION).
  openAiSipTurnDetection: parseJson(process.env.OPENAI_SIP_TURN_DETECTION),
  openAiSipTranscribeModel: process.env.OPENAI_SIP_TRANSCRIBE_MODEL ?? "",
  openAiSipFiller: /^(1|true|yes)$/i.test(process.env.OPENAI_SIP_FILLER ?? ""),
  openAiWebhookSecret: process.env.OPENAI_WEBHOOK_SECRET ?? "",
  openAiProjectId: process.env.OPENAI_PROJECT_ID ?? "",
  sipPhoneNumber: process.env.SIP_PHONE_NUMBER ?? "",
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "",
  allowedCallers: (process.env.PHONE_NUMBER ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  // Outbound pitch calls ("Jordan"). See docs/specs/wolf-pitch-calls.md.
  pitch: {
    enabled: /^(1|true|yes)$/i.test(process.env.ENABLE_PITCH_CALLS ?? ""),
    dryRun: /^(1|true|yes)$/i.test(process.env.PITCH_DRY_RUN ?? ""),
    deskDatabaseUrl: process.env.DESK_DATABASE_URL ?? "",
    vapiApiKey: process.env.VAPI_PRIVATE_KEY ?? "",
    assistantId: process.env.VAPI_PITCH_ASSISTANT_ID ?? "",
    phoneNumberId: process.env.VAPI_PITCH_PHONE_NUMBER_ID ?? "",
    phoneNumber: process.env.PITCH_PHONE_NUMBER ?? "",
    callTo: process.env.PITCH_CALL_TO || (process.env.PHONE_NUMBER ?? "").split(",")[0].trim(),
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? "Ifu36BnEjjIY932etsqk",
    fallbackVoice: process.env.PITCH_FALLBACK_VOICE ?? "Godfrey",
    maxOrderUsd: Number(process.env.PITCH_MAX_ORDER_USD ?? 500) || 500,
    maxCallsPerDay: integer(process.env.PITCH_MAX_CALLS_PER_DAY, 3),
    minSpacingMin: integer(process.env.PITCH_MIN_SPACING_MIN, 60),
    minConviction: integer(process.env.PITCH_MIN_CONVICTION, 7),
    maxIdeaAgeHours: Number(process.env.PITCH_MAX_IDEA_AGE_HOURS ?? 6) || 6,
    minRewardRisk: Number(process.env.PITCH_MIN_REWARD_RISK ?? 1.5) || 1.5,
    scanIntervalMin: integer(process.env.PITCH_SCAN_INTERVAL_MIN, 10),
    llmModel: process.env.PITCH_LLM_MODEL ?? "gpt-4.1",
    // gpt-realtime-2.1 engine: Telnyx dials, OpenAI SIP answers.
    engine: process.env.PITCH_ENGINE ?? "elevenlabs",
    telnyxApiKey: process.env.TELNYX_API_KEY ?? "",
    telnyxConnectionId: process.env.TELNYX_PITCH_CONNECTION_ID ?? "",
    openAiProjectId: process.env.OPENAI_PROJECT_ID ?? "",
    stateSecret: process.env.SESSION_SECRET || process.env.VAPI_WEBHOOK_SECRET || "",
    realtimeModel: process.env.PITCH_REALTIME_MODEL ?? process.env.OPENAI_SIP_MODEL ?? "gpt-realtime-2.1",
    realtimeVoice: process.env.PITCH_REALTIME_VOICE ?? "cedar",
  },
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
