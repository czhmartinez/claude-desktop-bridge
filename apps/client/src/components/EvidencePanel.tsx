import type {
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeEvidenceBundle,
  BridgeTokenUsage,
  BridgeToolEvidence,
} from "@bridge/protocol";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Code2,
  Download,
  Eye,
  File,
  FileCode2,
  FileDiff,
  FileImage,
  FileText,
  LoaderCircle,
  MoreHorizontal,
  Terminal,
  Wrench,
  X,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionEvidenceState } from "../hooks/useMobileBridge.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { desktopRuntimeName } from "../lib/runtime-labels.js";
import { IconButton } from "./IconButton.js";

function confidenceLabel(value: BridgeEvidenceBundle["confidence"]): string {
  if (value === "exact") return "精确";
  if (value === "inferred") return "事后恢复";
  return "部分";
}

function stateLabel(value: BridgeEvidenceBundle["state"]): string {
  if (value === "collecting") return "正在归档";
  if (value === "failed") return "归档失败";
  return "已归档";
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

/** Real elapsed time; callers must never pass a fabricated end for running records. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 时 ${minutes % 60} 分`;
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 10_000).toFixed(1)} 万`;
}

function usageLabel(usage: BridgeTokenUsage): string {
  const output = usage.outputTokens ?? 0;
  const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  const parts = [`输出 ${formatTokens(output)}`];
  if (input > 0) parts.unshift(`输入 ${formatTokens(input)}`);
  if ((usage.reasoningTokens ?? 0) > 0) parts.push(`推理 ${formatTokens(usage.reasoningTokens!)}`);
  return parts.join(" · ");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactIcon(artifact: BridgeArtifactManifest) {
  if (artifact.kind === "image") return <FileImage size={18} />;
  if (artifact.kind === "html") return <FileCode2 size={18} />;
  if (artifact.kind === "code") return <Code2 size={18} />;
  if (artifact.kind === "diff") return <FileDiff size={18} />;
  if (artifact.kind === "text" || artifact.kind === "log") return <FileText size={18} />;
  return <File size={18} />;
}

function changeLabel(value: BridgeArtifactManifest["changeKind"]): string {
  if (value === "created") return "新增";
  if (value === "modified") return "修改";
  if (value === "deleted") return "删除";
  if (value === "renamed") return "重命名";
  return "发现";
}

function bundleSourceLabel(bundle: BridgeEvidenceBundle): string {
  if (bundle.source === "runtime-host") {
    return bundle.runtimeId ? `${desktopRuntimeName(bundle.runtimeId)} 任务` : "运行时任务";
  }
  return bundle.source === "bridge-host" ? "Bridge 任务" : "Claude Desktop";
}

interface TimelineSelection {
  from: number;
  to: number;
}

/**
 * 轨迹式总览条：钉在成果列表上方，把每一轮的真实开始时间与耗时按时间轴
 * 从左到右投影。进行中的轮次只画开始标记，绝不虚构跨度。滚轮缩放时间域，
 * 拖选区间过滤下方列表，右键清除选择；仍有更早成果时左端保留省略号入口。
 */
function EvidenceTimeline({
  bundles,
  hasMore,
  loading,
  selection,
  onSelect,
  onLoadMore,
}: {
  bundles: BridgeEvidenceBundle[];
  hasMore: boolean;
  loading: boolean;
  selection: TimelineSelection | undefined;
  onSelect(selection: TimelineSelection | undefined): void;
  onLoadMore(): Promise<void>;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<TimelineSelection>();
  const [zoom, setZoom] = useState<{ from: number; to: number }>();

  const domain = useMemo(() => {
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const bundle of bundles) {
      from = Math.min(from, bundle.startedAt);
      // Running bundles contribute only their start tick: the domain never
      // pretends a span that has not been recorded yet.
      to = Math.max(to, bundle.completedAt ?? bundle.startedAt);
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
    if (to - from < 1_000) {
      from -= 30_000;
      to += 30_000;
    }
    return { from, to };
  }, [bundles]);

  // Reset the zoom window when the loaded range changes materially.
  useEffect(() => {
    setZoom(undefined);
  }, [domain?.from, domain?.to]);

  const view = zoom ?? domain;

  useEffect(() => {
    const track = trackRef.current;
    if (!track || !domain) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      setZoom((current) => {
        const base = current ?? domain;
        const span = base.to - base.from;
        const factor = event.deltaY > 0 ? 1.25 : 0.8;
        const nextSpan = Math.min(domain.to - domain.from, Math.max(500, span * factor));
        const anchor = base.from + span * ratio;
        let from = anchor - nextSpan * ratio;
        let to = from + nextSpan;
        if (from < domain.from) {
          from = domain.from;
          to = from + nextSpan;
        }
        if (to > domain.to) {
          to = domain.to;
          from = to - nextSpan;
        }
        if (nextSpan >= domain.to - domain.from) return undefined;
        return { from, to };
      });
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, [domain]);

  if (!domain || !view || bundles.length === 0) return null;
  const span = Math.max(1, view.to - view.from);
  const position = (at: number) => `${Math.min(100, Math.max(0, ((at - view.from) / span) * 100))}%`;
  const width = (from: number, to: number) => `${Math.max(0.6, ((to - from) / span) * 100)}%`;

  function commitDraft(next: TimelineSelection | undefined): void {
    setDraft(undefined);
    if (!next) return;
    const from = Math.min(next.from, next.to);
    const to = Math.max(next.from, next.to);
    if (to - from < span * 0.01) return;
    onSelect({ from, to });
  }

  const timestampAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return view.from;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return view.from + span * ratio;
  };

  const active = draft ?? selection;

  return (
    <section className="evidence-timeline" aria-label="成果时间轴总览">
      <header>
        <strong>总览</strong>
        <span className="evidence-timeline-range">
          {formatTime(view.from)} – {formatTime(view.to)}
        </span>
        <span className="evidence-timeline-actions">
          {hasMore && (
            <button
              type="button"
              className="evidence-timeline-more"
              disabled={loading}
              title="仍有更早成果未加载，点击补一页"
              onClick={() => void onLoadMore()}
            >
              {loading ? <LoaderCircle className="is-spinning" size={13} /> : <MoreHorizontal size={13} />}
              更早
            </button>
          )}
          {zoom && (
            <IconButton label="重置缩放" onClick={() => setZoom(undefined)}>
              <ZoomOut size={13} />
            </IconButton>
          )}
          {selection && (
            <button type="button" className="evidence-timeline-clear" onClick={() => onSelect(undefined)}>
              <X size={12} />
              清除区间
            </button>
          )}
        </span>
      </header>
      <div
        className="evidence-timeline-track"
        ref={trackRef}
        role="presentation"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const at = timestampAt(event.clientX);
          setDraft({ from: at, to: at });
        }}
        onPointerMove={(event) => {
          setDraft((current) => current ? { from: current.from, to: timestampAt(event.clientX) } : current);
        }}
        onPointerUp={(event) => {
          const at = timestampAt(event.clientX);
          commitDraft(draft ? { from: draft.from, to: at } : undefined);
        }}
        onPointerCancel={() => setDraft(undefined)}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect(undefined);
        }}
      >
        {bundles.map((bundle) => {
          const running = bundle.state === "collecting";
          return (
            <div
              key={bundle.id}
              className={`evidence-timeline-bar ${bundle.state} confidence-${bundle.confidence}`}
              style={running
                ? { left: position(bundle.startedAt), width: "5px" }
                : { left: position(bundle.startedAt), width: width(bundle.startedAt, bundle.completedAt ?? bundle.startedAt) }}
              title={running
                ? `${formatTime(bundle.startedAt)} 开始 · 进行中（耗时以实际完成为准）`
                : `${formatTime(bundle.startedAt)} · 耗时 ${formatDuration((bundle.completedAt ?? bundle.startedAt) - bundle.startedAt)}`}
            >
              {!running && bundle.tools.map((tool) => (
                <i
                  key={tool.id}
                  className={`evidence-timeline-tick ${tool.status}`}
                  style={{ left: position(tool.startedAt) }}
                />
              ))}
            </div>
          );
        })}
        {active && (
          <div
            className={`evidence-timeline-selection${draft ? " is-draft" : ""}`}
            style={{
              left: position(Math.min(active.from, active.to)),
              width: width(Math.min(active.from, active.to), Math.max(active.from, active.to)),
            }}
          />
        )}
      </div>
      {selection && (
        <p className="evidence-timeline-hint">
          聚焦 {formatClock(selection.from)} – {formatClock(selection.to)} · 仅显示与该区间有重叠的轮次
        </p>
      )}
    </section>
  );
}

