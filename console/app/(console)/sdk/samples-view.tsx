'use client'
import { useState } from 'react'
import { Badge, Button, Card, Flex, Grid, IconButton, SegmentedControl, Text, Tooltip } from '@radix-ui/themes'
import { Check, Copy, Cpu, Download, Microchip, Terminal } from 'lucide-react'
import { KeyField, PageHeader, Tabs, useToast } from '@/components/ui'
import { highlight } from './highlight'
import { LANGUAGES, Lang, SCENARIOS, SETUP_SQL, Scenario, sample } from './samples'

export function SdkSamples({ endpoint, publicKey, project }: { endpoint: string; publicKey: string; project: string }) {
  const [scenario, setScenario] = useState<Scenario | 'setup'>('devices')
  const [lang, setLang] = useState<Lang>('js')
  const code = scenario === 'setup' ? SETUP_SQL : sample(scenario, lang, endpoint, publicKey)
  const about = scenario === 'setup' ? 'Tables, row security policies, live events and a statistics function used by the samples.' : SCENARIOS.find((s) => s.id === scenario)?.about

  return (
    <>
      <PageHeader
        title="SDKs"
        description={<>Connect apps and devices to <b>{project}</b>. Samples are filled in with this project&apos;s API address and public key; never put the secret key in an app or on a device.</>}
      />
      <Card size="2" mb="4">
        <Grid columns={{ initial: '1', md: '2' }} gap="4" align="end">
          <KeyField label="API URL" value={endpoint} />
          <KeyField label="Public API key" value={publicKey} />
        </Grid>
        <Flex mt="3" align="center" justify="between" gap="3" wrap="wrap">
          <Text size="1" color="gray">Devices that check TLS (ESP32 <code>setCACert</code>, MicroPython <code>ca_data</code>) need the root certificate of the API address.</Text>
          <RootCaButton />
        </Flex>
      </Card>
      <Grid columns={{ initial: '1', md: '3' }} gap="3" mb="5">
        <SdkCard icon={<Microchip size={18} />} title="Python device client" badge="Raspberry Pi · MicroPython"
          text="One file, standard library only. CPython on Linux boards; MicroPython 1.22+ on Pico W and ESP32." path="sdk/embedded/python/kodudb.py" />
        <SdkCard icon={<Cpu size={18} />} title="Arduino library" badge="ESP32 · ESP8266"
          text="REST, sign-in with token refresh, transactions and realtime. Arduino IDE or PlatformIO." path="sdk/embedded/arduino/KoduDB" />
        <SdkCard icon={<Terminal size={18} />} title="Any language over HTTP" badge="REST · WebSocket"
          text="Every SDK uses the same REST and realtime API, shown below. Official app SDKs are tracked in issue #34." path="API reference in the sidebar" />
      </Grid>

      <Tabs
        tabs={[...SCENARIOS.map((s) => ({ value: s.id, label: s.label })), { value: 'setup', label: 'Setup SQL' }]}
        value={scenario}
        onChange={(v) => setScenario(v as Scenario | 'setup')}
      >
        <Flex direction="column" gap="3" mt="3">
          <Text size="2" color="gray">{about}</Text>
          {scenario !== 'setup' && (
            <div className="overflow-x-auto">
              <SegmentedControl.Root value={lang} onValueChange={(v) => setLang(v as Lang)} size="1">
                {LANGUAGES.map((l) => <SegmentedControl.Item key={l.id} value={l.id}>{l.label}</SegmentedControl.Item>)}
              </SegmentedControl.Root>
            </div>
          )}
          <CodeBlock code={code} lang={scenario === 'setup' ? 'sql' : lang} label={scenario === 'setup' ? 'SQL' : LANGUAGES.find((l) => l.id === lang)?.label ?? ''} />
        </Flex>
      </Tabs>
    </>
  )
}

function RootCaButton() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const download = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/root-ca')
      if (!r.ok) return toast(((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not get the certificate')
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: 'root_ca.pem' })
      a.click()
      URL.revokeObjectURL(a.href)
    } finally {
      setBusy(false)
    }
  }
  return <Button variant="soft" color="gray" loading={busy} onClick={download}><Download size={14} />Download root_ca.pem</Button>
}

function SdkCard({ icon, title, badge, text, path }: { icon: React.ReactNode; title: string; badge: string; text: string; path: string }) {
  return (
    <Card size="2">
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2">
          <span style={{ color: 'var(--accent-9)' }}>{icon}</span>
          <Text weight="medium">{title}</Text>
        </Flex>
        <div><Badge color="gray" variant="soft">{badge}</Badge></div>
        <Text size="2" color="gray">{text}</Text>
        <Text size="1" color="gray" className="font-mono">{path}</Text>
      </Flex>
    </Card>
  )
}

function CodeBlock({ code, lang, label }: { code: string; lang: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const toast = useToast()
  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    toast(`${label} sample copied`)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="relative overflow-hidden rounded-lg border" style={{ borderColor: 'var(--gray-a5)', background: 'var(--gray-a2)' }}>
      <Flex justify="between" align="center" px="3" py="2" style={{ borderBottom: '1px solid var(--gray-a4)' }}>
        <Text size="1" color="gray">{label}</Text>
        <Tooltip content="Copy"><IconButton size="1" variant="ghost" color="gray" aria-label="Copy sample" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton></Tooltip>
      </Flex>
      <pre className="m-0 max-h-[58vh] overflow-auto p-4 text-[12.5px] leading-relaxed" style={{ fontFamily: 'var(--code-font-family)' }}><code>{highlight(code, lang)}</code></pre>
    </div>
  )
}
