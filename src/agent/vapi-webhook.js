// Single Vapi server webhook. Vapi POSTs every call event here as { message: {...} }.
// We branch on message.type:
//   assistant-request   -> caller allowlist; return { assistantId } or { error }
//   tool-calls          -> run the shared registry; return { results: [...] }
//   transcript / status-update / speech-update / conversation-update / hang -> event bus
//   end-of-call-report  -> event bus + persistence
//
// Auth: Vapi sends the configured server.secret as the `x-vapi-secret` header.

import { timingSafeEqual } from "node:crypto";

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function headerValue(request, name) {
  if (typeof request.get === "function") return request.get(name);
  return request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
}

// Vapi has used a few tool-call shapes across versions; normalize them.
export function normalizeToolCalls(message) {
  const list = message?.toolCallList || message?.toolCalls || [];
  return list.map((entry) => {
    const fn = entry.function || entry;
    let args = fn.arguments ?? fn.parameters ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return { id: entry.id || entry.toolCallId || fn.id, name: fn.name, args: args ?? {} };
  });
}

function callerNumber(message) {
  return message?.call?.customer?.number
    ?? message?.customer?.number
    ?? message?.call?.customer?.sipUri
    ?? null;
}

/**
 * @param {object} opts
 * @param {{ execute:Function }} opts.registry     Shared tool registry (M1).
 * @param {string} opts.secret                     Expected x-vapi-secret.
 * @param {string[]} [opts.allowedCallers]         Inbound caller allowlist (empty = allow all).
 * @param {string} opts.assistantId                Stored assistant id to return on assistant-request.
 * @param {(event:object)=>void} [opts.emit]       Dashboard event bus (M4).
 * @param {(report:object)=>Promise<void>|void} [opts.onCallEnd]  Persistence (M6).
 * @returns {(req, res)=>Promise<void>}
 */
export function createVapiWebhook({ registry, secret, allowedCallers = [], assistantId, emit = () => {}, onCallEnd } = {}) {
  if (!registry?.execute) throw new Error("createVapiWebhook requires a registry with execute().");

  return async function vapiWebhook(request, response) {
    // Auth.
    if (secret) {
      const provided = headerValue(request, "x-vapi-secret");
      if (!safeEqual(provided, secret)) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
    }

    const message = request.body?.message ?? request.body ?? {};
    const type = message.type;
    const callId = message.call?.id ?? message.callId ?? null;
    // Tool-originated events (artifacts/reports/previews) don't know the callId;
    // stamp it so they persist and associate with the active call.
    const ctx = { callId, channel: "phone", emit: (event) => emit({ callId, ...event }) };

    try {
      switch (type) {
        case "assistant-request": {
          const caller = callerNumber(message);
          if (allowedCallers.length && !allowedCallers.includes(caller)) {
            emit({ kind: "call", type: "rejected", callId, caller, at: Date.now() });
            response.json({ error: "Sorry, this line isn't available right now." });
            return;
          }
          emit({ kind: "call", type: "incoming", callId, caller, at: Date.now() });
          response.json({ assistantId });
          return;
        }

        case "tool-calls": {
          const results = [];
          for (const toolCall of normalizeToolCalls(message)) {
            emit({ kind: "tool", type: "start", callId, name: toolCall.name, at: Date.now() });
            try {
              const output = await registry.execute(toolCall.name, toolCall.args, ctx);
              const result = typeof output === "string" ? output : JSON.stringify(output);
              results.push({ toolCallId: toolCall.id, result });
              emit({ kind: "tool", type: "done", callId, name: toolCall.name, at: Date.now() });
            } catch (error) {
              results.push({ toolCallId: toolCall.id, result: `Error: ${error.message}` });
              emit({ kind: "tool", type: "error", callId, name: toolCall.name, error: error.message, at: Date.now() });
            }
          }
          response.json({ results });
          return;
        }

        case "transcript": {
          emit({
            kind: "transcript",
            callId,
            role: message.role ?? null,
            transcriptType: message.transcriptType ?? null,
            text: message.transcript ?? "",
            at: Date.now(),
          });
          response.json({});
          return;
        }

        case "status-update":
        case "speech-update":
        case "conversation-update":
        case "hang": {
          emit({ kind: type, callId, status: message.status ?? null, at: Date.now(), message });
          response.json({});
          return;
        }

        case "end-of-call-report": {
          emit({ kind: "end-of-call-report", callId, endedReason: message.endedReason ?? null, at: Date.now() });
          if (onCallEnd) await onCallEnd(message);
          response.json({});
          return;
        }

        default: {
          response.json({});
          return;
        }
      }
    } catch (error) {
      emit({ kind: "error", callId, error: error.message, at: Date.now() });
      response.status(500).json({ error: error.message });
    }
  };
}
