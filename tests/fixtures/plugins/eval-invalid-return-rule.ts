export default {
  contractVersion: 1,
  metadata: { name: "eval-invalid-return" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({ elementsInspected: -1, violations: [] }),
};
