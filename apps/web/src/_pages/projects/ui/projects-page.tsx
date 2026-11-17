"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RequestState } from "@/widgets/request-state";
import {
  projectsQueryOptions,
  repositoriesQueryOptions,
  projectHistoryQueryOptions,
  projectsKey,
  projectHistoryKey,
  type ProjectItem,
  type ProjectSettings,
  type ProjectChange,
} from "../api/queries";
import { saveProject, deleteProject, importProjects } from "../api/mutations";

const empty: ProjectSettings = {
  name: "",
  repository: "",
  repositoryId: 0,
  installationId: 0,
  triggerLabel: "tailos:run",
  allowedActors: [],
  agentNetworkAccess: false,
  maxRunMinutes: 30,
};
const fieldClass =
  "block w-full rounded-md border border-rule bg-paper px-3 py-2";
function Snapshot({ project }: { project: ProjectChange["before"] }) {
  if (!project) return <p className="text-muted-foreground">設定なし</p>;
  return (
    <dl className="space-y-1 break-words text-sm">
      <div>
        <dt className="text-muted-foreground">名前</dt>
        <dd>{project.name}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">リポジトリ</dt>
        <dd>{project.repository}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">起動ラベル</dt>
        <dd>{project.triggerLabel}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">許可ユーザー</dt>
        <dd>{project.allowedActors.join(", ")}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">通信</dt>
        <dd>{project.agentNetworkAccess ? "許可" : "無効"}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">制限時間</dt>
        <dd>{project.maxRunMinutes}分</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">
          リポジトリ ID / installation ID
        </dt>
        <dd>
          {project.repositoryId} / {project.installationId}
        </dd>
      </div>
    </dl>
  );
}
export function ProjectsPage() {
  const client = useQueryClient();
  const projects = useQuery(projectsQueryOptions());
  const repositories = useQuery(repositoriesQueryOptions());
  const [before, setBefore] = useState<number>();
  const history = useQuery(projectHistoryQueryOptions(before));
  const [editing, setEditing] = useState<ProjectItem | null>(null);
  const [settings, setSettings] = useState<ProjectSettings>({ ...empty });
  const [actors, setActors] = useState("");
  const [legacyJson, setLegacyJson] = useState("");
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: projectsKey }),
      client.invalidateQueries({ queryKey: projectHistoryKey }),
    ]);
    setBefore(undefined);
  };
  const reset = () => {
    setEditing(null);
    setSettings({ ...empty });
    setActors("");
  };
  const save = useMutation({
    mutationFn: () =>
      saveProject(
        { ...settings, allowedActors: actors.split(/[,\s]+/).filter(Boolean) },
        editing?.project.id,
        editing?.revision,
      ),
    onSuccess: async () => {
      reset();
      await invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (item: ProjectItem) =>
      deleteProject(item.project.id, item.revision),
    onSuccess: async (_, item) => {
      if (editing?.project.id === item.project.id) reset();
      await invalidate();
    },
  });
  const migrate = useMutation({
    mutationFn: () => importProjects(legacyJson),
    onSuccess: async () => {
      setLegacyJson("");
      await invalidate();
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!save.isPending) save.mutate();
  }
  const choices =
    repositories.data && !("error" in repositories.data)
      ? repositories.data.repositories
      : [];
  const selected = choices.findIndex(
    (r) =>
      r.repository === settings.repository &&
      r.repositoryId === settings.repositoryId &&
      r.installationId === settings.installationId,
  );
  const busy = save.isPending || remove.isPending || migrate.isPending;
  const data = projects.data;
  if (projects.isPending)
    return <p role="status">Project を読み込んでいます。</p>;
  if (projects.isError || !data || "error" in data)
    return (
      <RequestState
        status={data && "error" in data ? data.error : undefined}
        missing="Project を利用できません。"
        retry={() => void projects.refetch()}
      />
    );
  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-medium">Project 設定</h1>
        <p className="text-muted-foreground">
          リポジトリと起動条件を管理します。変更は新しく作る Run
          に適用されます。
        </p>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium">
            登録済みの Project（{data.projects.length}/100）
          </h2>
          <button
            type="button"
            className="action"
            disabled={busy}
            onClick={() => void projects.refetch()}
          >
            一覧を更新
          </button>
        </div>
        {data.projects.length === 0 ? (
          <p className="text-muted-foreground">Project はまだありません。</p>
        ) : (
          <ul className="divide-y divide-rule rounded-lg border border-rule bg-panel">
            {data.projects.map((item) => (
              <li key={item.project.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="font-medium">{item.project.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {item.project.repository}
                    </p>
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {item.project.id}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="action"
                      disabled={busy}
                      onClick={() => {
                        setEditing(item);
                        setSettings({
                          name: item.project.name,
                          repository: item.project.repository,
                          repositoryId: item.project.repositoryId,
                          installationId: item.project.installationId,
                          triggerLabel: item.project.triggerLabel,
                          allowedActors: item.project.allowedActors,
                          agentNetworkAccess: item.project.agentNetworkAccess,
                          maxRunMinutes: item.project.maxRunMinutes,
                        });
                        setActors(item.project.allowedActors.join(", "));
                        save.reset();
                      }}
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      className="action text-danger"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `「${item.project.name}」を削除しますか？新規起動は停止します。作成済みの Run は続行し、会話と履歴は残ります。`,
                          )
                        )
                          remove.mutate(item);
                      }}
                    >
                      削除
                    </button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  ラベル {item.project.triggerLabel} · 通信{" "}
                  {item.project.agentNetworkAccess ? "許可" : "無効"} · 上限{" "}
                  {item.project.maxRunMinutes}分
                </p>
              </li>
            ))}
          </ul>
        )}
        {remove.isError && (
          <p role="alert" className="text-danger">
            {remove.error.message}
          </p>
        )}
      </div>
      <form className="surface space-y-4" onSubmit={submit}>
        <h2 className="text-lg font-medium">
          {editing ? "Project を編集" : "Project を追加"}
        </h2>
        <label className="block space-y-2 text-sm">
          名前
          <input
            required
            maxLength={100}
            className={fieldClass}
            value={settings.name}
            disabled={busy}
            onChange={(event) =>
              setSettings({ ...settings, name: event.target.value })
            }
          />
        </label>
        <label className="block space-y-2 text-sm">
          リポジトリ
          <select
            required
            className={fieldClass}
            disabled={
              busy ||
              repositories.isPending ||
              repositories.isError ||
              !repositories.data ||
              "error" in repositories.data
            }
            value={selected < 0 ? "" : String(selected)}
            onChange={(event) => {
              const choice = choices[Number(event.target.value)];
              if (choice && event.target.value !== "")
                setSettings({ ...settings, ...choice });
            }}
          >
            <option value="">
              {editing && selected < 0
                ? `現在: ${settings.repository}（候補を取得して選択してください）`
                : "リポジトリを選択"}
            </option>
            {choices.map((choice, index) => (
              <option
                key={`${choice.installationId}/${choice.repositoryId}`}
                value={index}
              >
                {choice.repository}（installation {choice.installationId}）
              </option>
            ))}
          </select>
        </label>
        {repositories.isPending ? (
          <p role="status">GitHub のリポジトリを読み込んでいます。</p>
        ) : repositories.isError ||
          !repositories.data ||
          "error" in repositories.data ? (
          <RequestState
            status={
              repositories.data && "error" in repositories.data
                ? repositories.data.error
                : undefined
            }
            missing="GitHub App のリポジトリを取得できません。"
            retry={() => void repositories.refetch()}
          />
        ) : choices.length === 0 ? (
          <p className="text-muted-foreground">
            選択できるリポジトリがありません。GitHub App の installation
            とリポジトリへのアクセスを確認してください。
          </p>
        ) : null}
        <button
          type="button"
          className="action"
          disabled={repositories.isFetching}
          onClick={() => void repositories.refetch()}
        >
          リポジトリ候補を更新
        </button>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm">
            起動ラベル
            <input
              required
              maxLength={50}
              className={fieldClass}
              value={settings.triggerLabel}
              onChange={(e) =>
                setSettings({ ...settings, triggerLabel: e.target.value })
              }
            />
          </label>
          <label className="space-y-2 text-sm">
            Run の上限時間（分）
            <input
              required
              type="number"
              min={1}
              max={30}
              step={1}
              className={fieldClass}
              value={settings.maxRunMinutes}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  maxRunMinutes: Number(e.target.value),
                })
              }
            />
          </label>
        </div>
        <label className="block space-y-2 text-sm">
          起動を許可する GitHub ユーザー
          <input
            required
            className={fieldClass}
            value={actors}
            onChange={(e) => setActors(e.target.value)}
            placeholder="login1, login2"
          />
          <span className="text-muted-foreground">
            ログイン名をカンマまたは空白で区切って入力します（1〜100件）。
          </span>
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.agentNetworkAccess}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  agentNetworkAccess: e.target.checked,
                })
              }
            />
            Agent のコマンドによる通信を許可する
          </label>
          <p className="text-sm text-muted-foreground">
            有効にすると依存関係のスクリプトを含むコマンドが任意の宛先へ通信でき、非公開ソースや読み取り可能なデータを外部に送信できるようになります。
          </p>
        </div>
        <div className="flex gap-3">
          <button
            className="action action-primary"
            disabled={
              busy ||
              selected < 0 ||
              actors.split(/[,\s]+/).filter(Boolean).length === 0
            }
            type="submit"
          >
            {save.isPending ? "保存しています…" : "保存"}
          </button>
          {editing && (
            <button
              className="action"
              disabled={busy}
              type="button"
              onClick={reset}
            >
              編集をやめる
            </button>
          )}
        </div>
        {save.isError && (
          <p role="alert" className="text-danger">
            {save.error.message}
          </p>
        )}
      </form>
      {data.projects.length === 0 && (
        <details className="surface">
          <summary className="cursor-pointer font-medium">
            既存設定を初回インポート
          </summary>
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) migrate.mutate();
            }}
          >
            <p className="text-sm text-muted-foreground">
              旧 TAILOS_PROJECTS の JSON
              配列を貼り付けてください。登録履歴のない環境で一度だけ実行できます。UUID
              を発行し、既存 Session の紐付けも移します。
            </p>
            <textarea
              aria-label="移行する Project 設定の JSON"
              required
              rows={8}
              className={`${fieldClass} font-mono text-sm`}
              value={legacyJson}
              onChange={(e) => setLegacyJson(e.target.value)}
            />
            <button className="action" disabled={busy} type="submit">
              {migrate.isPending ? "移行しています…" : "インポート"}
            </button>
            {migrate.isError && (
              <p role="alert" className="text-danger">
                {migrate.error.message}
              </p>
            )}
          </form>
        </details>
      )}
      <div className="space-y-3">
        <h2 className="text-lg font-medium">変更履歴</h2>
        {history.isPending ? (
          <p role="status">履歴を読み込んでいます。</p>
        ) : history.isError || !history.data || "error" in history.data ? (
          <RequestState
            status={
              history.data && "error" in history.data
                ? history.data.error
                : undefined
            }
            missing="変更履歴を取得できません。"
            retry={() => void history.refetch()}
          />
        ) : (
          <>
            {history.data.changes.length === 0 && (
              <p className="text-muted-foreground">
                変更履歴はまだありません。
              </p>
            )}
            {history.data.changes.map((change) => (
              <details className="surface" key={change.id}>
                <summary className="cursor-pointer break-words text-sm">
                  {new Date(change.createdAt).toLocaleString("ja-JP")} ·{" "}
                  {
                    {
                      create: "追加",
                      update: "変更",
                      delete: "削除",
                      import: "移行",
                    }[change.operation]
                  }{" "}
                  · {change.after?.repository ?? change.before?.repository}
                </summary>
                <p className="my-3 break-all text-xs text-muted-foreground">
                  Project {change.projectId} · 変更者 {change.actorId}
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <h3 className="mb-2 font-medium">変更前</h3>
                    <Snapshot project={change.before} />
                  </div>
                  <div>
                    <h3 className="mb-2 font-medium">変更後</h3>
                    <Snapshot project={change.after} />
                  </div>
                </div>
              </details>
            ))}
            <div className="flex gap-3">
              {before !== undefined && (
                <button
                  type="button"
                  className="action"
                  onClick={() => setBefore(undefined)}
                >
                  最新の履歴
                </button>
              )}
              {history.data.nextCursor !== null && (
                <button
                  type="button"
                  className="action"
                  onClick={() =>
                    setBefore(
                      history.data && !("error" in history.data)
                        ? (history.data.nextCursor ?? undefined)
                        : undefined,
                    )
                  }
                >
                  以前の履歴
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
