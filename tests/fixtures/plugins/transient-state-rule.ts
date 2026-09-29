export default {
  contractVersion: 1,
  metadata: { name: "transient-state" },
  settingsSchema: {
    type: "object",
    properties: { mode: { type: "string" } },
    required: ["mode"],
    exactKeys: ["mode"],
  },
  evaluate: async (context: { settings: { mode: string } }) => {
    if (context.settings.mode === "url") {
      history.pushState({}, "", "/different?token=observed#fragment");
      await new Promise((resolve) => setTimeout(resolve, 20));
      history.replaceState({}, "", "/");
    } else {
      document.querySelector("#ready")?.remove();
      await new Promise((resolve) => setTimeout(resolve, 20));
      document.body.insertAdjacentHTML("beforeend", "<main id='ready'>restored</main>");
    }
    return { elementsInspected: 1, violations: [] };
  },
};
