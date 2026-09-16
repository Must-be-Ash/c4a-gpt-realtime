// Tool execution for pitch calls, shared by the Vapi webhook and the
// gpt-realtime-2.1 (OpenAI SIP) path so both enforce the same rules:
// only pitch tools, orders only with a pitched trade (and its server-side
// guard), and a successful execute marks the pitch bought.

export async function executePitchTool({ name, args, ctx, registry, runners, toolNames, store }) {
  if (!toolNames.includes(name)) throw new Error(`${name} isn't available on the pitch line.`);
  if (runners[name]) return runners[name](args, ctx);
  if (["preview_order", "execute_order"].includes(name) && !ctx.pitchGuard) {
    throw new Error("No pitched trade on this call, so no orders here. Use the main agent line.");
  }
  const output = await registry.execute(name, args, ctx);
  if (ctx.pitch && name === "execute_order") {
    let orderId = null;
    try {
      const parsed = JSON.parse(output);
      orderId = parsed?.result?.order_id ?? parsed?.result?.success_response?.order_id ?? null;
    } catch { /* keep null */ }
    await store.update(ctx.pitch.id, { orderId, status: "bought", outcome: "bought", decidedAt: new Date().toISOString() });
  }
  return output;
}

// Call context for a pitch: the pitch record and the order guard derived from it.
export const pitchCallContext = (pitch, maxOrderUsd) => ({
  pitchCall: true,
  pitch,
  pitchGuard: pitch?.productId ? { maxUsd: maxOrderUsd, productId: pitch.productId } : null,
});
