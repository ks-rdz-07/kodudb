import {
  Activity, BookOpen, Braces, Database, FileClock, FolderKanban, GitBranch, HardDrive, LayoutDashboard,
  Plug, Radio, ScrollText, Table2, Users,
} from 'lucide-react'

// KoduDB's own vocabulary for every destination.
export const NAV = [
  {
    group: 'Project',
    items: [
      { href: '/', label: 'Overview', icon: LayoutDashboard },
      { href: '/projects', label: 'Projects & keys', icon: FolderKanban },
      { href: '/versions', label: 'Migrations', icon: GitBranch },
    ],
  },
  {
    group: 'Build',
    items: [
      { href: '/tables', label: 'Data explorer', icon: Table2 },
      { href: '/sql', label: 'Query console', icon: Braces },
      { href: '/database', label: 'Schema', icon: Database },
      { href: '/auth', label: 'Identity', icon: Users },
      { href: '/storage', label: 'Files', icon: HardDrive },
      { href: '/realtime', label: 'Live events', icon: Radio },
    ],
  },
  {
    group: 'Observe',
    items: [
      { href: '/metrics', label: 'Metrics', icon: Activity },
      { href: '/logs', label: 'Request logs', icon: ScrollText },
      { href: '/history', label: 'Change log', icon: FileClock },
    ],
  },
  {
    group: 'Connect',
    items: [
      { href: '/connectors', label: 'Data sources', icon: Plug },
      { href: '/api-docs', label: 'API reference', icon: BookOpen },
    ],
  },
] as const

export const isActive = (path: string, href: string) => (href === '/' ? path === '/' : path.startsWith(href))
