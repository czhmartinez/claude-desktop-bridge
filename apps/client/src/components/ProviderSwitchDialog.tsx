import type {
  BridgeConversationRoute,
  BridgeHandoff,
  BridgeProviderProfile,
  BridgeSessionInfo,
} from "@bridge/protocol";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { IconButton } from "./IconButton.js";

export interface ProviderSwitchPreview {
  handoff: BridgeHandoff;
  route: BridgeConversationRoute;
  target: BridgeProviderProfile;
  summary: string;
}

export interface ProviderSwitchResult {
  handoff: BridgeHandoff;
  route: BridgeConversationRoute;
  deepLink?: string;
}

export function providerName(profileId: string | undefined, profiles: BridgeProviderProfile[]): string {
  return profiles.find((profile) => profile.id === profileId)?.name ?? "Claude-3p";
}

function stateLabel(handoff: BridgeHandoff): string {
  if (handoff.state === "previewed") return "等待确认";
  if (handoff.state === "preparing") return "正在准备";
  if (handoff.state === "activating") return "等待目标通道确认";
  if (handoff.state === "awaiting_user_confirmation") return "等待本机确认";
  if (handoff.state === "awaiting_target") return "需要选择官方会话";
  if (handoff.state === "applied") return "已完成切换";
  if (handoff.state === "failed") return "切换失败";
  if (handoff.state === "expired") return "确认已过期";
  return handoff.state;
}

