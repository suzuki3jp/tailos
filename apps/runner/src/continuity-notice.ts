import type { Conversation } from "@/agent.ts";

/** Tells the Agent that it starts over, so it can tell the user. */
export const lostWorkNotice =
  "Note: the work tree and conversation from this Session's previous turn could not be restored. You are starting from the repository's base commit without the earlier changes or conversation. Mention this to the user in your reply.\n\n";
/** The work tree is back but the conversation is not: say exactly that. */
export const lostConversationNotice =
  "Note: the conversation from this Session's previous turn could not be restored, but the work tree is as the previous turn left it, including its changes. Review the current changes before continuing, and mention to the user that the earlier conversation is unavailable.\n\n";

/** Tells the Agent that its work moved onto the latest default branch. */
function realignNotice(realigned: NonNullable<Conversation["realigned"]>) {
  const merged =
    "Note: this Session's pull request has been merged. The work tree now starts from the latest default branch, and the next publication opens a new pull request. ";
  return realigned.kept
    ? merged +
        `Work that had not been published yet conflicts with the default branch, so it was not re-applied: it is kept at ${realigned.kept}, and stays there in later turns. See it with \`git diff ${realigned.kept}^ ${realigned.kept}\`, carry over what the user still wants, and delete it with \`git update-ref -d ${realigned.kept}\` once it is carried over or no longer wanted. ` +
        (realigned.keptEarlier
          ? `Work kept the same way after an earlier merge was not deleted, and is still at ${realigned.keptEarlier}: see it with \`git diff ${realigned.keptEarlier}^ ${realigned.keptEarlier}\` and carry it over too before deleting the reference. `
          : "") +
        "Mention this to the user.\n\n"
    : merged +
        "Work that had not been published yet, if any, was re-applied on top as uncommitted changes. Mention this to the user.\n\n";
}

/** What the Agent must know about the previous Turn before it starts. */
export function continuityNotice(
  lostWork: boolean,
  lostConversation: boolean,
  realigned?: Conversation["realigned"],
) {
  if (lostWork) return lostWorkNotice;
  return (
    (lostConversation ? lostConversationNotice : "") +
    (realigned ? realignNotice(realigned) : "")
  );
}
