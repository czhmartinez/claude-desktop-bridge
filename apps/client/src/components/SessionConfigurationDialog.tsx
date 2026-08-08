import type {
  BridgePermissionMode,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
} from "@bridge/protocol";
import { LoaderCircle, Settings2, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { IconButton } from "./IconButton.js";

const EFFORT_LABELS: Record<string, string> = {
  none: "关闭",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "超高",
};

function effortLabel(value: string): string {
  return EFFORT_LABELS[value] ?? value;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export interface SessionConfigurationChange {
  model?: string | null;
  provider?: string | null;
  effort?: string | null;
  reasoningEffort?: string | null;
  fast?: boolean | null;
}

export function SessionConfigurationDialog({
  session,
  onLoad,
  onSave,
  onConfigurePermission,
  onClose,
}: {
  session: BridgeSessionInfo;
  onLoad(): Promise<BridgeSessionConfiguration>;
  onSave(change: SessionConfigurationChange): Promise<BridgeSessionConfiguration>;
  onConfigurePermission?(
    scope: "host" | "session",
    mode: BridgePermissionMode | null,
  ): Promise<BridgeSessionConfiguration>;
  onClose(): void;
}) {
  const [configuration, setConfiguration] = useState<BridgeSessionConfiguration>();
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [fast, setFast] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [permissionScope, setPermissionScope] = useState<"host" | "session">("host");
  const [permissionMode, setPermissionMode] = useState<BridgePermissionMode | "inherit">("standard");
  const [savingPermission, setSavingPermission] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void onLoad()
      .then((next) => {
        if (!active) return;
        setConfiguration(next);
        setProvider(next.provider ?? next.availableProviders?.[0]?.value ?? "");
        setModel(next.model ?? next.availableModels[0]?.value ?? "");
        setEffort(next.reasoningEffort ?? next.effort ?? next.availableReasoningEfforts?.[0] ?? next.availableEffortLevels[0] ?? "medium");
        setFast(next.fast ?? false);
        setPermissionScope("host");
        setPermissionMode(next.permissionPolicy?.hostMode ?? "standard");
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "会话配置读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session.sessionId]);

  const modelOptions = useMemo(() => {
    const all = configuration?.availableModels ?? [];
    if (!provider) return all;
    const scoped = all.filter((candidate) => !candidate.provider || candidate.provider === provider);
    return scoped.length ? scoped : all;
  }, [configuration, provider]);
  const selectedModel = useMemo(
    () => modelOptions.find((candidate) => candidate.value === model),
    [model, modelOptions],
  );
  const effortLevels = selectedModel?.supportedEffortLevels?.length
    ? selectedModel.supportedEffortLevels
    : configuration?.availableReasoningEfforts?.length
      ? configuration.availableReasoningEfforts
      : configuration?.availableEffortLevels ?? ["low", "medium", "high", "xhigh", "max"];
  const nativeRuntime = session.runtimeId === "codex-desktop" || session.runtimeId === "hermes-desktop";
  const fastSupported = Boolean(configuration?.supportsFastMode && selectedModel?.supportsFast !== false);

  function chooseModel(value: string): void {
    setModel(value);
    const nextModel = modelOptions.find((candidate) => candidate.value === value);
    if (nextModel?.provider) setProvider(nextModel.provider);
    if (nextModel?.supportsEffort === false) {
      setEffort("");
    } else if (nextModel?.supportedEffortLevels?.length && !nextModel.supportedEffortLevels.includes(effort)) {
      setEffort(nextModel.supportedEffortLevels[0]!);
    }
    if (nextModel?.supportsFast === false) setFast(false);
  }

  function chooseProvider(value: string): void {
    setProvider(value);
    const nextModels = (configuration?.availableModels ?? []).filter(
      (candidate) => !candidate.provider || candidate.provider === value,
    );
    const nextModel = nextModels[0];
    if (!nextModel) return;
    setModel(nextModel.value);
    if (nextModel.supportsEffort === false) {
      setEffort("");
    } else if (nextModel.supportedEffortLevels?.length && !nextModel.supportedEffortLevels.includes(effort)) {
      setEffort(nextModel.supportedEffortLevels[0]!);
    }
    if (nextModel.supportsFast === false) setFast(false);
  }

  async function save(change: SessionConfigurationChange): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await onSave(change);
      setConfiguration(next);
      setProvider(next.provider ?? next.availableProviders?.[0]?.value ?? "");
      setModel(next.model ?? next.availableModels[0]?.value ?? "");
      setEffort(next.reasoningEffort ?? next.effort ?? next.availableReasoningEfforts?.[0] ?? next.availableEffortLevels[0] ?? "medium");
      setFast(next.fast ?? false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "会话配置保存失败");
    } finally {
      setSaving(false);
    }
  }

  function choosePermissionScope(scope: "host" | "session"): void {
    setPermissionScope(scope);
    if (scope === "host") setPermissionMode(configuration?.permissionPolicy?.hostMode ?? "standard");
    else setPermissionMode(configuration?.permissionPolicy?.sessionMode ?? "inherit");
  }

  async function savePermission(): Promise<void> {
    if (!onConfigurePermission || savingPermission) return;
    setSavingPermission(true);
    setError(undefined);
    try {
      const next = await onConfigurePermission(
        permissionScope,
        permissionMode === "inherit" ? null : permissionMode,
      );
      setConfiguration(next);
      setPermissionMode(permissionScope === "host"
        ? next.permissionPolicy?.hostMode ?? "standard"
        : next.permissionPolicy?.sessionMode ?? "inherit");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "授权模式保存失败");
    } finally {
      setSavingPermission(false);
      setConfirmFullAccess(false);
    }
  }

  function requestPermissionSave(): void {
    const policy = configuration?.permissionPolicy;
    const alreadyFull = permissionScope === "host"
      ? policy?.hostMode === "full-access"
      : policy?.sessionMode === "full-access";
    if (permissionMode === "full-access" && !alreadyFull) setConfirmFullAccess(true);
    else void savePermission();
  }

  const appliesAfterTurn = session.turnState === "running" || configuration?.appliesAfterTurn;
  return (
    <div
      className="modal-backdrop session-configuration-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="session-configuration-dialog" role="dialog" aria-modal="true" aria-labelledby="session-configuration-title">
        <header>
          <div>
            <span><Settings2 size={15} />会话配置</span>
            <h2 id="session-configuration-title">{session.title}</h2>
          </div>
          <IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton>
        </header>

        {loading ? (
          <div className="session-configuration-loading">
            <LoaderCircle className="is-spinning" size={19} />
            正在读取 {nativeRuntime ? `${session.runtimeId === "codex-desktop" ? "Codex" : "Hermes"} Desktop` : "Claude Host"} 配置
          </div>
        ) : (
          <>
            {configuration?.context && (
              <div className="session-context-usage">
                <div>
                  <span>上下文</span>
                  <strong>
                    {formatTokens(configuration.context.totalTokens)}
                    <small> / {formatTokens(configuration.context.maxTokens)}</small>
                  </strong>
                </div>
                <div
                  className="session-context-track"
                  role="progressbar"
                  aria-label="上下文使用量"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(configuration.context.percentage)}
                >
                  <i style={{ width: `${Math.min(100, configuration.context.percentage)}%` }} />
                </div>
                <small>{configuration.context.estimated ? "基于最近一次会话用量" : "Claude Host 实时用量"}</small>
              </div>
            )}

            {configuration?.availableProviders?.length ? (
              <label className="session-model-field">
                <span>Provider</span>
                <select value={provider} onChange={(event) => chooseProvider(event.target.value)}>
                  {configuration.availableProviders.map((candidate) => (
                    <option value={candidate.value} key={candidate.value}>{candidate.displayName}</option>
                  ))}
                </select>
                <small>{provider || "跟随 Desktop 当前配置"}</small>
              </label>
            ) : null}

            <label className="session-model-field">
              <span>模型</span>
              <select value={model} disabled={!modelOptions.length} onChange={(event) => chooseModel(event.target.value)}>
                {modelOptions.map((candidate) => (
                  <option value={candidate.value} key={`${candidate.provider ?? ""}:${candidate.value}`}>{candidate.displayName}</option>
                ))}
              </select>
              <small>{selectedModel?.description || (!configuration?.modelsComplete ? "仅显示当前主机已发现的模型" : model)}</small>
            </label>

            {effortLevels.length > 0 && selectedModel?.supportsEffort !== false && (
              <fieldset className="session-effort-field">
                <legend>{nativeRuntime ? "思考强度" : "Effort"}</legend>
                <div className="effort-segments">
                  {effortLevels.map((level) => (
                    <button
                      type="button"
                      className={effort === level ? "active" : ""}
                      aria-pressed={effort === level}
                      onClick={() => setEffort(level)}
                      key={level}
                    >
                      {effortLabel(level)}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            {configuration?.supportsFastMode && (
              <label className="session-fast-field">
                <input
                  type="checkbox"
                  checked={fast}
                  disabled={!fastSupported}
                  onChange={(event) => setFast(event.target.checked)}
                />
                <span>快速模式</span>
                {!fastSupported && <small>当前模型不支持</small>}
              </label>
            )}

            {onConfigurePermission && configuration?.permissionPolicy && (
              <fieldset className="session-permission-field">
                <legend><ShieldCheck size={15} />授权模式</legend>
                <div className="permission-scope-segments" role="group" aria-label="授权范围">
                  <button
                    type="button"
                    className={permissionScope === "host" ? "active" : ""}
                    aria-pressed={permissionScope === "host"}
                    onClick={() => choosePermissionScope("host")}
                  >整台电脑</button>
                  <button
                    type="button"
                    className={permissionScope === "session" ? "active" : ""}
                    aria-pressed={permissionScope === "session"}
                    onClick={() => choosePermissionScope("session")}
                  >当前会话</button>
                </div>
                <div className={`permission-mode-segments ${permissionScope}`} role="group" aria-label="授权等级">
                  {permissionScope === "session" && (
                    <button
                      type="button"
                      className={permissionMode === "inherit" ? "active" : ""}
                      aria-pressed={permissionMode === "inherit"}
                      onClick={() => setPermissionMode("inherit")}
                    >跟随电脑</button>
                  )}
                  <button
                    type="button"
                    className={permissionMode === "standard" ? "active" : ""}
                    aria-pressed={permissionMode === "standard"}
                    onClick={() => setPermissionMode("standard")}
                  >标准授权</button>
                  <button
                    type="button"
                    className={permissionMode === "full-access" ? "active" : ""}
                    aria-pressed={permissionMode === "full-access"}
                    onClick={() => setPermissionMode("full-access")}
                  >完全授权</button>
                </div>
                <div className="session-permission-status">
                  当前生效：{configuration.permissionPolicy.effectiveMode === "full-access" ? "完全授权" : "标准授权"}
                  {configuration.permissionPolicy.source === "session" ? " · 会话覆盖" : " · 电脑默认"}
                </div>
                <button
                  type="button"
                  className="secondary-button session-permission-save"
                  disabled={savingPermission}
                  onClick={requestPermissionSave}
                >
                  {savingPermission && <LoaderCircle className="is-spinning" size={15} />}
                  保存授权模式
                </button>
              </fieldset>
            )}

            {appliesAfterTurn && <div className="session-configuration-notice">当前任务不会中断，修改从下一轮生效。</div>}
            {error && <div className="session-configuration-error">{error}</div>}

            <footer>
              {!nativeRuntime && (configuration?.overrideModel || configuration?.overrideEffort) && (
                <button type="button" className="secondary-button" disabled={saving} onClick={() => void save({ model: null, effort: null })}>
                  跟随 Claude Desktop
                </button>
              )}
              <button
                type="button"
                className="primary-button"
                disabled={saving || !model}
                onClick={() => void save({
                  model,
                  ...(nativeRuntime
                    ? {
                        provider: provider || null,
                        ...(selectedModel?.supportsEffort === false ? { reasoningEffort: null } : { reasoningEffort: effort }),
                        ...(configuration?.supportsFastMode ? { fast: fastSupported ? fast : false } : {}),
                      }
                    : {
                        effort: selectedModel?.supportsEffort === false ? null : effort,
                      }),
                })}
              >
                {saving && <LoaderCircle className="is-spinning" size={16} />}
                {appliesAfterTurn ? "应用到下一轮" : "保存配置"}
              </button>
            </footer>
          </>
        )}
      </section>
      <ConfirmationDialog
        open={confirmFullAccess}
        title="启用完全授权"
        description={permissionScope === "host"
          ? "这台电脑上的 Bridge 会话将自动批准命令和文件修改；Claude 的提问仍需你回答。"
          : "当前会话将自动批准命令和文件修改；Claude 的提问仍需你回答。"}
        confirmLabel="启用完全授权"
        busy={savingPermission}
        onCancel={() => setConfirmFullAccess(false)}
        onConfirm={() => void savePermission()}
      />
    </div>
  );
}
