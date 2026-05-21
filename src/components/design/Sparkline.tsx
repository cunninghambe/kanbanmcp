interface SprintBurndownProps {
  /** Remaining points per day (actual, including future as projections) */
  points: number[]
  /** Total points at start of sprint */
  total: number
  /** Day labels (e.g. ["mon","tue",...]) */
  dayLabels: string[]
  /** Index of today (0-based); bars at or after this are rendered as projected */
  todayIndex: number
}

/**
 * Sprint burndown bar chart — custom SVG, no charting library.
 * Renders remaining-points bars per day with a dashed ideal-burndown overlay.
 * Bars past todayIndex are styled as projected (dashed outline, lighter fill).
 * Does not fetch data; receives all values as props.
 */
export function SprintBurndown({ points, total, dayLabels, todayIndex }: SprintBurndownProps) {
  const H = 70
  const BAR_GAP = 3

  if (total === 0 || points.length === 0) return null

  const n = points.length
  const barW = `${(100 / n).toFixed(2)}%`

  return (
    <div>
      {/* bar chart */}
      <div
        style={{ display: 'flex', alignItems: 'flex-end', gap: BAR_GAP, height: H }}
        aria-hidden="true"
      >
        {points.map((v, i) => {
          const pct = Math.max(0, Math.min(1, v / total))
          const isProjected = i > todayIndex
          return (
            <div
              key={i}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                height: '100%',
              }}
            >
              <div
                style={{
                  height: `${(pct * 100).toFixed(1)}%`,
                  background: isProjected ? 'var(--bg-3)' : 'var(--fg-1)',
                  borderTop: isProjected ? '1px dashed var(--line-strong)' : undefined,
                  minHeight: pct > 0 ? 2 : 0,
                }}
              />
            </div>
          )
        })}
      </div>

      {/* day labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        {dayLabels.map((d, i) => (
          <span
            key={i}
            className="km-mono"
            style={{
              fontSize: 9,
              color: i === todayIndex ? 'var(--fg-1)' : 'var(--fg-3)',
              letterSpacing: '0.06em',
            }}
          >
            {d}
          </span>
        ))}
      </div>
    </div>
  )
}