/** 单条工具记录：行内检查器给出真实计时、退出码、输入与输出。 */
function EvidenceToolRow({ tool }: { tool: BridgeToolEvidence }) {
  const [open, setOpen] = useState(false);
  const duration = tool.completedAt !== undefined ? tool.completedAt - tool.startedAt : undefined;
  return (
    <article className={`evidence-tool ${tool.status}${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="evidence-tool-main"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="evidence-tool-icon"><Terminal size={16} /></span>
        <span className="evidence-tool-copy">
          <strong>{tool.toolName}</strong>
          <small>{tool.summary}</small>
        </span>
        <span className="evidence-tool-status">
          {tool.exitCode !== undefined ? `退出 ${tool.exitCode}` : tool.status === "running" ? "运行中" : tool.status === "failed" ? "失败" : "完成"}
          {duration !== undefined && <b>{formatDuration(duration)}</b>}
          {tool.truncated && <i>已截断</i>}
        </span>
        <ChevronDown className="evidence-tool-chevron" size={14} />
      </button>
      {open && (
        <div className="evidence-tool-inspector">
          <div className="evidence-tool-meta">
            <span>开始 <b>{formatClock(tool.startedAt)}</b></span>
            {duration !== undefined
              ? <span>耗时 <b>{formatDuration(duration)}</b></span>
              : <span>进行中 · 不预估耗时</span>}
            {tool.exitCode !== undefined && <span>退出码 <b>{tool.exitCode}</b></span>}
          </div>
          {tool.input && (
            <div className="evidence-tool-detail">
              <header>输入</header>
              <pre>{tool.input}</pre>
            </div>
          )}
          {tool.outputSummary && (
            <div className="evidence-tool-detail">
              <header>输出</header>
              <pre>{tool.outputSummary}</pre>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function EvidenceInlineSummary({
  evidence,
  onOpen,
  entering = false,
}: {
  evidence: BridgeEvidenceBundle;
  onOpen(): void;
  entering?: boolean;
}) {
  return (
    <button type="button" className={`evidence-inline-summary ${evidence.confidence}${entering ? " is-entering" : ""}`} onClick={onOpen}>
      <span className="evidence-inline-icon">
        {evidence.state === "collecting"
          ? <LoaderCircle className="is-spinning" size={17} />
          : evidence.state === "failed"
            ? <AlertTriangle size={17} />
            : <CheckCircle2 size={17} />}
      </span>
      <span>
        <strong>成果证据</strong>
        <small>
          {evidence.toolCount} 个工具 · {evidence.changeCount} 处文件变化 · {evidence.artifactCount} 个产物
          {evidence.usage ? ` · ${usageLabel(evidence.usage)}` : ""}
        </small>
      </span>
      <b>{confidenceLabel(evidence.confidence)}</b>
    </button>
  );
}

export function EvidencePanel({
  state,
  previews,
  transfers,
  online,
  suppressEmpty = false,
  onLoadMore,
  onPreview,
  onDownload,
}: {
  state: SessionEvidenceState | undefined;
  previews: Record<string, BridgeArtifactPreview>;
  transfers: Record<string, number>;
  online: boolean;
  /** The aggregated file-changes card already covers the empty state. */
  suppressEmpty?: boolean;
  onLoadMore(): Promise<void>;
  onPreview(artifactId: string): Promise<BridgeArtifactPreview>;
  onDownload(artifact: BridgeArtifactManifest): Promise<void>;
}) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>();
  const [previewBusy, setPreviewBusy] = useState<string>();
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<TimelineSelection>();
  // The newest bundle starts open; a stable id keeps native <details> toggles
  // untouched by later re-renders (selection changes must not close them).
  const initialOpenId = useRef<string | null>(null);
  const artifacts = useMemo(
    () => state?.items.flatMap((bundle) => bundle.artifacts) ?? [],
    [state?.items],
  );
  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId);
  const selectedPreview = selectedArtifactId ? previews[selectedArtifactId] : undefined;

  const items = state?.items ?? [];
  if (initialOpenId.current === null && items.length > 0) {
    initialOpenId.current = items[0]?.id ?? null;
  }
  const visibleItems = useMemo(() => {
    if (!selection) return items;
    return items.filter((bundle) => {
      const end = bundle.completedAt ?? Date.now();
      return bundle.startedAt <= selection.to && end >= selection.from;
    });
  }, [items, selection]);

  useEffect(() => {
    if (selectedArtifactId && !selectedArtifact) setSelectedArtifactId(undefined);
  }, [selectedArtifact, selectedArtifactId]);

  useEffect(() => {
    if (!selectedArtifactId) return undefined;
    return registerMobileBackHandler(() => {
      setSelectedArtifactId(undefined);
      return true;
    }, 200);
  }, [selectedArtifactId]);

  async function openPreview(artifact: BridgeArtifactManifest): Promise<void> {
    setError("");
    if (previews[artifact.id]) {
      setSelectedArtifactId(artifact.id);
      return;
    }
    setPreviewBusy(artifact.id);
    try {
      await onPreview(artifact.id);
      setSelectedArtifactId(artifact.id);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "成果预览失败");
    } finally {
      setPreviewBusy(undefined);
    }
  }

  async function download(artifact: BridgeArtifactManifest): Promise<void> {
    setError("");
    try {
      await onDownload(artifact);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "成果下载失败");
    }
  }

  if (state?.status === "loading" && state.items.length === 0) {
    return <div className="evidence-empty"><LoaderCircle className="is-spinning" size={20} /><strong>正在读取成果证据</strong></div>;
  }
  if (state?.status === "error" && state.items.length === 0) {
    return <div className="evidence-empty"><AlertTriangle size={20} /><strong>成果清单暂时无法读取</strong></div>;
  }
  if (!state || state.items.length === 0) {
    if (suppressEmpty) return null;
    return <div className="evidence-empty"><FileDiff size={22} /><strong>这个会话还没有成果证据</strong></div>;
  }

  return (
    <section className="evidence-panel">
      {error && <div className="evidence-error"><AlertTriangle size={16} />{error}</div>}
      {!online && <div className="evidence-offline">主机离线 · 已缓存预览仍可打开</div>}
      <EvidenceTimeline
        bundles={items}
        hasMore={state.hasMore}
        loading={state.status === "loading"}
        selection={selection}
        onSelect={setSelection}
        onLoadMore={onLoadMore}
      />
      <div className="evidence-bundles">
        {visibleItems.length === 0 && (
          <div className="evidence-bundle-empty evidence-filtered-empty">
            所选区间没有覆盖任何轮次
            <button type="button" className="secondary-button" onClick={() => setSelection(undefined)}>清除区间</button>
          </div>
        )}
        {visibleItems.map((bundle) => {
          // items arrive newest-first; numbering is absolute only once the
          // full history is loaded (prefix pages would renumber everything).
          const turnNumber = state.hasMore ? undefined : items.length - items.indexOf(bundle);
          const duration = bundle.completedAt !== undefined ? bundle.completedAt - bundle.startedAt : undefined;
          return (
            <details className={`evidence-bundle ${bundle.confidence}`} open={bundle.id === initialOpenId.current} key={bundle.id}>
              <summary>
                <span className="evidence-state-icon">
                  {bundle.state === "collecting"
                    ? <LoaderCircle className="is-spinning" size={17} />
                    : bundle.state === "failed"
                      ? <AlertTriangle size={17} />
                      : <CheckCircle2 size={17} />}
                </span>
                <span className="evidence-bundle-title">
                  <strong>{turnNumber !== undefined ? `第 ${turnNumber} 轮 · ` : ""}{formatTime(bundle.startedAt)}</strong>
                  <small>{bundleSourceLabel(bundle)} · {stateLabel(bundle.state)}</small>
                </span>
                <span className="evidence-counts">
                  <b>{bundle.toolCount}</b> 工具
                  <b>{bundle.changeCount}</b> 变化
                  <b>{bundle.artifactCount}</b> 产物
                </span>
                {bundle.usage && (
                  <span className="evidence-usage" title={usageLabel(bundle.usage)}>
                    {formatTokens(
                      (bundle.usage.inputTokens ?? 0) +
                      (bundle.usage.cacheReadTokens ?? 0) +
                      (bundle.usage.outputTokens ?? 0),
                    )} tok
                  </span>
                )}
                {duration !== undefined && (
                  <span className="evidence-duration">{formatDuration(duration)}</span>
                )}
                <span className={`evidence-confidence ${bundle.confidence}`}>{confidenceLabel(bundle.confidence)}</span>
                <ChevronDown className="evidence-chevron" size={17} />
              </summary>
              <div className="evidence-bundle-body">
                {bundle.warnings.length > 0 && (
                  <div className="evidence-warnings">
                    {bundle.warnings.map((warning) => <span key={warning}><AlertTriangle size={14} />{warning}</span>)}
                  </div>
                )}
                {bundle.usage && (
                  <div className="evidence-usage-detail">
                    <span>Token 用量</span>
                    <strong>{usageLabel(bundle.usage)}</strong>
                  </div>
                )}
                {bundle.tools.length > 0 && (
                  <section className="evidence-section">
                    <header><Wrench size={16} /><strong>工具与命令</strong></header>
                    <div className="evidence-tool-list">
                      {bundle.tools.map((tool) => <EvidenceToolRow tool={tool} key={tool.id} />)}
                    </div>
                  </section>
                )}
                {bundle.artifacts.length > 0 && (
                  <section className="evidence-section">
                    <header><FileDiff size={16} /><strong>文件与产物</strong></header>
                    <div className="evidence-artifact-list">
                      {bundle.artifacts.map((artifact) => {
                        const cached = Boolean(previews[artifact.id]);
                        const previewable = artifact.previewMode !== "none"
                          && artifact.availability !== "blocked";
                        const progress = transfers[artifact.id];
                        return (
                          <article className={`evidence-artifact ${artifact.availability}`} key={artifact.id}>
                            <span className="evidence-artifact-icon">{artifactIcon(artifact)}</span>
                            <span className="evidence-artifact-copy">
                              <strong>{artifact.name}</strong>
                              <small title={artifact.relativePath}>
                                {changeLabel(artifact.changeKind)} · {
                                  artifact.changeKind === "observed" &&
                                  artifact.availability === "current-file" &&
                                  artifact.size === 0
                                    ? "打开时校验"
                                    : formatBytes(artifact.size)
                                } · {artifact.relativePath}
                              </small>
                              {artifact.blockedReason && <i>{artifact.blockedReason}</i>}
                              {progress !== undefined && (
                                <span className="evidence-transfer-progress">
                                  <i style={{ width: `${Math.round(progress * 100)}%` }} />
                                </span>
                              )}
                            </span>
                            <span className="evidence-artifact-actions">
                              {previewable && (
                                <IconButton
                                  label={cached ? `打开 ${artifact.name} 的缓存预览` : `预览 ${artifact.name}`}
                                  disabled={Boolean(previewBusy) || (!online && !cached)}
                                  onClick={() => void openPreview(artifact)}
                                >
                                  {previewBusy === artifact.id
                                    ? <LoaderCircle className="is-spinning" size={17} />
                                    : <Eye size={17} />}
                                </IconButton>
                              )}
                              {artifact.downloadAllowed && (
                                <IconButton
                                  label={`下载 ${artifact.name}`}
                                  disabled={!online || progress !== undefined}
                                  onClick={() => void download(artifact)}
                                >
                                  {progress !== undefined
                                    ? <LoaderCircle className="is-spinning" size={17} />
                                    : <Download size={17} />}
                                </IconButton>
                              )}
                            </span>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}
                {bundle.tools.length === 0 && bundle.artifacts.length === 0 && (
                  <div className="evidence-bundle-empty">本轮没有可恢复的工具或文件成果</div>
                )}
              </div>
            </details>
          );
        })}
      </div>
      {state.hasMore && (
        <button type="button" className="load-older-button" disabled={state.status === "loading"} onClick={() => void onLoadMore()}>
          {state.status === "loading" && <LoaderCircle className="is-spinning" size={15} />}
          加载更早成果
        </button>
      )}
      {selectedArtifact && selectedPreview && (
        <div className="artifact-preview-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedArtifactId(undefined);
        }}>
          <section className="artifact-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="artifact-preview-title">
            <header>
              <div>
                <span>{selectedArtifact.relativePath}</span>
                <h2 id="artifact-preview-title">{selectedArtifact.name}</h2>
              </div>
              <IconButton label="关闭预览" onClick={() => setSelectedArtifactId(undefined)}><X size={19} /></IconButton>
            </header>
            <div className={`artifact-preview-content ${selectedPreview.mode}`}>
              {selectedPreview.encoding === "base64" ? (
                <img
                  alt={selectedArtifact.name}
                  src={`data:${selectedPreview.mimeType};base64,${selectedPreview.data}`}
                />
              ) : (
                <pre>{selectedPreview.data}</pre>
              )}
            </div>
            <footer>
              <span>{selectedPreview.truncated ? "预览已截断" : formatBytes(selectedArtifact.size)}</span>
              {selectedArtifact.downloadAllowed && (
                <button type="button" className="secondary-button" disabled={!online} onClick={() => void download(selectedArtifact)}>
                  <Download size={16} />下载
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
