'use client'
// Theme-aware wrappers around the vendored React Bits backgrounds. Canvas colours cannot read CSS
// variables, so each theme gets explicit hex values (Radix red 9 and neutral greys).
import { useEffect, useState } from 'react'
import DotGrid from './react-bits/DotGrid'
import Waves from './react-bits/Waves'

function useDark() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const html = document.documentElement
    const read = () => setDark(html.classList.contains('dark'))
    read()
    const mo = new MutationObserver(read)
    mo.observe(html, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark
}

const PALETTE = {
  light: { line: '#e2dcdc', accent: '#e5484d', dot: '#e3dddd', dotActive: '#e5484d' },
  dark: { line: '#3a3335', accent: '#e5484d', dot: '#262222', dotActive: '#e5484d' },
}

/** Sign-in: flowing lines in the brand red that bend around the pointer. */
export function SignInBackground() {
  const dark = useDark()
  const c = PALETTE[dark ? 'dark' : 'light']
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-0">
      <Waves
        key={dark ? 'd' : 'l'}
        lineColor={c.line}
        accentColor={c.accent}
        lightMode={!dark}
        spacing={18}
        amplitude={28}
        speed={0.45}
        mouseRadius={200}
        mouseStrength={0.8}
        clickRipple={false}
        fade={0.35}
        opacity={dark ? 1 : 0.55}
        className="h-full w-full"
      />
    </div>
  )
}

/** Console frame: a still dot field around the work sheet that leans toward the pointer. */
export function ShellBackground() {
  const dark = useDark()
  const c = PALETTE[dark ? 'dark' : 'light']
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
      <DotGrid
        key={dark ? 'd' : 'l'}
        dotSize={2}
        gap={22}
        baseColor={c.dot}
        activeColor={c.dotActive}
        proximity={110}
        strength={0.5}
        swell={0.6}
        glow={0}
        intro={false}
        clickShock={false}
        opacity={1}
        className="h-full w-full"
      />
    </div>
  )
}
