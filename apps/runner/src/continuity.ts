import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { maxContinuityBytes } from "@tailos/core/runner";
import * as v from "valibot";

const compress = promisify(gzip);
const decompress = promisify(gunzip);

/** The Codex conversation of a Session: its thread and the rollout file. */
export type SavedConversation = {
  threadId: string;
  /** Relative to `CODEX_HOME`, where Codex finds it again by thread ID. */
  path: string;
  content: Buffer;
};

/**
 * What a Turn leaves for the next one. The work commit holds the whole work
 * tree on top of HEAD, so the bundle from the base carries the Agent's commits
 * and its uncommitted and untracked files.
 */
export type SavedWork = {
  baseSha: string;
  head: string;
  work: string;
  /**
   * SHA-256 of the git configuration the Turn trusted. Kept with the Session,
   * so that a work tree found in place is used only if nobody changed it.
   */
  config?: string;
  bundle: Buffer;
  conversation?: SavedConversation;
  /**
   * Unpublished work kept aside after a merge, which the bundle also
   * carries until the Agent deletes it.
   */
  kept?: string;
};

const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const size = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** Codex writes rollouts here; nothing else may be restored into its home. */
export const rolloutPath = v.pipe(
  v.string(),
  v.regex(/^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[\w.:-]+\.jsonl$/),
);
const Header = v.strictObject({
  version: v.literal(1),
  baseSha: sha,
  head: sha,
  work: sha,
  config: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
  bundle: size,
  kept: v.optional(sha),
  conversation: v.optional(
    v.strictObject({
      threadId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      path: rolloutPath,
      bytes: size,
    }),
  ),
});

export class ContinuityTooLarge extends Error {}

/** Packs saved work into one compressed archive of at most the size limit. */
export async function encodeSavedWork(saved: SavedWork) {
  const header: v.InferInput<typeof Header> = {
    version: 1,
    baseSha: saved.baseSha,
    head: saved.head,
    work: saved.work,
    ...(saved.config && { config: saved.config }),
    bundle: saved.bundle.length,
    ...(saved.kept && { kept: saved.kept }),
    ...(saved.conversation && {
      conversation: {
        threadId: saved.conversation.threadId,
        path: saved.conversation.path,
        bytes: saved.conversation.content.length,
      },
    }),
  };
  const archive = await compress(
    Buffer.concat([
      Buffer.from(JSON.stringify(v.parse(Header, header)) + "\n"),
      saved.bundle,
      saved.conversation?.content ?? Buffer.alloc(0),
    ]),
  );
  if (archive.length > maxContinuityBytes) throw new ContinuityTooLarge();
  return archive;
}

/** Reads an archive written by `encodeSavedWork`, rejecting anything else. */
export async function decodeSavedWork(archive: Buffer): Promise<SavedWork> {
  if (archive.length > maxContinuityBytes) throw new ContinuityTooLarge();
  const data = await decompress(archive, {
    maxOutputLength: 4 * maxContinuityBytes,
  });
  const end = data.indexOf(0x0a);
  if (end < 0) throw new Error("Invalid saved work");
  const header = v.parse(
    Header,
    JSON.parse(data.subarray(0, end).toString("utf8")),
  );
  const bundleEnd = end + 1 + header.bundle;
  const total = bundleEnd + (header.conversation?.bytes ?? 0);
  if (total !== data.length) throw new Error("Invalid saved work");
  return {
    baseSha: header.baseSha,
    head: header.head,
    work: header.work,
    ...(header.config && { config: header.config }),
    bundle: data.subarray(end + 1, bundleEnd),
    ...(header.kept && { kept: header.kept }),
    ...(header.conversation && {
      conversation: {
        threadId: header.conversation.threadId,
        path: header.conversation.path,
        content: data.subarray(bundleEnd, total),
      },
    }),
  };
}
