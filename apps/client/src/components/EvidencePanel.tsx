import type {
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeEvidenceBundle,
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
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SessionEvidenceState } from "../hooks/useMobileBridge.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
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

export function EvidenceInlineSummary({
  evidence,
  onOpen,
}: {
  evidence: BridgeEvidenceBundle;
  onOpen(): void;
}) {
  return (
    <button type="button" className={`evidence-inline-summary ${evidence.confidence}`} onClick={onOpen}>
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
  onLoadMore,
  onPreview,
  onDownload,
}: {
  state: SessionEvidenceState | undefined;
  previews: Record<string, BridgeArtifactPreview>;
  transfers: Record<string, number>;
  online: boolean;
  onLoadMore(): Promise<void>;
  onPreview(artifactId: string): Promise<BridgeArtifactPreview>;
  onDownload(artifact: BridgeArtifactManifest): Promise<void>;
}) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>();
  const [previewBusy, setPreviewBusy] = useState<string>();
  const [error, setError] = useState("");
  const artifacts = useMemo(
    () => state?.items.flatMap((bundle) => bundle.artifacts) ?? [],
    [state?.items],
  );
  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId);
  const selectedPreview = selectedArtifactId ? previews[selectedArtifactId] : undefined;

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
    return <div className="evidence-empty"><FileDiff size={22} /><strong>这个会话还没有成果证据</strong></div>;
  }

  return (
    <section className="evidence-panel">
      {error && <div className="evidence-error"><AlertTriangle size={16} />{error}</div>}
      {!online && <div className="evidence-offline">主机离线 · 已缓存预览仍可打开</div>}
      <div className="evidence-bundles">
        {state.items.map((bundle, index) => (
          <details className={`evidence-bundle ${bundle.confidence}`} open={index === 0} key={bundle.id}>
            <summary>
              <span className="evidence-state-icon">
                {bundle.state === "collecting"
                  ? <LoaderCircle className="is-spinning" size={17} />
                  : bundle.state === "failed"
                    ? <AlertTriangle size={17} />
                    : <CheckCircle2 size={17} />}
              </span>
              <span className="evidence-bundle-title">
                <strong>{formatTime(bundle.startedAt)}</strong>
                <small>{bundle.source === "bridge-host" ? "Bridge 任务" : "Claude Desktop"} · {stateLabel(bundle.state)}</small>
              </span>
              <span className="evidence-counts">
                <b>{bundle.toolCount}</b> 工具
                <b>{bundle.changeCount}</b> 变化
                <b>{bundle.artifactCount}</b> 产物
              </span>
              <span className={`evidence-confidence ${bundle.confidence}`}>{confidenceLabel(bundle.confidence)}</span>
              <ChevronDown className="evidence-chevron" size={17} />
            </summary>
            <div className="evidence-bundle-body">
              {bundle.warnings.length > 0 && (
                <div className="evidence-warnings">
                  {bundle.warnings.map((warning) => <span key={warning}><AlertTriangle size={14} />{warning}</span>)}
                </div>
              )}
              {bundle.tools.length > 0 && (
                <section className="evidence-section">
                  <header><Wrench size={16} /><strong>工具与命令</strong></header>
                  <div className="evidence-tool-list">
                    {bundle.tools.map((tool) => (
                      <article className={`evidence-tool ${tool.status}`} key={tool.id}>
                        <span className="evidence-tool-icon"><Terminal size={16} /></span>
                        <span className="evidence-tool-copy">
                          <strong>{tool.toolName}</strong>
                          <small>{tool.summary}</small>
                          {tool.outputSummary && <pre>{tool.outputSummary}</pre>}
                        </span>
                        <span className="evidence-tool-status">
                          {tool.exitCode !== undefined ? `退出 ${tool.exitCode}` : tool.status === "running" ? "运行中" : tool.status === "failed" ? "失败" : "完成"}
                          {tool.truncated && <i>已截断</i>}
                        </span>
                      </article>
                    ))}
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
        ))}
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
