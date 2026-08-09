import type {
  BridgeDesktopRuntime,
  BridgeDesktopRuntimeId,
  BridgeRuntimeHandoff,
  BridgeRuntimeHandoffPreview,
  BridgeSessionInfo,
} from "@bridge/protocol";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CirclePlay,
  Forward,
  ListChecks,
  LoaderCircle,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { IconButton } from "./IconButton.js";

function handoffStateLabel(handoff: BridgeRuntimeHandoff): string {
  if (handoff.state === "previewed") return "等待确认接力";
  if (handoff.state === "preparing") return "正在停止源任务并交接上下文";
  if (handoff.state === "planning") return "目标正在制定计划";
  if (handoff.state === "plan-ready") return "计划已就绪，等待确认执行";
  if (handoff.state === "executing") return "正在启动目标执行";
  if (handoff.state === "applied") return "接力完成";
  if (handoff.state === "cancelled") return "已取消";
  return "接力失败";
}

export function RuntimeHandoffDialog({
  session,
  runtimes,
  onPreview,
  onCommit,
  onConfirm,
  onCancel,
  onGet,
  onOpenSession,
  onClose,
}: {
  session: BridgeSessionInfo;
  runtimes: BridgeDesktopRuntime[];
  onPreview(targetRuntimeId: BridgeDesktopRuntimeId): Promise<BridgeRuntimeHandoffPreview>;
  onCommit(handoffId: string): Promise<BridgeRuntimeHandoff>;
  onConfirm(handoffId: string, objective?: string): Promise<{ handoff: BridgeRuntimeHandoff }>;
  onCancel(handoffId: string): Promise<BridgeRuntimeHandoff | undefined>;
  onGet(handoffId: string): Promise<BridgeRuntimeHandoff>;
  onOpenSession(sessionId: string): void;
  onClose(): void;
}) {
  const sourceRuntimeId: BridgeDesktopRuntimeId = session.runtimeId ?? "claude-desktop";
  const candidates = useMemo(
    () => runtimes.filter((runtime) => runtime.id !== sourceRuntimeId && runtime.state === "ready"),
    [runtimes, sourceRuntimeId],
  );
  const pending = session.pendingRuntimeHandoff;
  const [targetId, setTargetId] = useState<BridgeDesktopRuntimeId | "">(candidates[0]?.id ?? "");
  const [preview, setPreview] = useState<BridgeRuntimeHandoffPreview>();
  const [planText, setPlanText] = useState<string>();
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dismissedId, setDismissedId] = useState<string>();
  const sourceName = runtimes.find((runtime) => runtime.id === sourceRuntimeId)?.name ?? "Claude Desktop";

  // Follow the server-driven handoff attached to the session snapshot.
  const handoff = pending && pending.handoffId !== dismissedId ? pending : undefined;

  useEffect(() => {
    if (handoff?.state !== "plan-ready") return;
    let stale = false;
    void onGet(handoff.handoffId).then((full) => {
      if (stale) return;
      if (full.planText) setPlanText(full.planText);
      setObjective((current) => current || full.objective);
    }).catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [handoff?.handoffId, handoff?.state]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function cancelActive(): Promise<void> {
    const item = handoff ?? preview?.handoff;
    if (!item) return;
    await run(async () => {
      await onCancel(item.handoffId);
      setDismissedId(item.handoffId);
      setPreview(undefined);
      onClose();
    });
  }

  const phase: "choose" | "preview" | "progress" | "plan" | "done" | "failed" = handoff
    ? handoff.state === "plan-ready"
      ? "plan"
      : handoff.state === "applied"
        ? "done"
        : handoff.state === "failed"
          ? "failed"
          : handoff.state === "cancelled"
            ? "choose"
            : "progress"
    : preview
      ? "preview"
      : "choose";

  return (
    <div className="modal-backdrop provider-switch-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="provider-switch-dialog runtime-handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="runtime-handoff-title">
        <header>
          <div>
            <span>跨 Desktop 串行接力</span>
            <h2 id="runtime-handoff-title">接力到其他 Desktop</h2>
          </div>
          <IconButton label="关闭" disabled={busy} onClick={onClose}><X size={18} /></IconButton>
        </header>

        <div className="provider-current">
          <span>当前</span>
          <strong>{sourceName}</strong>
          <small>{session.title}</small>
        </div>

        {phase === "choose" && (
          <>
            <div className="provider-options" role="radiogroup" aria-label="目标 Desktop">
              {candidates.map((runtime) => (
                <label className={`provider-option ${targetId === runtime.id ? "selected" : ""}`} key={runtime.id}>
                  <input
                    type="radio"
                    name="runtime"
                    value={runtime.id}
                    checked={targetId === runtime.id}
                    onChange={() => setTargetId(runtime.id)}
                  />
                  <span>
                    <strong>{runtime.name}</strong>
                    <small>
                      {runtime.id === "codex-desktop"
                        ? "原生计划模式 + goal 持续执行"
                        : "Bridge 编排计划与目标追踪"}
                    </small>
                  </span>
                  <b className="ready">可用</b>
                </label>
              ))}
              {!candidates.length && (
                <div className="session-channel-warning">
                  <AlertTriangle size={17} />
                  <span><strong>没有可用的目标 Desktop</strong>请先在 Bridge 中连接 Codex 或 Hermes。</span>
                </div>
              )}
            </div>
            <p className="runtime-handoff-note">
              接力会先停止当前任务，把可见上下文交接给目标 Desktop 的新会话；目标先制定计划，经你确认后以 goal 模式执行。原会话保留历史。
            </p>
            <footer className="provider-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy || !targetId}
                onClick={() => void run(async () => {
                  const result = await onPreview(targetId as BridgeDesktopRuntimeId);
                  setPreview(result);
                  setObjective(result.objectiveDraft);
                })}
              >
                {busy ? <LoaderCircle className="is-spinning" size={15} /> : <ArrowRight size={15} />}
                生成接力预览
              </button>
            </footer>
          </>
        )}

        {phase === "preview" && preview && (
          <>
            <div className="provider-handoff-preview">
              <span>接力摘要</span>
              <strong>{preview.objectiveDraft}</strong>
              <small>
                {`近期对话 ${preview.recentItemCount} 条 · 成果 ${preview.artifactCount} 项 · `}
                {preview.gitBranch ? `分支 ${preview.gitBranch} · ` : ""}
                {preview.workspaceDirty ? "工作区有未提交改动" : "工作区干净"}
              </small>
            </div>
            <label className="runtime-handoff-objective">
              <span>执行目标（确认计划前仍可修改）</span>
              <textarea
                value={objective}
                rows={3}
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>
            <footer className="provider-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setPreview(undefined)}>
                返回
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void run(async () => {
                  await onCommit(preview.handoff.handoffId);
                })}
              >
                {busy ? <LoaderCircle className="is-spinning" size={15} /> : <Forward size={15} />}
                确认接力
              </button>
            </footer>
          </>
        )}

        {phase === "progress" && handoff && (
          <div className="runtime-handoff-progress">
            <LoaderCircle className="is-spinning" size={22} />
            <strong>{handoffStateLabel(handoff)}</strong>
            <small>
              {handoff.state === "preparing"
                ? "源任务正在安全停止，上下文交接包随后发出。"
                : "目标只读分析工作区并制定计划，不会产生改动。"}
            </small>
            <footer className="provider-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void cancelActive()}>
                取消接力
              </button>
            </footer>
          </div>
        )}

        {phase === "plan" && handoff && (
          <>
            <div className="runtime-handoff-plan">
              <span><ListChecks size={15} /> 目标产出的计划</span>
              <pre>{planText ?? "正在读取计划全文…"}</pre>
            </div>
            <label className="runtime-handoff-objective">
              <span>执行目标</span>
              <textarea
                value={objective}
                rows={3}
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>
            <footer className="provider-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void cancelActive()}>
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !objective.trim()}
                onClick={() => void run(async () => {
                  await onConfirm(handoff.handoffId, objective);
                })}
              >
                {busy ? <LoaderCircle className="is-spinning" size={15} /> : <CirclePlay size={15} />}
                确认计划，以 goal 模式执行
              </button>
            </footer>
          </>
        )}

        {phase === "done" && handoff?.targetSessionId && (
          <div className="runtime-handoff-progress">
            <Check size={22} />
            <strong>接力完成</strong>
            <small>目标会话正在以 goal 模式执行，你可以随时停止或暂停目标。</small>
            <footer className="provider-actions">
              <button type="button" className="secondary-button" onClick={onClose}>留在当前会话</button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  onOpenSession(handoff.targetSessionId!);
                  onClose();
                }}
              >
                <ArrowRight size={15} />
                前往目标会话
              </button>
            </footer>
          </div>
        )}

        {phase === "failed" && handoff && (
          <div className="runtime-handoff-progress">
            <AlertTriangle size={22} />
            <strong>接力失败</strong>
            <small>{handoff.error ?? "未知错误"}</small>
            <footer className="provider-actions">
              <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
              <button
                type="button"
                className="primary-button"
                onClick={() => setDismissedId(handoff.handoffId)}
              >
                重新发起
              </button>
            </footer>
          </div>
        )}

        {error && (
          <div className="session-channel-warning danger">
            <AlertTriangle size={17} />
            <span>{error}</span>
          </div>
        )}
      </section>
    </div>
  );
}
