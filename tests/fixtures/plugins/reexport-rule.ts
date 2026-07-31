export { helper } from "./helper";

export default {
  contractVersion: 1,
  metadata: { name: "reexport" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({ elementsInspected: 0, violations: [] }),
};
