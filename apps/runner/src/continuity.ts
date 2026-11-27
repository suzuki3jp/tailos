import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { maxContinuityBytes } from "@tailos/core/runner";
import * as v from "valibot";

const compress = promisify(gzip);
const decompress = promisify(gunzip);

/**
 * The Agent's conversation in a Session: Codex's thread and its rollout file,
 * or Claude Code's session and its transcript.
 */
export type SavedConversation = {
  /** Codex's thread ID, or Claude Code's session ID. */
  threadId: string;
  /**
   * Relative to `CODEX_HOME` or `CLAUDE_CONFIG_DIR`, where the Agent finds it
   * again by its ID.
   */
  path: string;
  content: Buffer;
};

/**
 * What a Turn leaves for the next one. The work commit holds the whole work
 * tree on top of HEAD, so the bundle from the base carries the Agent's
 * commits, its local branches, and its uncommitted and untracked files.
 */
export type SavedWork = {
  baseSha: string;
  head: string;
  work: string;
  /** The local branch HEAD is on; none when it is detached. */
  branch?: string;
  /**
   * Where each kept reference was: local and remote-tracking branches, and
   * older kept work.
   */
  refs: { name: string; sha: string }[];
  /**
   * The work tree's git configuration as the Agent left it. Data only: the
   * Runner's own git commands never read it.
   */
  gitConfig?: Buffer;
  bundle: Buffer;
  conversation?: SavedConversation;
};

const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const size = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** Codex writes rollouts here; nothing else may be restored into its home. */
export const rolloutPath = v.pipe(
  v.string(),
  v.regex(/^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[\w.:-]+\.jsonl$/),
);
/**
 * Claude Code writes a session's transcript here, under a directory named
 * after the work tree; nothing else may be restored into its configuration.
 */
export const claudeTranscriptPath = v.pipe(
  v.string(),
  v.regex(
    /^projects\/[A-Za-z0-9_-]{1,255}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/,
  ),
);
const conversationPath = v.union([rolloutPath, claudeTranscriptPath]);
/** Unpublished work kept aside after a merge, before Sessions kept branches. */
export const keptRef = "refs/tailos/unpublished";
const refName = v.pipe(
  v.string(),
  v.maxLength(1024),
  v.check(
    (name) =>
      name === keptRef || /^refs\/(?:heads|remotes)\/[^\0\n]+$/.test(name),
  ),
);
/** The most references one Turn may leave for the next. */
export const maxSavedRefs = 1000;
const maxGitConfigBytes = 64 * 1024;
const conversationHeader = v.optional(
  v.strictObject({
    threadId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    path: conversationPath,
    bytes: size,
  }),
);
const Header = v.variant("version", [
  // Before Sessions kept branches: HEAD, and work kept after a merge.
  v.strictObject({
    version: v.literal(1),
    baseSha: sha,
    head: sha,
    work: sha,
    config: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
    bundle: size,
    kept: v.optional(sha),
    conversation: conversationHeader,
  }),
  v.strictObject({
    version: v.literal(2),
    baseSha: sha,
    head: sha,
    work: sha,
    branch: v.optional(
      v.pipe(v.string(), v.maxLength(1024), v.regex(/^refs\/heads\/[^\0\n]+$/)),
    ),
    refs: v.pipe(
      v.array(v.strictObject({ name: refName, sha })),
      v.maxLength(maxSavedRefs),
    ),
    gitConfig: v.optional(v.pipe(size, v.maxValue(maxGitConfigBytes))),
    bundle: size,
    conversation: conversationHeader,
  }),
]);

export class ContinuityTooLarge extends Error {}

/** Packs saved work into one compressed archive of at most the size limit. */
export async function encodeSavedWork(saved: SavedWork) {
  if ((saved.gitConfig?.length ?? 0) > maxGitConfigBytes)
    throw new ContinuityTooLarge();
  const header: v.InferInput<typeof Header> = {
    version: 2,
    baseSha: saved.baseSha,
    head: saved.head,
    work: saved.work,
    ...(saved.branch && { branch: saved.branch }),
    refs: saved.refs,
    ...(saved.gitConfig && { gitConfig: saved.gitConfig.length }),
    bundle: saved.bundle.length,
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
      saved.gitConfig ?? Buffer.alloc(0),
      saved.bundle,
      saved.conversation?.content ?? Buffer.alloc(0),
    ]),
  );
  if (archive.length > maxContinuityBytes) throw new ContinuityTooLarge();
  return archive;
}

/** The references saved work keeps, in either version. */
function savedRefs(header: v.InferOutput<typeof Header>) {
  if (header.version === 2) return header.refs;
  return header.kept ? [{ name: keptRef, sha: header.kept }] : [];
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
  const configEnd =
    end + 1 + (header.version === 2 ? (header.gitConfig ?? 0) : 0);
  const bundleEnd = configEnd + header.bundle;
  const total = bundleEnd + (header.conversation?.bytes ?? 0);
  if (total !== data.length) throw new Error("Invalid saved work");
  const refs = savedRefs(header);
  return {
    baseSha: header.baseSha,
    head: header.head,
    work: header.work,
    ...(header.version === 2 && header.branch && { branch: header.branch }),
    refs,
    ...(header.version === 2 &&
      header.gitConfig !== undefined && {
        gitConfig: data.subarray(end + 1, configEnd),
      }),
    bundle: data.subarray(configEnd, bundleEnd),
    ...(header.conversation && {
      conversation: {
        threadId: header.conversation.threadId,
        path: header.conversation.path,
        content: data.subarray(bundleEnd, total),
      },
    }),
  };
}
