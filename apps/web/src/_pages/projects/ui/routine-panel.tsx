"use client";
import { RequestState } from "@/widgets/request-state";
import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { codexModels, type AgentModel } from "@tailos/core/models";
import {
  RoutineRequestError,
  routinesQueryOptions,
  routinesKey,
  routineHistoryKey,
  routineHistoryQueryOptions,
  saveRoutine,
  deleteRoutine,
  type Routine,
  type RoutineSettings,
} from "../api/routines";

function availableEfforts(models: readonly AgentModel[], model?: string) {
  const candidates = model
    ? models.filter((item) => item.model === model)
    : models;
  return [...new Set(candidates[0]?.efforts)].filter((effort) =>
    candidates.every((item) => item.efforts.includes(effort)),
  );
}

const field = "block w-full rounded-md border border-rule bg-paper px-3 py-2";
const implementationPrompt =
  "Implement the GitHub issue identified by the structured job context. Read the issue using tailos_github_get, make the required changes, run relevant checks, and summarize the result. Tailos handles publishing.";
const planningPrompt =
  "Plan the GitHub issue identified by the structured job context, answering the new message from a permitted user. Read the issue using tailos_github_get. Do not implement or publish changes. Post your reply on the issue as a comment with gh issue comment, without mentioning anyone with @, and give the same reply in your answer.";
const triggers = {
  "github.issue-label": {
    trigger: { version: 1, type: "github.issue-label", label: "tailos:run" },
    prompt: implementationPrompt,
  },
  "github.issue-comment": {
    trigger: { version: 1, type: "github.issue-comment", command: "plan" },
    prompt: planningPrompt,
  },
} as const satisfies Record<
  RoutineSettings["trigger"]["type"],
  Pick<RoutineSettings, "trigger" | "prompt">
