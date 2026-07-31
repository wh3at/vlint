import type { JsonObject } from "./types-only";

type RuleContext = { settings: JsonObject };

export default {
  contractVersion: 1,
  metadata: { name: "type-only" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async (_context: RuleContext) => ({ elementsInspected: 0, violations: [] }),
};
