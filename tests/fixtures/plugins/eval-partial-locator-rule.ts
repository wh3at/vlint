export default {
  contractVersion: 1,
  metadata: { name: "eval-partial-locator" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({
    elementsInspected: 2,
    violations: [
      {
        message: "first valid",
        locator: "#content",
        geometry: { x: 10, y: 20, width: 100, height: 40 },
        details: { order: 1 },
      },
      {
        message: "second invalid locator",
        locator: "#missing",
        geometry: { x: 0, y: 0, width: 1, height: 1 },
        details: { order: 2 },
      },
    ],
  }),
};
