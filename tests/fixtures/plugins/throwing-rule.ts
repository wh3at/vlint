throw new Error("plugin top-level throw");

export default {
  contractVersion: 1,
  metadata: { name: "throwing" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({ elementsInspected: 0, violations: [] }),
};
