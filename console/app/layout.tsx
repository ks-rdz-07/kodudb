import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import './globals.css'

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-plex' })
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono' })

export const metadata: Metadata = { title: 'KoduDB Console', description: 'Postgres backend platform: data, identity, files, live events and migrations.' }

// Follows the OS light/dark preference before first paint, and live afterwards.
const themeScript = `(function(){var m=matchMedia('(prefers-color-scheme: dark)');function s(){document.documentElement.classList.toggle('dark',m.matches)}s();m.addEventListener('change',s)})()`

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
