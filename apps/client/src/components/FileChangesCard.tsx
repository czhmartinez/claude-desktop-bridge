import { ChevronDown, ChevronUp, FilePenLine } from "lucide-react";
import { useState } from "react";
import type { FileChangesSummary } from "./MobileWorkspace.js";

const COLLAPSED_ROWS = 5;

const KIND_LABEL = {
  add: "新增",
  delete: "删除",
  update: "修改",
} as const;

/**
 * Codex-style aggregated edit card: one collection per session instead of
 * inline per-edit cards, rendered in the 成果 column.
 */
export function FileChangesCard({ summary }: { summary: FileChangesSummary }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? summary.files : summary.files.slice(0, COLLAPSED_ROWS);
  const hiddenCount = summary.files.length - shown.length;
  return (
    <section className="file-changes-card" aria-label={`已编辑 ${summary.files.length} 个文件`}>
      <header>
        <span className="file-changes-icon"><FilePenLine size={17} /></span>
        <span className="file-changes-title">
          <strong>已编辑 {summary.files.length} 个文件</strong>
          <small>本会话累计变更</small>
        </span>
        <span className="file-changes-total">
          <b className="add">+{summary.totalAdditions}</b>
          <b className="del">−{summary.totalDeletions}</b>
        </span>
      </header>
      <div className="file-changes-rows">
        {shown.map((file) => (
          <div className="file-change-row" key={file.path} title={`${KIND_LABEL[file.kind]} ${file.path}`}>
            <span className={`file-change-kind ${file.kind}`}>{KIND_LABEL[file.kind]}</span>
            <code>{file.path}</code>
            <span className="file-change-counts">
              <b className="add">+{file.additions}</b>
              <b className="del">−{file.deletions}</b>
            </span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button type="button" className="file-changes-more" onClick={() => setExpanded(true)}>
          再显示 {hiddenCount} 个文件 <ChevronDown size={14} />
        </button>
      )}
      {expanded && summary.files.length > COLLAPSED_ROWS && (
        <button type="button" className="file-changes-more" onClick={() => setExpanded(false)}>
          收起 <ChevronUp size={14} />
        </button>
      )}
    </section>
  );
}
