export default {
  contractVersion: 1,
  metadata: { name: "finalize-malformed" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({ elementsInspected: 1, violations: [] }),
  finalize: async () => ({ status: "maybe" }),
};
