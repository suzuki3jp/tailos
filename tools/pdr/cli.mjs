import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  card,
  catalog,
  changedPaths,
  readRecords,
  resolveKey,
  search,
  show,
} from "./lib.mjs";

const help = `PDR: Markdown is authoritative; SQLite is a disposable local cache.
  pnpm pdr search "query" [--path relative/file] [--limit 5] [--offset 0] [--history]
  pnpm pdr show PDR-ID [--section decision,rationale,scope] [--offset 0] [--lines 80]
  pnpm pdr resolve decision.key
  pnpm pdr history decision.key [--limit 5] [--offset 0]
  pnpm pdr context --diff main...HEAD [--query "intent"] [--path planned/file]
  pnpm pdr catalog
  pnpm pdr check
All commands except catalog emit JSON. --root overrides the repository root.
Search excerpts are previews, not complete policies. Read scope/exceptions before applying a decision.`;

function number(value, fallback, minimum = 1) {
  if (value === undefined) return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < minimum
  )
    throw new Error(`Invalid numeric option: ${value}`);
  return Number(value);
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      path: { type: "string", multiple: true },
      query: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      lines: { type: "string" },
      chars: { type: "string" },
      section: { type: "string" },
      diff: { type: "string" },
      history: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    process.stdout.write(help + "\n");
  } else {
    const root = resolve(
      values.root ?? fileURLToPath(new URL("../../", import.meta.url)),
    );
    const records = readRecords(root);
    const options = {
      limit: number(values.limit, 5),
      offset: number(values.offset, 0, 0),
      chars: number(values.chars, 200),
      paths: values.path ?? [],
      history: !!values.history,
    };
    let result;
    switch (command) {
      case "search":
        result = search(root, records, {
          ...options,
          query: values.query ?? args.join(" "),
        });
        break;
      case "context":
        result = search(root, records, {
          ...options,
          query: values.query ?? args.join(" "),
          paths: [...options.paths, ...changedPaths(root, values.diff)],
        });
        break;
      case "show":
        result = show(records, args[0], {
          offset: options.offset,
          lines: number(values.lines, 80),
          sections: values.section?.split(",") ?? [],
        });
        break;
      case "resolve": {
        if (!args[0]) throw new Error("resolve requires a decision key");
        result = resolveKey(records, args[0], options);
        break;
      }
      case "history": {
        if (!args[0]) throw new Error("history requires a decision key");
        const matches = records
          .filter((r) => r.key === args[0])
          .sort(
            (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
          );
        result = {
          key: args[0],
          total: matches.length,
          next_offset:
            options.offset + options.limit < matches.length
              ? options.offset + options.limit
              : null,
          records: matches
            .slice(options.offset, options.offset + options.limit)
            .map((r) => ({
              ...card(r, options.chars),
              supersedes: r.supersedes,
            })),
        };
        break;
      }
      case "catalog":
        process.stdout.write(catalog(records));
        break;
      case "check": {
        result = {
          ok: true,
          records: records.length,
          unverified_total: records.filter((r) => r.status === "unverified")
            .length,
          unverified: records
            .filter((r) => r.status === "unverified")
            .slice(0, options.limit)
            .map((r) => r.id),
          note: "Record structure and optional links are checked; decision rationale and human agreement require review.",
        };
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}\n${help}`);
    }
    if (result) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "PDR command failed"}\n`,
  );
  process.exitCode = 1;
}
