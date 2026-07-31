export default {
  contractVersion: 1,
  metadata: {
    name: "spacing-check",
    description: "valid local rule fixture",
  },
  settingsSchema: {
    type: "object",
    properties: {
      tolerance: { type: "integer", minimum: 0, maximum: 100 },
    },
    required: ["tolerance"],
    exactKeys: ["tolerance"],
  },
  evaluate: async (context: { settings: { tolerance: number } }) => ({
    elementsInspected: 1,
    violations: context.settings.tolerance > 0 ? [] : [{ message: "bad", locator: "#x", geometry: { x: 0, y: 0, width: 1, height: 1 }, details: {} }],
  }),
  finalize: async () => ({ status: "passed" as const }),
};
