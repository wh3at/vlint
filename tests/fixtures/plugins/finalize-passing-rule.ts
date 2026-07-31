export default {
  contractVersion: 1,
  metadata: { name: "finalize-passing" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => ({ elementsInspected: 1, violations: [] }),
  finalize: async (observations: {
    cases: readonly { target: { name: string }; device: { name: string }; status: string }[];
  }) => {
    if (observations.cases.length === 0) throw new Error("missing observations");
    return { status: "passed" as const };
  },
};
