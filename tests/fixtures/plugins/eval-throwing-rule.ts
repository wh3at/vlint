export default {
  contractVersion: 1,
  metadata: { name: "eval-throwing" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => {
    throw new Error("evaluator blew up");
  },
};
