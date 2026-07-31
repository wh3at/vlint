export default {
  contractVersion: 1,
  metadata: { name: "finalize-failing" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({ elementsInspected: 1, violations: [] }),
  finalize: async () => ({ status: "failed" as const, message: "aggregate contract failed" }),
};
