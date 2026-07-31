export default {
  contractVersion: 1,
  metadata: { name: "finalize-noop" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({ elementsInspected: 1, violations: [] }),
};
