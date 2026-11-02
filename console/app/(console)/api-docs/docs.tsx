'use client'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { Button, Flex } from '@radix-ui/themes'
import { Download } from 'lucide-react'
import '@scalar/api-reference-react/style.css'
import { PageHeader, Skeleton } from '@/components/ui'

const ApiReferenceReact = dynamic(() => import('@scalar/api-reference-react').then((m) => m.ApiReferenceReact), {
  ssr: false,
  loading: () => <Skeleton rows={8} />,
})

// Scalar takes the console's red and type, and follows its light/dark mode.
const CUSTOM_CSS = `
.scalar-app, .light-mode, .dark-mode {
  --scalar-color-accent: var(--accent-9);
  --scalar-font: var(--font-plex), system-ui, sans-serif;
  --scalar-font-code: var(--font-plex-mono), ui-monospace, monospace;
  --scalar-radius: 6px;
  --scalar-radius-lg: 8px;
}
.light-mode { --scalar-background-1: var(--sheet); --scalar-background-2: #f9f8f8; --scalar-border-color: var(--sheet-edge); }
.dark-mode { --scalar-background-1: var(--sheet); --scalar-background-2: #1b1b1b; --scalar-border-color: var(--sheet-edge); }
`

export default function Docs({ project, endpoint, publicKey }: { project: string; endpoint: string; publicKey: string }) {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const m = matchMedia('(prefers-color-scheme: dark)')
    const set = () => setDark(m.matches)
    set()
    m.addEventListener('change', set)
    return () => m.removeEventListener('change', set)
  }, [])

  return (
    <>
      <PageHeader
        title="API reference"
        description={`Every endpoint of ${project}, generated from its live schema, with sample payloads and responses. “Test request” calls ${endpoint} with the public key filled in.`}
        actions={<Button variant="soft" color="gray" asChild><a href="/api/openapi" download="openapi.json"><Download size={15} />OpenAPI JSON</a></Button>}
      />
      <Flex direction="column" className="-mx-4 -mb-4 sm:-mx-6 sm:-mb-6 overflow-hidden lg:rounded-b-2xl" style={{ borderTop: '1px solid var(--sheet-edge)' }}>
        <ApiReferenceReact
          configuration={{
            url: '/api/openapi',
            layout: 'modern',
            hideDarkModeToggle: true,
            forceDarkModeState: dark ? 'dark' : 'light',
            withDefaultFonts: false,
            hideClientButton: false,
            showDeveloperTools: 'never',
            documentDownloadType: 'none',
            agent: { disabled: true },
            customCss: CUSTOM_CSS,
            authentication: { preferredSecurityScheme: 'publicKey', securitySchemes: { publicKey: { value: publicKey } } },
          }}
        />
      </Flex>
    </>
  )
}
