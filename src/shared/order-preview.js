// What the agent is told after preview_order. Coinbase has no API order preview
// for stocks yet, so stock previews are our own estimate at the live price;
// confirming still places the real Coinbase order.

export const PREVIEW_INSTRUCTION = "Read back the exact preview and ask for confirmation. Stop this turn without executing.";

export const ESTIMATED_PREVIEW_INSTRUCTION = "Coinbase has no order preview for stocks yet, so this preview is our own estimate at the live market price (the actual fill may differ slightly). Say it is an estimate, read back the side, shares or dollars, approximate price, and approximate total, and ask for confirmation. Stop this turn without executing. After a clear confirmation, execute_order places the real Coinbase order.";

export const previewInstruction = (payload) => (payload?.preview?.estimated ? ESTIMATED_PREVIEW_INSTRUCTION : PREVIEW_INSTRUCTION);
