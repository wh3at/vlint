import { helper } from "./helper";

export default {
  contractVersion: 1,
  metadata: { name: "imported" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => helper(),
};
