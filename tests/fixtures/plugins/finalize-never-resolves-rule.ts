export default {
  contractVersion: 1,
  metadata: { name: "finalize-never-resolves" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({ elementsInspected: 1, violations: [] }),
  finalize: async () => new Promise(() => {}),
};
