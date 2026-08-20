export const x402RouterParameters = {
  type: "object",
  properties: {
    toolName: {
      type: "string",
      description: "Exact tool name from the live paid-API catalog",
    },
    arguments: {
      type: "object",
      description: "Arguments matching that tool's input schema",
      additionalProperties: true,
    },
    intent: {
      type: "string",
      description: "Tool-specific description of the records/data needed and useful filters, not conversational wording; used to find an alternative provider if this call fails or returns no records",
    },
  },
  required: ["toolName", "arguments", "intent"],
  additionalProperties: false,
};
