import Nav from './nav'
import TopBar from './top-bar'
import { Providers } from '@/components/ui'
import { ShellBackground } from '@/components/backgrounds'
import { username } from '@/lib/session'

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <ShellBackground />
      <div className="kd-shell">
        <Nav />
        <TopBar user={await username()} />
        <main className="kd-sheet">{children}</main>
      </div>
    </Providers>
  )
}
