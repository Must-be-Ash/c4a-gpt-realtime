# Handoff — Coinbase for Agents: hosted phone + web, 3-agent switcher

Read this, then `AGENT_SWITCHER_SPEC.md` (the checklist, with the verified GPT-Live contract in §3), then the code. Code is the source of truth.

## The vision
A local browser voice trading/research agent (OpenAI speech-to-speech + Coinbase + Exa + AgentCash) that the owner can also **phone from anywhere** and **watch on a private dashboard**. Priorities: (1) low latency + natural interruption, (2) run OpenAI's newest models directly (gpt-live-1), (3) switch between backends and compare, (4) never break `main`; additive and gated; owner approves purchases.

## Where things are (2026-09-11)
- **Prod** `https://coinbase-for-agents-phone.fly.dev` (Fly, one always-on machine, password-gated) runs `main`. All three agents work from the dashboard dropdown: **gpt-realtime-2.1** (Realtime SIP), **gpt-live-1** (GPT-Live API over SIP; needs `;secure=srtp` on the Telnyx leg), **Vapi**. Selection persists on the volume.
- **Owner's verdict so far:** gpt-realtime-2.1 is the smoothest (speech in step with visuals). gpt-live-1 has the fastest tools but its voice narrated ahead of results and interrupted poorly on phone audio; prompt now forbids announcements and the backend returns two-sentence facts. Vapi is fast on tools but its pipeline plays the model's preamble after the tool already returned.
- **Per-call latency + captions** on both OpenAI paths: GPT-Live emits transcripts as deltas only (no done event), so captions flush on a quiet gap / turn change; `session.delegation.created` marks the end of the caller's command. Event shapes are logged once per call (`openai.live.event_shape`).
- **Landing + skills:** three agent-guided setup paths (`/skill` local, `/skill-web-vapi`, `/skill-web-openai`) with a two-step toggle on the landing page; README updated.
- `scripts/tune-vapi.mjs` applies the Vapi turn-taking + no-narration settings without touching tools.

## What's left
1. Fill the latency table in `AGENT_SWITCHER_SPEC.md` §4 from the `latency` summary events (median reply gap per agent) once a few calls have been made on each.
2. If gpt-live-1 still narrates ahead of visuals: make show_/present tools return a 3-word confirmation on the live path so the voice model has nothing to say until asked.
3. Decide the long-term default armed agent from measurements (fresh deployments default to gpt-live-1 via `OPENAI_SIP_AGENT`).

## Hard-won learnings
- **Realtime SIP:** call WS is `wss://api.openai.com/v1/realtime?call_id=…` with only `Authorization: Bearer` (an `OpenAI-Beta` header 404s). `session.update` needs `session.type:"realtime"`, `turn_detection` under `audio.input`, `voice` under `audio.output`; otherwise it fails silently and tools never register. The call event stream is the best diagnostic.
- **GPT-Live is a different API**, not a model swap: separate webhook, accept, attach socket, and a delegation architecture (voice layer + backend model). No VAD knobs; full duplex is native. Keep Realtime fields out of the live session. gpt-live-1 shipped in the API on 2026-09-10 ($0.05/min voice + backend tokens).
- **Telnyx:** number → TeXML app whose voice webhook returns `<Dial><Sip>sip:proj_…@sip.api.openai.com;transport=tls</Sip></Dial>`; the app needs an outbound voice profile.
- **Vapi:** allowlisted models only; strict tool JSON schemas. Kept as the comparison path.
- **Local dev quirk:** Express `sendFile` refuses paths containing dot-segments, so running the server from inside `.claude/worktrees/...` 404s the dashboard. Test from a copy outside a dot directory (or merge first).
