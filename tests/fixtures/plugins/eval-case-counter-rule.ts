let caseCounter = 0;

export default {
  contractVersion: 1,
  metadata: { name: "eval-case-counter" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => {
    caseCounter += 1;
    return { elementsInspected: caseCounter, violations: [] };
  },
};
