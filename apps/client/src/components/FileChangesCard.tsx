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
 * Split an absolute path into elidable head, always-visible parent directory
 * and basename. Rows are narrow on the phone; the old single ellipsis hid the
 * file name entirely ("/Users/martinez/Documents/Claude Bridge/ap…").
 */
export function splitFilePath(path: string): { head: string; parent: string; base: string } {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return { head: "", parent: "", base: trimmed };
  const dir = trimmed.slice(0, index);
  const base = trimmed.slice(index + 1);
  const parentIndex = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
  if (parentIndex < 0) return { head: "", parent: dir, base };
  return { head: dir.slice(0, parentIndex), parent: dir.slice(parentIndex + 1), base };
}

/**
 * Codex-style aggregated edit card: one collection per session instead of
 * inline per-edit cards, rendered in the 成果 column.
 */
export function FileChangesCard({
  summary,
  onOpenFile,
}: {
  summary: FileChangesSummary;
  onOpenFile?(filePath: string): void;
}) {
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
        {shown.map((file) => {
          const parts = splitFilePath(file.path);
          const row = (
            <>
              <span className={`file-change-kind ${file.kind}`}>{KIND_LABEL[file.kind]}</span>
              <code>
                {parts.head && <span className="file-change-head">{parts.head}/</span>}
                {parts.parent && <span className="file-change-parent">{parts.parent}/</span>}
                <strong className="file-change-base">{parts.base}</strong>
              </code>
              <span className="file-change-counts">
                <b className="add">+{file.additions}</b>
                <b className="del">−{file.deletions}</b>
              </span>
            </>
          );
          return onOpenFile ? (
            <button
              type="button"
              className="file-change-row is-openable"
              key={file.path}
              title={`在电脑上打开 ${file.path}`}
              onClick={() => onOpenFile(file.path)}
            >
              {row}
            </button>
          ) : (
            <div className="file-change-row" key={file.path} title={`${KIND_LABEL[file.kind]} ${file.path}`}>
              {row}
            </div>
          );
        })}
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
