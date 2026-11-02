import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import './globals.css'

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-plex' })
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono' })

export const metadata: Metadata = { title: 'KoduDB Console', description: 'Postgres backend platform: data, identity, files, live events and migrations.' }

// Applies the saved light/dark choice (or the OS preference for 'system') before first paint, and follows OS changes.
const themeScript = `(function(){var m=matchMedia('(prefers-color-scheme: dark)');function s(){var p=localStorage.getItem('kodudb-theme')||'system';document.documentElement.classList.toggle('dark',p==='dark'||(p==='system'&&m.matches))}s();m.addEventListener('change',s)})()`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Theme accentColor="red" grayColor="gray" radius="medium" scaling="100%" appearance="inherit" panelBackground="solid">
          {children}
        </Theme>
      </body>
    </html>
  )
}
