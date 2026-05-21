interface BrandMarkProps {
  size?: number
}

export function BrandMark({ size = 28 }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <rect x="0.5" y="0.5" width="63" height="63" stroke="currentColor" strokeWidth="1" fill="none" />
      <path
        d="M0 8 L4 8 M0 56 L4 56 M60 8 L64 8 M60 56 L64 56 M8 0 L8 4 M56 0 L56 4 M8 60 L8 64 M56 60 L56 64"
        stroke="currentColor"
        strokeWidth="1"
      />
      {/* three-bar kanban glyph */}
      <rect x="14" y="18" width="8" height="28" fill="currentColor" />
      <rect x="28" y="18" width="8" height="18" fill="currentColor" />
      <rect x="42" y="18" width="8" height="34" fill="var(--accent)" />
      <rect x="49" y="49" width="6" height="6" fill="var(--accent)" />
    </svg>
  )
}
