export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" role="img" aria-label="Bridge">
      <span className="brand-mark" aria-hidden="true">
        <span className="brand-arch" />
        <span className="brand-piers" />
      </span>
      {!compact && <span className="brand-name">Bridge</span>}
    </div>
  );
}
