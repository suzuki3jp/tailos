import { issueGuidanceStore } from "@/infrastructure/d1/issue-guidance.ts";
import type { Bindings } from "@/bindings.ts";
import { sendIssueNotifications } from "@/application/notifications/issue-comment.ts";
import { issueNotificationStore } from "@/infrastructure/d1/issue-notifications.ts";
import { GitHubApp } from "@/infrastructure/github/app.ts";

export async function deliverIssueNotifications(env: Bindings) {
  if (
    !env.TAILOS_WEB_ORIGIN ||
    !env.TAILOS_GH_APP_ID ||
    !env.TAILOS_GH_APP_PRIVATE_KEY
  )
    return;
  const github = new GitHubApp({
    appId: env.TAILOS_GH_APP_ID,
    privateKey: env.TAILOS_GH_APP_PRIVATE_KEY,
  });
  for (const store of [
    issueNotificationStore(env.DB),
    issueGuidanceStore(env.DB),
  ])
    await sendIssueNotifications(
      store,
      env.TAILOS_WEB_ORIGIN,
      (target, marker, body, id) =>
        github.issueComment(target, marker, body, id),
    );
}
