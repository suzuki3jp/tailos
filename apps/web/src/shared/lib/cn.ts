import { createCn } from "cn/config";

// These are font sizes, not text colors. Preserve semantic colors when merging.
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "display",
            "page-title",
            "section-title",
            "body",
            "caption",
            "control",
            "control-xs",
          ],
        },
      ],
    },
  },
});
