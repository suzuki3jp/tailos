/** Tells the Agent that it starts over, so it can tell the user. */
export const lostWorkNotice =
  "Note: the work tree and conversation from this Session's previous turn could not be restored. You are starting from the repository's base commit without the earlier local changes, branches or conversation; branches already pushed to GitHub are still there. Mention this to the user in your reply.\n\n";
/** The work tree is back but the conversation is not: say exactly that. */
export const lostConversationNotice =
  "Note: the conversation from this Session's previous turn could not be restored, but the work tree is as the previous turn left it, including its changes. Review the current changes before continuing, and mention to the user that the earlier conversation is unavailable.\n\n";

/** What the Agent must know about the previous Turn before it starts. */
export function continuityNotice(lostWork: boolean, lostConversation: boolean) {
  if (lostWork) return lostWorkNotice;
  return lostConversation ? lostConversationNotice : "";
}
