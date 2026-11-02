'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Avatar, Button, DropdownMenu, Dialog, Flex, IconButton, Kbd, ScrollArea, Text, TextField } from '@radix-ui/themes'
import { ChevronDown, LogOut, Menu, Search, Table2, X } from 'lucide-react'
import { kodu, TableInfo } from '@/lib/api'
import { Logo } from '@/components/logo'
import { Brand, NavLinks, signOut } from './nav'
import ProjectSwitcher from './project-switcher'
import { NAV } from './nav-items'

type Hit = { label: string; hint: string; href: string; table?: boolean }

/** Ctrl/Cmd+K: jump to any console page or straight into a table. */
function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [tables, setTables] = useState<string[]>([])
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (open) {
      setQ('')
      setActive(0)
      kodu<TableInfo[]>('meta/v1/tables').then((t) => setTables(t.map((x) => x.name)), () => setTables([]))
    }
  }, [open])

  const hits = useMemo<Hit[]>(() => {
    const pages = NAV.flatMap((g) => g.items.map((i) => ({ label: i.label, hint: g.group, href: i.href })))
    const tbl = tables.map((t) => ({ label: t, hint: 'Table', href: `/tables?t=${encodeURIComponent(t)}`, table: true }))
    const s = q.trim().toLowerCase()
    return [...pages, ...tbl].filter((h) => !s || h.label.toLowerCase().includes(s)).slice(0, 12)
  }, [q, tables])

  const go = (h: Hit) => {
    onOpenChange(false)
    router.push(h.href)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="560px" className="!p-0" aria-describedby={undefined}>
        <Dialog.Title className="sr-only">Search the console</Dialog.Title>
        <div className="p-3">
          <TextField.Root
            autoFocus size="3" placeholder="Search pages and tables…" value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
              if (e.key === 'Enter' && hits[active]) go(hits[active])
            }}
          >
            <TextField.Slot><Search size={16} /></TextField.Slot>
          </TextField.Root>
        </div>
        <ScrollArea type="auto" style={{ maxHeight: 360 }}>
          <ul role="listbox" aria-label="Results" className="px-2 pb-2">
            {hits.map((h, i) => (
              <li key={h.href} role="option" aria-selected={i === active}>
                <Button
                  variant={i === active ? 'soft' : 'ghost'}
                  color="gray"
                  size="2"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                  className="!m-0 !flex !w-full !justify-between"
                >
                  <span className="flex items-center gap-2" style={{ color: 'var(--gray-12)' }}>{h.table && <Table2 size={14} />}{h.label}</span>
                  <Text size="1" color="gray">{h.hint}</Text>
                </Button>
              </li>
            ))}
            {!hits.length && <li className="px-3 py-6"><Text size="2" color="gray">No page or table matches “{q}”.</Text></li>}
          </ul>
        </ScrollArea>
      </Dialog.Content>
    </Dialog.Root>
  )
}

/** The signed-in console user: avatar and name, with sign-out. */
function Profile({ user }: { user: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Button variant="ghost" color="gray" aria-label={`Signed in as ${user}`} className="!m-0">
          <Avatar size="1" radius="full" fallback={user.slice(0, 1).toUpperCase()} />
          <Text size="2" weight="medium" className="hidden max-w-[140px] truncate sm:inline" style={{ color: 'var(--gray-12)' }}>{user}</Text>
          <ChevronDown size={14} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" variant="soft">
        <div className="px-3 py-2">
          <Text as="div" size="2" weight="medium">{user}</Text>
          <Text as="div" size="1" color="gray">Console admin</Text>
        </div>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={signOut}><LogOut size={14} />Sign out</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}

export default function TopBar({ user }: { user: string }) {
  const [palette, setPalette] = useState(false)
  const [menu, setMenu] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <header className="kd-top">
      <div className="flex items-center gap-2 lg:hidden">
        <IconButton variant="ghost" color="gray" aria-label="Open menu" onClick={() => setMenu(true)}><Menu size={18} /></IconButton>
        <Logo size={20} />
      </div>
      <div className="flex flex-1 justify-center">
        <Button variant="surface" color="gray" onClick={() => setPalette(true)} className="!w-full !max-w-[548px] !justify-start" style={{ background: 'var(--sheet)' }}>
          <Search size={14} />
          <Text size="2" color="gray" className="flex-1 text-left">Search pages and tables</Text>
          <Kbd size="1">Ctrl K</Kbd>
        </Button>
      </div>
      <div className="flex justify-end lg:w-[120px]"><Profile user={user} /></div>

      <CommandPalette open={palette} onOpenChange={setPalette} />

      <Dialog.Root open={menu} onOpenChange={setMenu}>
        <Dialog.Content className="!fixed !inset-0 !m-0 !max-h-none !max-w-none !rounded-none" aria-describedby={undefined}>
          <Flex justify="between" align="center" mb="3">
            <Dialog.Title className="!m-0"><Brand /></Dialog.Title>
            <Dialog.Close><IconButton variant="ghost" color="gray" aria-label="Close menu"><X size={18} /></IconButton></Dialog.Close>
          </Flex>
          <ProjectSwitcher />
          <nav aria-label="Console" className="mt-2 flex flex-col gap-0.5"><NavLinks onNavigate={() => setMenu(false)} /></nav>
        </Dialog.Content>
      </Dialog.Root>
    </header>
  )
}