export function ProviderSwitchDialog({
  session,
  profiles,
  desktopLocal = false,
  onPreview,
  onCommit,
  onCancel,
  onRefresh,
  onSetApiKey,
  onRemoveApiKey,
  onChanged,
  onClose,
}: {
  session: BridgeSessionInfo;
  profiles: BridgeProviderProfile[];
  desktopLocal?: boolean;
  onPreview(targetProviderProfileId: string, model?: string): Promise<ProviderSwitchPreview>;
  onCommit(handoffId: string, targetNativeSessionId?: string, model?: string): Promise<ProviderSwitchResult>;
  onCancel(handoffId: string): Promise<void>;
  onRefresh(): Promise<void>;
  onSetApiKey?(value: string): Promise<void>;
  onRemoveApiKey?(): Promise<void>;
  onChanged(): Promise<void> | void;
  onClose(): void;
}) {
  const currentId = session.activeProviderProfileId;
  const initialTarget = session.pendingHandoff?.targetProviderProfileId
    ?? profiles.find((profile) => profile.id !== currentId && profile.status === "ready")?.id
    ?? profiles.find((profile) => profile.id !== currentId)?.id
    ?? "";
  const [targetId, setTargetId] = useState(initialTarget);
  const [model, setModel] = useState("");
  const [preview, setPreview] = useState<ProviderSwitchPreview>();
  const [handoff, setHandoff] = useState<BridgeHandoff | undefined>(session.pendingHandoff);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const target = profiles.find((profile) => profile.id === targetId);
  const activeHandoff = session.pendingHandoff ?? handoff;
  const targetModels = target?.models ?? [];
  const selectedModel = model || target?.defaultModel || targetModels[0]?.id || undefined;
  const availableTargets = useMemo(
    () => profiles.filter((profile) => profile.id !== currentId),
    [currentId, profiles],
  );

  useEffect(() => {
    if (!target || model || !target.defaultModel) return;
    setModel(target.defaultModel);
  }, [model, target]);

  useEffect(() => {
    if (session.pendingHandoff) {
      setHandoff(session.pendingHandoff);
      return;
    }
    setHandoff((current) => {
      if (
        !current ||
        ["applied", "failed", "cancelled", "expired"].includes(current.state)
      ) return current;
      if (session.routeState === "failed") {
        return {
          ...current,
          state: "failed",
          error: current.error ?? "目标通道未确认接力消息，原通道仍保持活动。",
          updatedAt: Date.now(),
        };
      }
      if (
        session.routeState === "ready" &&
        session.activeProviderProfileId === current.targetProviderProfileId
      ) {
        return { ...current, state: "applied", updatedAt: Date.now() };
      }
      return current;
    });
  }, [
    session.activeProviderProfileId,
    session.pendingHandoff,
    session.routeState,
  ]);

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

  async function createPreview(): Promise<void> {
    if (!target) return;
    await run(async () => {
      const result = await onPreview(target.id, selectedModel);
      setPreview(result);
      setHandoff(result.handoff);
    });
  }

  async function commit(targetNativeSessionId?: string): Promise<void> {
    const item = activeHandoff ?? preview?.handoff;
    if (!item) return;
    await run(async () => {
      const previewModel = preview?.handoff.handoffId === item.handoffId
        ? selectedModel
        : undefined;
      const result = await onCommit(item.handoffId, targetNativeSessionId, previewModel);
      setHandoff(result.handoff);
      await onChanged();
    });
  }

  async function cancel(): Promise<void> {
    const item = activeHandoff ?? preview?.handoff;
    if (!item) return;
    await run(async () => {
      await onCancel(item.handoffId);
      await onChanged();
      onClose();
    });
  }

  async function saveApiKey(): Promise<void> {
    if (!onSetApiKey || !apiKey.trim()) return;
    await run(async () => {
      await onSetApiKey(apiKey.trim());
      setApiKey("");
      setShowApiKey(false);
      await onRefresh();
    });
  }

  const shownHandoff = activeHandoff ?? preview?.handoff;

  return (
    <div className="modal-backdrop provider-switch-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="provider-switch-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-switch-title">
        <header>
          <div>
            <span>执行通道</span>
            <h2 id="provider-switch-title">切换提供方</h2>
          </div>
          <IconButton label="关闭" disabled={busy} onClick={onClose}><X size={18} /></IconButton>
        </header>

        <div className="provider-current">
          <span>当前</span>
          <strong>{providerName(currentId, profiles)}</strong>
          {session.routeState && session.routeState !== "ready" && <b>{session.routeState}</b>}
        </div>

        {!shownHandoff && (
          <>
            <div className="provider-options" role="radiogroup" aria-label="目标提供方">
              {availableTargets.map((profile) => (
                <label className={`provider-option ${targetId === profile.id ? "selected" : ""}`} key={profile.id}>
                  <input
                    type="radio"
                    name="provider"
                    value={profile.id}
                    checked={targetId === profile.id}
                    onChange={() => {
                      setTargetId(profile.id);
                      setModel(profile.defaultModel ?? "");
                      setPreview(undefined);
                    }}
                  />
                  <span>
                    <strong>{profile.name}</strong>
                    <small>{profile.detail}</small>
                  </span>
                  <b className={profile.status}>{profile.status === "ready" ? "可用" : "需处理"}</b>
                </label>
              ))}
            </div>

            {target?.kind === "anthropic-api" && target.status !== "ready" && (
              <div className="provider-api-setup">
                <KeyRound size={18} />
                <div>
                  <strong>{desktopLocal ? "在此电脑配置 API Key" : "需要在电脑端配置 API Key"}</strong>
                  <small>Key 不通过手机或 Relay 传输。</small>
                </div>
                {desktopLocal && onSetApiKey && (
                  <button type="button" className="secondary-button" onClick={() => setShowApiKey((value) => !value)}>
                    {showApiKey ? "收起" : "配置"}
                  </button>
                )}
              </div>
            )}
            {showApiKey && desktopLocal && (
              <div className="provider-api-key-form">
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Anthropic Console API Key"
                  aria-label="Anthropic Console API Key"
                />
                <button type="button" className="primary-button" disabled={busy || !apiKey.trim()} onClick={() => void saveApiKey()}>
                  {busy ? <LoaderCircle className="is-spinning" size={15} /> : <Check size={15} />}
                  验证并保存
                </button>
              </div>
            )}

            {targetModels.length > 0 && target?.status === "ready" && (
              <label className="provider-model-select">
                <span>目标模型</span>
                <select value={selectedModel} onChange={(event) => setModel(event.target.value)}>
                  {targetModels.map((candidate) => (
                    <option value={candidate.id} key={candidate.id}>{candidate.displayName}</option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}

        {preview && shownHandoff?.state === "previewed" && (
          <div className="provider-handoff-preview">
            <span>接力摘要</span>
            <strong>{preview.summary}</strong>
            <small>源通道会保持活动，直到目标通道确认首条接力消息。</small>
          </div>
        )}

        {shownHandoff && (
          <div className={`provider-handoff-state ${shownHandoff.state}`}>
            {shownHandoff.state === "failed" || shownHandoff.state === "expired"
              ? <AlertTriangle size={20} />
              : shownHandoff.state === "applied"
                ? <Check size={20} />
                : <LoaderCircle
                    className={busy || ["preparing", "activating"].includes(shownHandoff.state)
                      ? "is-spinning"
                      : ""}
                    size={20}
                  />}
            <span>
              <strong>{stateLabel(shownHandoff)}</strong>
              <small>{shownHandoff.error || shownHandoff.summary}</small>
            </span>
          </div>
        )}

        {shownHandoff?.state === "awaiting_target" && shownHandoff.candidateNativeSessionIds?.length && (
          <div className="provider-candidates">
            <span>选择刚创建的 Claude 官方会话</span>
            {shownHandoff.candidateNativeSessionIds.map((nativeSessionId) => (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void commit(nativeSessionId)}
                key={nativeSessionId}
              >
                {nativeSessionId.slice(0, 8)}
                <ArrowRight size={15} />
              </button>
            ))}
          </div>
        )}

        {error && <div className="provider-switch-error"><AlertTriangle size={16} />{error}</div>}

        <footer>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void onRefresh()}>
            <RefreshCw size={15} />
            刷新
          </button>
          <span />
          {target?.kind === "anthropic-api" && target.configured && desktopLocal && onRemoveApiKey && !shownHandoff && (
            <button type="button" className="danger-text-button" disabled={busy} onClick={() => void run(async () => {
              await onRemoveApiKey();
              await onRefresh();
            })}>移除 Key</button>
          )}
          {shownHandoff && !["applied", "failed", "cancelled", "expired"].includes(shownHandoff.state) && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void cancel()}>取消接力</button>
          )}
          {!shownHandoff && (
            <button
              type="button"
              className="primary-button"
              disabled={busy || !target || target.status !== "ready"}
              onClick={() => void createPreview()}
            >
              预览接力
              <ArrowRight size={15} />
            </button>
          )}
          {shownHandoff?.state === "previewed" && (
            <button type="button" className="primary-button" disabled={busy} onClick={() => void commit()}>
              确认切换
            </button>
          )}
          {["applied", "failed", "expired"].includes(shownHandoff?.state ?? "") && (
            <button type="button" className="primary-button" onClick={onClose}>完成</button>
          )}
        </footer>
      </section>
    </div>
  );
}
