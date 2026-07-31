export default {
  contractVersion: 1,
  metadata: { name: "eval-never-resolves" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => new Promise(() => undefined),
};
