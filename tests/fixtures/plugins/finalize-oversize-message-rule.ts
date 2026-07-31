export default {
  contractVersion: 1,
  metadata: { name: "finalize-oversize-message" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({ elementsInspected: 1, violations: [] }),
  finalize: async () => ({ status: "failed" as const, message: "x".repeat(70_000) }),
};
