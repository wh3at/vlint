export default {
  contractVersion: 1,
  metadata: { name: "eval-cyclic-return" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => {
    const details: { self?: unknown } = {};
    details.self = details;
    return {
      elementsInspected: 0,
      violations: [
        {
          message: "cyclic details",
          locator: "body",
          geometry: { x: 0, y: 0, width: 1, height: 1 },
          details,
        },
      ],
    };
  },
};
