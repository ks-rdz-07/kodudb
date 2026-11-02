'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Flex, Text } from '@radix-ui/themes'
import { Logo } from '@/components/logo'
import ProjectSwitcher from './project-switcher'
import { NAV, isActive } from './nav-items'

export async function signOut() {
  await fetch('/api/login', { method: 'DELETE' })
  window.location.href = '/login'
}

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname()
  return (
    <>
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="kd-group">{g.group}</div>
          {g.items.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className="kd-nav" aria-current={isActive(path, href) ? 'page' : undefined} onClick={onNavigate}>
              <Icon aria-hidden />
              {label}
            </Link>
          ))}
        </div>
      ))}
    </>
  )
}

export function Brand() {
  return (
    <Flex align="center" gap="2" px="2" py="1">
      <Logo />
      <Text size="3" weight="bold" className="tracking-tight">KoduDB</Text>
    </Flex>
  )
}

export default function Nav() {
  return (
    <nav className="kd-side" aria-label="Console">
      <Brand />
      <div className="mt-3 px-1"><ProjectSwitcher /></div>
      <NavLinks />
    </nav>
  )
}
