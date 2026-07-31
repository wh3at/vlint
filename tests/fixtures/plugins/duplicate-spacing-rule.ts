export default {
  contractVersion: 1,
  metadata: {
    name: "duplicate-horizontal-spacing",
    description: "detect duplicate horizontal padding between shell and content",
  },
  settingsSchema: {
    type: "object",
    properties: {
      shellSelector: { type: "string" },
      contentSelector: { type: "string" },
    },
    required: ["shellSelector", "contentSelector"],
    exactKeys: ["shellSelector", "contentSelector"],
  },
  evaluate: async (context: {
    settings: { shellSelector: string; contentSelector: string };
  }) => {
    const shell = document.querySelector(context.settings.shellSelector);
    const content = document.querySelector(context.settings.contentSelector);
    if (shell === null || content === null) {
      return { elementsInspected: 0, violations: [] };
    }
    const shellStyle = getComputedStyle(shell);
    const contentStyle = getComputedStyle(content);
    const shellHorizontal =
      Number.parseFloat(shellStyle.paddingLeft) + Number.parseFloat(shellStyle.paddingRight);
    const contentHorizontal =
      Number.parseFloat(contentStyle.paddingLeft) + Number.parseFloat(contentStyle.paddingRight);
    if (shellHorizontal <= 0 || contentHorizontal <= 0) {
      return { elementsInspected: 2, violations: [] };
    }
    const rect = content.getBoundingClientRect();
    return {
      elementsInspected: 2,
      violations: [
        {
          message: "duplicate horizontal spacing in content region",
          locator: context.settings.contentSelector,
          geometry: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
          details: {
            shellPaddingPx: shellHorizontal,
            contentPaddingPx: contentHorizontal,
          },
        },
      ],
    };
  },
};
