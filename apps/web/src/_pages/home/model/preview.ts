// Presentation fixtures only. These IDs never identify persisted Sessions or Runs.
export const homePreview = {
  username: "suzuki3jp",
  projects: [{ id: "preview-tailos", name: "suzuki3jp/tailos" }],
  sessions: [
    {
      id: "preview-features",
      title: "Implement awesome features!",
      issueNumber: 27,
      updatedLabel: "Updated 3 minutes ago",
      state: "running",
      unread: true,
    },
    {
      id: "preview-bugs",
      title: "Fix some bugs",
      issueNumber: 31,
      updatedLabel: "Updated 4 hours ago",
      state: "done",
      unread: true,
    },
    {
      id: "preview-plan",
      title: "Planning an epic feature....",
      issueNumber: 24,
      updatedLabel: "Updated 3 days ago",
      state: "done",
      unread: false,
    },
  ],
} as const;

export type PreviewSession = (typeof homePreview.sessions)[number];
