export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" role="img" aria-label="Bridge">
      <span className="brand-mark" aria-hidden="true">
        <img src="/bridge-mark.svg" alt="" width="32" height="32" />
      </span>
      {!compact && <span className="brand-name">Bridge</span>}
    </div>
  );
}
