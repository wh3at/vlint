export default {
  contractVersion: 1,
  metadata: { name: "dynamic-import" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => {
    await import("./helper");
    return { elementsInspected: 0, violations: [] };
  },
};
