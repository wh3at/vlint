export default {
  contractVersion: 1,
  metadata: { name: "require-rule" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => {
    require("./helper");
    return { elementsInspected: 0, violations: [] };
  },
};
