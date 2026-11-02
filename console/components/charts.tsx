'use client'
// Dependency-free SVG charts: one y-axis, thin marks, hover tooltips, legend for >= 2 series.
import { useEffect, useRef, useState } from 'react'

export type Point = { t: number; values: number[] }
export type Series = { name: string; color: string }

const H = 180
const PAD = { l: 44, r: 12, t: 12, b: 24 }

const fmtTime = (t: number, spanMs: number) =>
  new Date(t).toLocaleString(undefined, spanMs > 86_400_000 ? { month: 'short', day: 'numeric', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' })

function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? v
}

/** Line chart (area under the first series when `area`) with crosshair tooltip. */
export function LineChart({ points, series, unit = '', area = false, label }: { points: Point[]; series: Series[]; unit?: string; area?: boolean; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  // viewBox matches the rendered width so text and strokes are never stretched.
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(640)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  if (!points.length) return <p className="muted">No data in this window yet.</p>
  const t0 = points[0].t
  const t1 = points[points.length - 1].t
  const span = Math.max(t1 - t0, 1)
  const max = niceMax(Math.max(...points.flatMap((p) => p.values)))
  const x = (t: number) => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b)
  const path = (i: number) => points.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.values[i]).toFixed(1)}`).join('')
  const ticks = [0, 0.5, 1].map((f) => f * max)
  const hp = hover === null ? null : points[hover]

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    const tx = t0 + ((e.clientX - r.left) / r.width) * span
    let best = 0
    points.forEach((p, i) => { if (Math.abs(p.t - tx) < Math.abs(points[best].t - tx)) best = i })
    setHover(best)
  }

  return (
    <figure className="chart" aria-label={label}>
      {series.length > 1 && (
        <figcaption className="legend">
          {series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}
        </figcaption>
      )}
      <div className="chart-box" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="gridline" />
              <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="tick">{v >= 1000 ? `${v / 1000}k` : +v.toFixed(2)}</text>
            </g>
          ))}
          <text x={PAD.l} y={H - 6} className="tick">{fmtTime(t0, span)}</text>
          <text x={W - PAD.r} y={H - 6} textAnchor="end" className="tick">{fmtTime(t1, span)}</text>
          {area && <path d={`${path(0)}L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z`} fill={series[0].color} opacity={0.14} />}
          {series.map((s, i) => <path key={s.name} d={path(i)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
          {hp && (
            <g>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={H - PAD.b} className="crosshair" />
              {series.map((s, i) => <circle key={s.name} cx={x(hp.t)} cy={y(hp.values[i])} r={4} fill={s.color} className="dot" />)}
            </g>
          )}
          <rect x={PAD.l} y={0} width={W - PAD.l - PAD.r} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        {hp && (
          <div className="tooltip" style={{ left: `${(x(hp.t) / W) * 100}%` }}>
            <strong>{fmtTime(hp.t, 0)}</strong>
            {series.map((s, i) => (
              <span key={s.name}><i style={{ background: s.color }} />{s.name}: {hp.values[i].toLocaleString()}{unit}</span>
            ))}
          </div>
        )}
      </div>
    </figure>
  )
}

/** Horizontal bars with labels and values; one color (magnitude), hover shows exact value. */
export function BarList({ items, color = 'var(--accent-9)', format = (v: number) => v.toLocaleString(), label }: { items: { name: string; value: number; note?: string }[]; color?: string; format?: (v: number) => string; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  if (!items.length) return <p className="muted">No data yet.</p>
  return (
    <ul className="barlist" aria-label={label}>
      {items.map((i) => (
        <li key={i.name} title={`${i.name}: ${format(i.value)}${i.note ? ` · ${i.note}` : ''}`}>
          <span className="bl-name">{i.name}</span>
          <span className="bl-track"><span className="bl-bar" style={{ width: `${(i.value / max) * 100}%`, background: color }} /></span>
          <span className="bl-value">{format(i.value)}</span>
        </li>
      ))}
    </ul>
  )
}