>;
const empty: RoutineSettings = {
  name: "",
  enabled: false,
  allowedActors: [],
  engine: "codex",
  ...triggers["github.issue-label"],
};
function TriggerSummary({ trigger }: { trigger: RoutineSettings["trigger"] }) {
  return trigger.type === "github.issue-label" ? (
    <p>ラベル: {trigger.label}</p>
  ) : (
    <p>コメント: @tailos {trigger.command}（読み取り専用）</p>
  );
}
export function RoutinePanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <button
        className="action"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "Routine を閉じる" : "Routine を管理"}
      </button>
      {open && <RoutineEditor projectId={projectId} />}
    </div>
  );
}
function Snapshot({ settings }: { settings: RoutineSettings | null }) {
  if (!settings) return <p>設定なし</p>;
  return (
    <div className="space-y-1 break-words text-sm">
      <p>
        {settings.name} · {settings.enabled ? "有効" : "無効"}
      </p>
      <TriggerSummary trigger={settings.trigger} />
      <p>許可ユーザー: {settings.allowedActors.join(", ")}</p>
      <p>
        {settings.engine} · model: {settings.model ?? "既定"} · effort:{" "}
        {settings.effort ?? "既定"}
      </p>
      <p className="whitespace-pre-wrap">{settings.prompt}</p>
    </div>
  );
}
function RoutineEditor({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const list = useQuery(routinesQueryOptions(projectId));
  const [before, setBefore] = useState<number>();
  const history = useQuery(routineHistoryQueryOptions(projectId, before));
  const [editing, setEditing] = useState<Routine>();
  const [settings, setSettings] = useState<RoutineSettings>(empty);
  const [actors, setActors] = useState("");
  const models = codexModels;
  const modelIds = models.map(({ model }) => model);
  const efforts = availableEfforts(models, settings.model);
  const reset = () => {
    setEditing(undefined);
    setSettings(empty);
    setActors("");
  };
  const invalidate = async () => {
    setBefore(undefined);
    await Promise.all([
      client.invalidateQueries({ queryKey: routinesKey(projectId) }),
      client.invalidateQueries({ queryKey: routineHistoryKey(projectId) }),
    ]);
  };
  const save = useMutation({
    mutationFn: () =>
      saveRoutine(
        projectId,
        { ...settings, allowedActors: actors.split(/[,\s]+/).filter(Boolean) },
        editing,
      ),
    onSuccess: async () => {
      reset();
      await invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (item: Routine) => deleteRoutine(projectId, item),
    onSuccess: async (_, item) => {
      if (editing?.id === item.id) reset();
      await invalidate();
    },
  });
  const busy = save.isPending || remove.isPending;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) save.mutate();
  }
  function renderRoutineHistory() {
    if (history.isPending) return <p role="status">履歴を読み込んでいます。</p>;
    if (history.isError)
      return (
        <RequestState
          status={
            history.error instanceof RoutineRequestError
              ? history.error.status
              : undefined
          }
          missing="Routine の履歴を取得できません。"
          retry={() => void history.refetch()}
        />
      );
    return (
      <div className="space-y-3">
        {history.data.changes.map((change) => (
          <details className="rounded border border-rule p-3" key={change.id}>
            <summary>
              {new Date(change.createdAt).toLocaleString("ja-JP")} ·{" "}
              {change.after?.name ?? change.before?.name}
            </summary>
            <p className="text-xs text-muted-foreground">
              変更者 {change.actorId}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <h5>変更前</h5>
                <Snapshot settings={change.before} />
              </div>
              <div>
                <h5>変更後</h5>
                <Snapshot settings={change.after} />
              </div>
            </div>
          </details>
        ))}
        {before !== undefined && (
          <button
            className="action"
            type="button"
            onClick={() => setBefore(undefined)}
          >
            最新の履歴
          </button>
        )}
        {history.data.nextCursor !== null && (
          <button
            className="action"
            type="button"
            onClick={() => setBefore(history.data.nextCursor ?? undefined)}
          >
            以前の履歴
          </button>
        )}
      </div>
    );
  }
  function renderRoutines() {
    if (list.isPending)
      return <p role="status">Routine を読み込んでいます。</p>;
    if (list.isError)
      return (
        <RequestState
          status={
            list.error instanceof RoutineRequestError
              ? list.error.status
              : undefined
          }
          missing="Routine を利用できません。"
          retry={() => void list.refetch()}
        />
      );
    return (
      <ul className="space-y-3">
        {list.data.routines.map((item) => (
          <li className="rounded border border-rule p-3" key={item.id}>
            <Snapshot settings={item} />
            <div className="mt-2 flex gap-2">
              <button
                className="action"
                type="button"
                disabled={busy}
                onClick={() => {
                  const {
                    id: _id,
                    revision: _revision,
                    projectId: _projectId,
                    deletedAt: _deletedAt,
                    ...value
                  } = item;
                  setEditing(item);
                  setSettings(value);
                  setActors(item.allowedActors.join(", "));
                  save.reset();
                }}
              >
                編集
              </button>
              <button
                className="action text-danger"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `「${item.name}」を削除しますか？受付済みの Run は続行し、履歴は残ります。`,
                    )
                  )
                    remove.mutate(item);
                }}
              >
                削除
              </button>
            </div>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section className="space-y-4 border-t border-rule pt-4">
      <h3 className="text-lg font-medium">Routine</h3>
      <p className="text-sm text-muted-foreground">
        Issue にラベルが付いたときか、Issue に @tailos plan
        とコメントされたときに実行します。一致する有効な Routine
        はすべて起動し、複数の PR や通知が作られる場合があります。Routine は
        Issue ごとに 1 つの Session を続け、2 回目以降の起動や @tailos
        の続きのコメントはその Session に届いた順に処理されます。
      </p>
      {renderRoutines()}
      <button
        className="action"
        type="button"
        onClick={() => void list.refetch()}
      >
        一覧を更新
      </button>
      <form
        onSubmit={submit}
        className="space-y-3 rounded border border-rule p-3"
      >
        <h4 className="font-medium">
          {editing ? "Routine を編集" : "Routine を追加"}
        </h4>
        <label className="block">
          名前
          <input
            required
            maxLength={100}
            className={field}
            value={settings.name}
            onChange={(e) => setSettings({ ...settings, name: e.target.value })}
          />
        </label>
        <label className="block">
          起動
          <select
            className={field}
            value={settings.trigger.type}
            disabled={!!editing}
            onChange={(e) => {
              const type = e.target.value as RoutineSettings["trigger"]["type"];
              setSettings({ ...settings, ...triggers[type] });
            }}
          >
            <option value="github.issue-label">Issue のラベル</option>
            <option value="github.issue-comment">
              Issue のコメント @tailos plan（読み取り専用の計画）
            </option>
          </select>
        </label>
        {settings.trigger.type === "github.issue-label" && (
          <label className="block">
            起動ラベル
            <input
              required
              maxLength={50}
              className={field}
              value={settings.trigger.label}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  trigger: {
                    version: 1,
                    type: "github.issue-label",
                    label: e.target.value,
                  },
                })
              }
            />
          </label>
        )}
        <label className="block">
          起動を許可する GitHub ユーザー
          <input
            required
            className={field}
            value={actors}
            onChange={(e) => setActors(e.target.value)}
            placeholder="login1, login2"
          />
        </label>
        <label className="block">
          プロンプト
          <textarea
            required
            maxLength={4000}
            rows={5}
            className={field}
            value={settings.prompt}
            onChange={(e) =>
              setSettings({ ...settings, prompt: e.target.value })
            }
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Agent は Codex。変更がある場合は既存の検証・PR 公開経路で処理します。
        </p>
        <label className="block">
          モデル
          <select
            className={field}
            value={settings.model ?? ""}
            onChange={(e) => {
              const model = e.target.value || undefined;
              setSettings({
                ...settings,
                model,
                effort: availableEfforts(models, model).find(
                  (effort) => effort === settings.effort,
                ),
              });
            }}
          >
            <option value="">既定</option>
            {settings.model && !modelIds.includes(settings.model) && (
              <option value={settings.model} disabled>
                {settings.model}（保存済み）
              </option>
            )}
            {modelIds.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          effort
          <select
            className={field}
            value={settings.effort ?? ""}
            onChange={(e) =>
              setSettings({
                ...settings,
                effort: e.target.value || undefined,
              })
            }
          >
            <option value="">既定</option>
            {settings.effort && !efforts.includes(settings.effort) && (
              <option value={settings.effort} disabled>
                {settings.effort}（保存済み）
              </option>
            )}
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) =>
              setSettings({ ...settings, enabled: e.target.checked })
            }
          />
          有効にする
        </label>
        <p className="text-sm text-muted-foreground">
          無効状態なら、接続やモデル情報を確認できなくても保存できます。有効化には接続とモデル設定の検証が必要です。
        </p>
        <div className="flex gap-2">
          <button
            className="action action-primary"
            disabled={busy}
            type="submit"
          >
            {save.isPending ? "保存しています…" : "保存"}
          </button>
          {editing && (
            <button
              className="action"
              type="button"
              disabled={busy}
              onClick={reset}
            >
              編集をやめる
            </button>
          )}
        </div>
      </form>
      {(save.isError || remove.isError) && (
        <p role="alert" className="text-danger">
          {save.error?.message ?? remove.error?.message}
        </p>
      )}
      <details>
        <summary className="cursor-pointer font-medium">
          Routine の変更履歴
        </summary>
        {renderRoutineHistory()}
      </details>
    </section>
  );
}
