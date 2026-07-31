export default {
  contractVersion: 1,
  metadata: { name: "finalize-throwing" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({ elementsInspected: 1, violations: [] }),
  finalize: async () => {
    throw new Error("finalizer exploded");
  },
};
