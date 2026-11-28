"use client";
import {
  Button,
  Checkbox,
  Select,
  TextArea,
  TextField,
  type SelectOption,
} from "@/shared/ui/design-systems";
import { RequestState } from "@/widgets/request-state";
import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  agentEngineLabels,
  agentEngines,
  agentModels,
  type AgentModel,
} from "@tailos/core/models";
import {
  RoutineRequestError,
  routinesQueryOptions,
  routinesKey,
  type Routine,
} from "@/entities/routine";
import {
  routineHistoryKey,
  routineHistoryQueryOptions,
  saveRoutine,
  deleteRoutine,
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

const defaultCatalogChoice = "default";

function catalogChoiceId(value: string | undefined) {
  return value === undefined ? defaultCatalogChoice : `catalog:${value}`;
}

function catalogChoices(
  values: readonly string[],
  saved?: string,
): SelectOption[] {
  const options: SelectOption[] = [{ id: defaultCatalogChoice, label: "既定" }];
  if (saved && !values.includes(saved)) {
    options.push({
      id: catalogChoiceId(saved),
      label: `${saved}（保存済み）`,
      disabled: true,
    });
  }
  options.push(
    ...values.map((value) => ({ id: catalogChoiceId(value), label: value })),
  );
  return options;
}

function readCatalogChoice(id: string | null) {
  return id?.startsWith("catalog:") ? id.slice("catalog:".length) : undefined;
}

const triggerChoices = [
  { id: "github.issue-label", label: "Issue のラベル" },
  { id: "github.issue-comment", label: "Issue のコメント @tailos plan" },
] as const;
const implementationPrompt =
  "Implement the GitHub issue identified by the structured job context. Read the issue using tailos_github_get, make the required changes, and run relevant checks. Commit the changes on a new branch, push it, and open a pull request with gh whose body includes Closes #<issue number>. Summarize the result with the pull request URL.";
const planningPrompt =
  "Plan the GitHub issue identified by the structured job context, answering the new message from a permitted user. Read the issue using tailos_github_get and investigate the repository. Do not implement or publish changes. Reply with a concrete plan with assumptions, affected files, implementation steps and validation methods. Include questions if needed, then end this turn without waiting for answers; questions alone are a complete reply. Post your reply on the issue as a comment with gh issue comment, without mentioning anyone with @, and give the same reply in your answer.";
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
    <p>コメント: @tailos {trigger.command}</p>
  );
}
export function RoutinePanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        size="touch"
        type="button"
        aria-expanded={open}
        onPress={() => setOpen(!open)}
      >
        {open ? "Routine を閉じる" : "Routine を管理"}
      </Button>
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
        {agentEngineLabels[settings.engine]} · model: {settings.model ?? "既定"}{" "}
        · effort: {settings.effort ?? "既定"}
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
  const models = agentModels(settings.engine);
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
          <Button
            variant="outline"
            size="touch"
            type="button"
            onPress={() => setBefore(undefined)}
          >
            最新の履歴
          </Button>
        )}
        {history.data.nextCursor !== null && (
          <Button
            variant="outline"
            size="touch"
            type="button"
            onPress={() => setBefore(history.data.nextCursor ?? undefined)}
          >
            以前の履歴
          </Button>
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
              <Button
                variant="outline"
                size="touch"
                type="button"
                isDisabled={busy}
                onPress={() => {
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
              </Button>
              <Button
                variant="destructive"
                size="touch"
                type="button"
                isDisabled={busy}
                onPress={() => {
                  if (
                    window.confirm(
                      `「${item.name}」を削除しますか？受付済みの Run は続行し、履歴は残ります。`,
                    )
                  )
                    remove.mutate(item);
                }}
              >
                削除
              </Button>
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
      <Button
        variant="outline"
        size="touch"
        type="button"
        onPress={() => void list.refetch()}
      >
        一覧を更新
      </Button>
      <form
        onSubmit={submit}
        className="space-y-3 rounded border border-rule p-3"
      >
        <h4 className="font-medium">
          {editing ? "Routine を編集" : "Routine を追加"}
        </h4>
        <TextField
          label="名前"
          isRequired
          maxLength={100}
          value={settings.name}
          onChange={(name) => setSettings({ ...settings, name })}
        />
        <Select
          label="起動"
          size="lg"
          options={triggerChoices}
          value={settings.trigger.type}
          disabled={!!editing}
          onValueChange={(id) => {
            const choice = triggerChoices.find((option) => option.id === id);
            if (choice) setSettings({ ...settings, ...triggers[choice.id] });
          }}
        />
        {settings.trigger.type === "github.issue-label" && (
          <TextField
            label="起動ラベル"
            isRequired
            maxLength={50}
            value={settings.trigger.label}
            onChange={(label) =>
              setSettings({
                ...settings,
                trigger: { version: 1, type: "github.issue-label", label },
              })
            }
          />
        )}
        <TextField
          label="起動を許可する GitHub ユーザー"
          isRequired
          value={actors}
          onChange={setActors}
          placeholder="login1, login2"
        />
        <TextArea
          label="プロンプト"
          isRequired
          maxLength={4000}
          rows={5}
          value={settings.prompt}
          onChange={(prompt) => setSettings({ ...settings, prompt })}
        />
        <Select
          label="Model Provider"
          size="lg"
          options={agentEngines.map((engine) => ({
            id: engine,
            label: agentEngineLabels[engine],
          }))}
          value={settings.engine}
          onValueChange={(id) => {
            const engine = agentEngines.find((item) => item === id);
            // Each provider has its own models: start from its defaults.
            if (engine && engine !== settings.engine)
              setSettings({
                ...settings,
                engine,
                model: undefined,
                effort: undefined,
              });
          }}
        />
        <p className="text-sm text-muted-foreground">
          変更がある場合は既存の検証・PR 公開経路で処理します。Provider
          の接続がないと有効にできません。
        </p>
        <Select
          label="モデル"
          size="lg"
          options={catalogChoices(modelIds, settings.model)}
          value={catalogChoiceId(settings.model)}
          onValueChange={(id) => {
            const model = readCatalogChoice(id);
            setSettings({
              ...settings,
              model,
              effort: availableEfforts(models, model).find(
                (effort) => effort === settings.effort,
              ),
            });
          }}
        />
        <Select
          label="effort"
          size="lg"
          options={catalogChoices(efforts, settings.effort)}
          value={catalogChoiceId(settings.effort)}
          onValueChange={(id) =>
            setSettings({ ...settings, effort: readCatalogChoice(id) })
          }
        />
        <Checkbox
          isSelected={settings.enabled}
          onChange={(enabled) => setSettings({ ...settings, enabled })}
        >
          有効にする
        </Checkbox>
        <p className="text-sm text-muted-foreground">
          無効状態なら、接続やモデル情報を確認できなくても保存できます。有効化には接続とモデル設定の検証が必要です。
        </p>
        <div className="flex gap-2">
          <Button
            variant="default"
            size="touch"
            isDisabled={busy}
            type="submit"
          >
            {save.isPending ? "保存しています…" : "保存"}
          </Button>
          {editing && (
            <Button
              variant="outline"
              size="touch"
              type="button"
              isDisabled={busy}
              onPress={reset}
            >
              編集をやめる
            </Button>
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
