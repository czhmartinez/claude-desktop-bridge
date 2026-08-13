import { Check, Laptop, LoaderCircle, ShieldCheck, Smartphone } from "lucide-react";
import type { PairingSyncStage, PairingSyncState } from "../hooks/useMobileBridge.js";
import { BrandMark } from "./BrandMark.js";

const STAGES: Array<{ stage: PairingSyncStage; label: string }> = [
  { stage: "connecting", label: "建立安全连接" },
  { stage: "verifying", label: "确认电脑身份" },
  { stage: "syncing", label: "同步项目与会话" },
];

const STAGE_ORDER: Record<PairingSyncStage, number> = {
  connecting: 0,
  verifying: 1,
  syncing: 2,
  ready: 3,
};

function presentation(stage: PairingSyncStage): { title: string; description: string } {
  switch (stage) {
    case "connecting":
      return {
        title: "正在建立安全连接",
        description: "已识别二维码，正在连接电脑。",
      };
    case "verifying":
      return {
        title: "正在验证电脑身份",
        description: "正在确认这台电脑与二维码匹配。",
      };
    case "syncing":
      return {
        title: "扫码连接成功，正在同步",
        description: "正在加载最新的项目、会话和动态。",
      };
    case "ready":
      return {
        title: "同步完成",
        description: "已准备好打开你的电脑。",
      };
  }
}

export function PairingSyncScreen({ sync }: { sync: PairingSyncState }) {
  const copy = presentation(sync.stage);
  const currentStage = STAGE_ORDER[sync.stage];

  return (
    <main className="pairing-shell pairing-sync-shell">
      <header className="pairing-header">
        <BrandMark />
      </header>
      <section className="pairing-panel pairing-sync-panel" aria-labelledby="pairing-sync-title">
        <div className={`pairing-sync-devices is-${sync.stage}`} aria-hidden="true">
          <span className="pairing-sync-device"><Smartphone size={25} strokeWidth={1.8} /></span>
          <span className="pairing-sync-link"><i /></span>
          <span className="pairing-sync-device"><Laptop size={27} strokeWidth={1.8} /></span>
          <span className="pairing-sync-seal"><ShieldCheck size={18} strokeWidth={2} /></span>
        </div>
        <div className="eyebrow">{sync.desktopName}</div>
        <h1 id="pairing-sync-title" aria-live="polite">{copy.title}</h1>
        <p>{copy.description}</p>
        <div className="pairing-sync-progress" aria-live="polite">
          <div className="pairing-sync-progress-copy">
            <span>同步进度</span>
            <strong>{sync.progress}%</strong>
          </div>
          <div
            className="pairing-sync-progress-track"
            role="progressbar"
            aria-label="同步进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={sync.progress}
          >
            <span className="pairing-sync-progress-fill" style={{ width: `${sync.progress}%` }} />
          </div>
        </div>
        <ol className="pairing-sync-stages" aria-label="同步阶段">
          {STAGES.map((item, index) => {
            const complete = currentStage > index;
            const active = currentStage === index;
            return (
              <li className={complete ? "is-complete" : active ? "is-active" : undefined} key={item.stage}>
                <span className="pairing-sync-stage-icon">
                  {complete ? <Check size={13} strokeWidth={2.4} /> : active ? <LoaderCircle size={14} className="is-spinning" /> : <i />}
                </span>
                <span>{item.label}</span>
              </li>
            );
          })}
        </ol>
      </section>
      <footer className="pairing-footer">配对信息仅保存在这台手机上</footer>
    </main>
  );
}
