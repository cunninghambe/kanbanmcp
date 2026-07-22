import { BrandMark } from './BrandMark'

interface WordmarkProps {
  /** Font size in px for the text portion. The mark scales to size+8. */
  size?: number
}

export function Wordmark({ size = 16 }: WordmarkProps) {
  return (
    <div className="flex items-baseline gap-2">
      <BrandMark size={size + 8} />
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 600,
          fontSize: size,
          letterSpacing: '-0.01em',
          color: 'var(--fg-0)',
        }}
      >
m<span style={{ color: 'var(--accent)' }}>·</span>hud
      </span>
    </div>
  )
}
