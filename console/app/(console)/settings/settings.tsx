'use client'
import { useEffect, useState } from 'react'
import { Button, Card, Flex, Text, TextField } from '@radix-ui/themes'
import { json, kodu } from '@/lib/api'
import { ErrorBox, PageHeader, Section, Skeleton, Switch, useLoad, useToast } from '@/components/ui'

type S = {
  idle_close: boolean; idle_minutes: number; statement_timeout: boolean; statement_seconds: number
  allow_signups: boolean; require_email_confirmation: boolean
  request_logging: boolean; log_retention_days: number
  realtime_enabled: boolean; upload_limit: boolean; upload_mb: number
}
type Row = { label: string; hint: string; on: keyof S; num?: { key: keyof S; unit: string; max: number } }

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: 'Connections',
    rows: [{
      label: 'Close idle connections', on: 'idle_close', num: { key: 'idle_minutes', unit: 'minutes', max: 1440 },
      hint: 'Database sessions that sit idle, or idle inside an open transaction, for this long are closed. Applies to new connections of the API.',
    }],
  },
  {
    title: 'Database',
    rows: [{
      label: 'Statement timeout', on: 'statement_timeout', num: { key: 'statement_seconds', unit: 'seconds', max: 3600 },
      hint: 'Cancels data API, function and file requests that run longer. The query console is not limited.',
    }],
  },
  {
    title: 'Identity',
    rows: [
      { label: 'Allow new sign-ups', on: 'allow_signups', hint: 'When off, sign-up (including first sign-in with a provider) is refused with 403. Existing users can still sign in; you can add users from Identity.' },
      { label: 'Require email confirmation', on: 'require_email_confirmation', hint: 'New users must open the emailed link before they can sign in. Needs an SMTP server under Identity.' },
    ],
  },
  {
    title: 'Observability',
    rows: [{
      label: 'Request logging', on: 'request_logging', num: { key: 'log_retention_days', unit: 'days', max: 365 },
      hint: 'Records each API request in Request logs and Metrics. Rows older than the retention are deleted. When off, nothing new is recorded.',
    }],
  },
  {
    title: 'Services',
    rows: [
      { label: 'Realtime', on: 'realtime_enabled', hint: 'When off, live-event WebSocket connections are refused.' },
      {
        label: 'Limit upload size', on: 'upload_limit', num: { key: 'upload_mb', unit: 'MB', max: 1024 },
        hint: 'Larger files are refused with 413. The server-wide ceiling (MAX_UPLOAD_BYTES) still applies.',
      },
    ],
  },
]

export default function ProjectSettings({ slug, name }: { slug: string; name: string }) {
  const { data, error, loading, reload, setError } = useLoad(() => kodu<S>(`platform/v1/projects/${slug}/settings`), [slug])
  const [draft, setDraft] = useState<S | null>(null)
  const [busy, setBusy] = useState('')
  const toast = useToast()
  useEffect(() => { if (data) setDraft(data) }, [data])

  if (loading && !draft) return <><PageHeader title="Settings" /><Skeleton rows={6} /></>
  if (!draft || !data) return <><PageHeader title="Settings" /><ErrorBox error={error} /></>

  const keys = (rows: Row[]) => rows.flatMap((r) => [r.on, ...(r.num ? [r.num.key] : [])])
  const bad = (rows: Row[]) => rows.some((r) => r.num && (!Number.isInteger(draft[r.num.key]) || (draft[r.num.key] as number) < 1 || (draft[r.num.key] as number) > r.num.max))

  async function save(title: string, rows: Row[]) {
    setBusy(title)
    try {
      const body = Object.fromEntries(keys(rows).map((k) => [k, draft![k]]))
      setDraft(await kodu<S>(`platform/v1/projects/${slug}/settings`, json('PUT', body)))
      setError('')
      toast(`${title} settings saved`)
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <PageHeader title="Settings" description={<>Options for <b>{name}</b>. Each section is saved on its own and takes effect immediately.</>} />
      <ErrorBox error={error} />
      <Flex direction="column" gap="5">
        {SECTIONS.map(({ title, rows }) => {
          const dirty = keys(rows).some((k) => draft[k] !== data[k])
          return (
            <Section key={title} title={title}>
              <Card size="2">
                <Flex direction="column" gap="4">
                  {rows.map((r) => (
                    <Flex key={r.label} justify="between" align="start" gap="4">
                      <div className="min-w-0">
                        <Text as="div" size="2" weight="medium">{r.label}</Text>
                        <Text as="div" size="2" color="gray">{r.hint}</Text>
                        {r.num && draft[r.on] && (
                          <Flex align="center" gap="2" mt="2">
                            <TextField.Root
                              aria-label={`${r.label}: ${r.num.unit}`} type="number" min={1} max={r.num.max} className="w-28"
                              value={String(draft[r.num.key])} onChange={(e) => setDraft({ ...draft, [r.num!.key]: Number(e.target.value) })}
                            />
                            <Text size="2" color="gray">{r.num.unit} (1-{r.num.max})</Text>
                          </Flex>
                        )}
                      </div>
                      <Switch label={r.label} checked={draft[r.on] as boolean} onChange={(v) => setDraft({ ...draft, [r.on]: v })} />
                    </Flex>
                  ))}
                  <Flex justify="end">
                    <Button loading={busy === title} disabled={!dirty || bad(rows)} onClick={() => save(title, rows)}>Save</Button>
                  </Flex>
                </Flex>
              </Card>
            </Section>
          )
        })}
      </Flex>
    </>
  )
}
