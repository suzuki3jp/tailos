import { Fragment } from "react";
import { agentEngineLabels } from "@tailos/core/models";
import type { TimelineSnapshot } from "@tailos/core/timeline";
import type { ProjectSession } from "../api/queries";
import { runEngine } from "../model/agent-engine";
import { MessageJobContext } from "./message-job-context";
import { MessageMarkdown } from "./message-markdown";
import { RunActivity } from "./run-activity";

const authorLabels = {
  agent: "Agent",
  automation: "GitHub",
  user: "You",
} satisfies Record<ProjectSession["messages"][number]["authorKind"], string>;

export function SessionConversation({
  detail,
  timeline,
  projectId,
}: {
  detail: ProjectSession;
  timeline?: TimelineSnapshot;
  projectId?: string;
}) {
  const byReply = new Map(detail.runs.map((run) => [run.id, run]));
  const replied = new Set(
    detail.messages
      .filter((message) => message.authorKind === "agent")
      .map((message) => message.runId),
  );
  const byStart = new Map(
    detail.runs
      .filter((run) => !replied.has(run.id))
      .map((run) => [run.startMessageId, run]),
  );

  return (
    <section
      aria-label="Conversation"
      className="mx-auto w-full max-w-172 px-3"
    >
      <h1 className="sr-only">{detail.session.title}</h1>
      {detail.messages.length === 0 && (
        <p className="px-4.5 py-6 text-muted-foreground">No messages yet.</p>
      )}
      <ol>
        {detail.messages.map((message) => {
          const agent = message.authorKind === "agent";
          const replyRun =
            agent && message.runId ? byReply.get(message.runId) : undefined;
          const pendingRun = byStart.get(message.id);
          return (
            <Fragment key={message.id}>
              <li className={agent ? "py-6" : "flex justify-end py-6"}>
                <div
                  className={
                    agent
                      ? "space-y-3 p-4.5"
                      : "min-w-0 max-w-[90%] rounded-[18px] bg-message p-4.5"
                  }
                >
                  <span className="sr-only">
                    {(() => {
                      // A reply is named after the Model Provider of its Run.
                      const engine = runEngine(replyRun?.engine);
                      return engine
                        ? agentEngineLabels[engine]
                        : authorLabels[message.authorKind];
                    })()}
                  </span>
                  {replyRun && (
                    <RunActivity
                      run={replyRun}
                      items={timeline?.items.filter(
                        (item) => item.runId === replyRun.id,
                      )}
                      capture={timeline?.captures.find(
                        (capture) => capture.runId === replyRun.id,
                      )}
                      sessionId={detail.session.id}
                      projectId={projectId}
                    />
                  )}
                  <MessageMarkdown body={message.body} bubble={!agent} />
                  <MessageJobContext context={message.jobContext} />
                </div>
              </li>
              {pendingRun && (
                <li className="px-4.5 py-6">
                  <RunActivity
                    run={pendingRun}
                    items={timeline?.items.filter(
                      (item) => item.runId === pendingRun.id,
                    )}
                    capture={timeline?.captures.find(
                      (capture) => capture.runId === pendingRun.id,
                    )}
                    sessionId={detail.session.id}
                    projectId={projectId}
                  />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </section>
  );
}
