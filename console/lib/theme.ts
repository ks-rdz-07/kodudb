'use client'
import { useEffect, useState } from 'react'

// Light/dark preference: 'system' follows the OS. The pre-paint script in app/layout.tsx applies it first.
export type ThemePref = 'light' | 'dark' | 'system'
export const THEME_KEY = 'kodudb-theme'

export const themePref = (): ThemePref => (localStorage.getItem(THEME_KEY) as ThemePref | null) ?? 'system'

export function setThemePref(p: ThemePref) {
  localStorage.setItem(THEME_KEY, p)
  document.documentElement.classList.toggle('dark', p === 'dark' || (p === 'system' && matchMedia('(prefers-color-scheme: dark)').matches))
}

/** Whether the console is dark right now (null until mounted), following the <html class="dark"> switch. */
export function useDark() {
  const [dark, setDark] = useState<boolean | null>(null)
  useEffect(() => {
    const el = document.documentElement
    const read = () => setDark(el.classList.contains('dark'))
    read()
    const o = new MutationObserver(read)
    o.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => o.disconnect()
  }, [])
  return dark
}
