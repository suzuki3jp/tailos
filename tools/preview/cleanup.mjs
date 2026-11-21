import { cloudflare, previewsPath } from "./cloudflare.mjs";
import { previewName, workers } from "./config.mjs";

const workerNames = Object.values(workers);
const missingWorker = [10007, 10090];
const missingPreview = [...missingWorker, 10025];

async function all(operations) {
  const results = await Promise.allSettled(operations);
  const failures = results.filter(({ status }) => status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map(({ reason }) => reason),
      "Preview cleanup failed",
    );
  return results.map(({ value }) => value);
}

async function listPreviews(worker) {
  const names = new Set();
  for (let page = 1; ; page++) {
    const body = await cloudflare(
      `${previewsPath(worker)}?page=${page}&per_page=100&order_by=name&order=asc`,
      { missing: missingWorker },
    );
    if (!body) return names;
    if (
      !Array.isArray(body.result) ||
      body.result.some(({ name }) => typeof name !== "string")
    )
      throw new Error(`Invalid Preview list for ${worker}`);
    for (const { name } of body.result) {
      if (names.has(name))
        throw new Error(`Preview list changed during pagination for ${worker}`);
      names.add(name);
    }
    if (!body.result.length || page >= body.result_info?.total_pages)
      return names;
  }
}

async function pullRequestState(number) {
  const response = await fetch(
    `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/pulls/${number}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`Could not verify PR #${number} (HTTP ${response.status})`);
  const pr = await response.json();
  if (pr.number !== Number(number) || !["open", "closed"].includes(pr.state))
    throw new Error(`Invalid state for PR #${number}`);
  return pr.state;
}

async function cleanup(name, targets) {
  if ((await pullRequestState(name.slice(3))) !== "closed") return;
  await all(
    targets.map(async (worker) => {
      const result = await cloudflare(`${previewsPath(worker)}/${name}`, {
        method: "DELETE",
        missing: missingPreview,
      });
      if (result) process.stdout.write(`Deleted ${worker}/${name}\n`);
    }),
  );
}

export async function reconcile() {
  const lists = await all(workerNames.map(listPreviews));
  const names = new Set(lists.flatMap((list) => [...list]));
  const failures = [];
  for (const name of names) {
    if (!/^pr-[1-9]\d*$/.test(name)) continue;
    try {
      await cleanup(
        name,
        workerNames.filter((_, index) => lists[index].has(name)),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Preview reconciliation failed");
}

if (import.meta.main) {
  const [number] = process.argv.slice(2);
  if (number === undefined) await reconcile();
  else await cleanup(previewName(number), workerNames);
}
