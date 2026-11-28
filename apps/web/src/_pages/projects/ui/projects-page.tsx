"use client";

import {
  Button,
  Select,
  TextArea,
  TextField,
} from "@/shared/ui/design-systems";
import { RoutinePanel } from "./routine-panel";
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
  maxRunMinutes: 30,
};
function repositoryChoiceId({
  installationId,
  repositoryId,
}: Pick<ProjectSettings, "installationId" | "repositoryId">) {
  return `${installationId}/${repositoryId}`;
}
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
      {project.triggerLabel && (
        <div>
          <dt className="text-muted-foreground">移行前の起動ラベル</dt>
          <dd>{project.triggerLabel}</dd>
        </div>
      )}
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
  };
  const save = useMutation({
    mutationFn: () =>
      saveProject(settings, editing?.project.id, editing?.revision),
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
    if (!busy && selected) save.mutate();
  }
  const choices =
    repositories.data && !("error" in repositories.data)
      ? repositories.data.repositories
      : [];
  const selected = choices.find(
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
  function renderProjectHistory() {
    if (history.isPending) return <p role="status">履歴を読み込んでいます。</p>;
    if (history.isError || !history.data || "error" in history.data)
      return (
        <RequestState
          status={
            history.data && "error" in history.data
              ? history.data.error
              : undefined
          }
          missing="変更履歴を取得できません。"
          retry={() => void history.refetch()}
        />
      );
    return (
      <>
        {history.data.changes.length === 0 && (
          <p className="text-muted-foreground">変更履歴はまだありません。</p>
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
            <Button
              type="button"
              variant="outline"
              size="touch"
              onPress={() => setBefore(undefined)}
            >
              最新の履歴
            </Button>
          )}
          {history.data.nextCursor !== null && (
            <Button
              type="button"
              variant="outline"
              size="touch"
              onPress={() =>
                setBefore(
                  history.data && !("error" in history.data)
                    ? (history.data.nextCursor ?? undefined)
                    : undefined,
                )
              }
            >
              以前の履歴
            </Button>
          )}
        </div>
      </>
    );
  }
  function renderRepositories() {
    if (repositories.isPending)
      return <p role="status">GitHub のリポジトリを読み込んでいます。</p>;
    if (
      repositories.isError ||
      !repositories.data ||
      "error" in repositories.data
    )
      return (
        <RequestState
          status={
            repositories.data && "error" in repositories.data
              ? repositories.data.error
              : undefined
          }
          missing="GitHub App のリポジトリを取得できません。"
          retry={() => void repositories.refetch()}
        />
      );
    if (choices.length === 0)
      return (
        <p className="text-muted-foreground">
          選択できるリポジトリがありません。GitHub App の installation
          とリポジトリへのアクセスを確認してください。
        </p>
      );
    return null;
  }
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
          <Button
            type="button"
            variant="outline"
            size="touch"
            isDisabled={busy}
            onPress={() => void projects.refetch()}
          >
            一覧を更新
          </Button>
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
                    <Button
                      type="button"
                      variant="outline"
                      size="touch"
                      isDisabled={busy}
                      onPress={() => {
                        setEditing(item);
                        setSettings({
                          name: item.project.name,
                          repository: item.project.repository,
                          repositoryId: item.project.repositoryId,
                          installationId: item.project.installationId,
                          maxRunMinutes: item.project.maxRunMinutes,
                        });
                        save.reset();
                      }}
                    >
                      編集
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="touch"
                      isDisabled={busy}
                      onPress={() => {
                        if (
                          window.confirm(
                            `「${item.project.name}」を削除しますか？新規起動は停止します。作成済みの Run は続行し、会話と履歴は残ります。`,
                          )
                        )
                          remove.mutate(item);
                      }}
                    >
                      削除
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  上限 {item.project.maxRunMinutes}分
                </p>
                <RoutinePanel projectId={item.project.id} />
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
        <TextField
          label="名前"
          isRequired
          maxLength={100}
          value={settings.name}
          isDisabled={busy}
          onChange={(name) => setSettings({ ...settings, name })}
        />
        <Select
          label="リポジトリ"
          size="lg"
          isRequired
          options={choices.map((choice) => ({
            id: repositoryChoiceId(choice),
            label: `${choice.repository}（installation ${choice.installationId}）`,
          }))}
          placeholder={
            editing && !selected
              ? `現在: ${settings.repository}（候補を取得して選択してください）`
              : "リポジトリを選択"
          }
          disabled={
            busy ||
            repositories.isPending ||
            repositories.isError ||
            !repositories.data ||
            "error" in repositories.data
          }
          value={selected ? repositoryChoiceId(selected) : null}
          onValueChange={(id) => {
            const choice = choices.find(
              (item) => repositoryChoiceId(item) === id,
            );
            if (choice) setSettings({ ...settings, ...choice });
          }}
        />
        {renderRepositories()}
        <Button
          type="button"
          variant="outline"
          size="touch"
          isDisabled={repositories.isFetching}
          onPress={() => void repositories.refetch()}
        >
          リポジトリ候補を更新
        </Button>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Run の上限時間（分）"
            isRequired
            type="number"
            min={1}
            max={30}
            step={1}
            value={String(settings.maxRunMinutes)}
            onChange={(value) =>
              setSettings({ ...settings, maxRunMinutes: Number(value) })
            }
          />
        </div>
        <div className="flex gap-3">
          <Button
            variant="default"
            size="touch"
            isDisabled={busy || !selected}
            type="submit"
          >
            {save.isPending ? "保存しています…" : "保存"}
          </Button>
          {editing && (
            <Button
              variant="outline"
              size="touch"
              isDisabled={busy}
              type="button"
              onPress={reset}
            >
              編集をやめる
            </Button>
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
            <TextArea
              aria-label="移行する Project 設定の JSON"
              isRequired
              rows={8}
              textAreaClassName="font-mono"
              value={legacyJson}
              onChange={setLegacyJson}
            />
            <Button
              variant="outline"
              size="touch"
              isDisabled={busy}
              type="submit"
            >
              {migrate.isPending ? "移行しています…" : "インポート"}
            </Button>
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
        {renderProjectHistory()}
      </div>
    </section>
  );
}
