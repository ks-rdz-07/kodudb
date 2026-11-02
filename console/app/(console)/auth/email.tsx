'use client'
import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Callout, Card, Flex, Grid, Table, Text, TextArea, TextField } from '@radix-ui/themes'
import { RefreshCw, Send } from 'lucide-react'
import { json, kodu } from '@/lib/api'
import { Empty, ErrorBox, Select, Skeleton, Switch, Tabs, useLoad, useToast } from '@/components/ui'

type Settings = {
  require_email_confirmation: boolean; site_url: string; smtp_host: string | null; smtp_port: number; smtp_user: string | null
  smtp_from: string | null; smtp_security: 'starttls' | 'tls' | 'none'; smtp_password_set: boolean; updated_at: string
}
type Template = { kind: 'confirm' | 'recovery' | 'password_changed' | 'mfa_enabled' | 'mfa_disabled'; subject: string; body: string; updated_at: string }
type Sent = { id: number; at: string; to_email: string; kind: string; subject: string | null; status: string; error: string | null }

const field = (label: string, input: React.ReactNode, hint?: string) => (
  <label className="flex flex-col gap-1.5">
    <Text size="2" weight="medium">{label}</Text>
    {input}
    {hint && <Text size="1" color="gray">{hint}</Text>}
  </label>
)

export function EmailSettings() {
  const { data, error, loading, reload, setError } = useLoad(() => kodu<Settings>('auth/v1/admin/settings'))
  const [form, setForm] = useState<Settings | null>(null)
  const [password, setPassword] = useState('')
  const [testTo, setTestTo] = useState('')
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const toast = useToast()

  useEffect(() => { if (data) setForm(data) }, [data])
  if (loading && !form) return <Skeleton rows={6} />
  if (!form) return <ErrorBox error={error} />
  const set = (patch: Partial<Settings>) => setForm({ ...form, ...patch })

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy('save')
    try {
      await kodu('auth/v1/admin/settings', json('PUT', { ...form, smtp_password: password || undefined }))
      setPassword('')
      toast('Email settings saved')
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function test() {
    setBusy('test')
    setResult(null)
    try {
      await kodu('auth/v1/admin/settings/test', json('POST', { to: testTo }))
      setResult({ ok: true, text: `Test email accepted by ${form!.smtp_host}. Check the inbox of ${testTo}.` })
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message })
    } finally {
      setBusy('')
    }
  }

  const ready = !!form.smtp_host && !!form.smtp_from
  return (
    <Grid columns={{ initial: '1', lg: '3' }} gap="5">
      <form onSubmit={save} className="lg:col-span-2">
        <Flex direction="column" gap="4">
          <ErrorBox error={error} />
          <Card size="2">
            <Flex direction="column" gap="3">
              <Flex justify="between" align="start" gap="4">
                <div>
                  <Text as="div" size="2" weight="medium">Require email confirmation</Text>
                  <Text as="div" size="2" color="gray">New users get a link and cannot sign in until they open it. Existing users are not affected.</Text>
                </div>
                <Switch label="Require email confirmation" checked={form.require_email_confirmation} onChange={(v) => set({ require_email_confirmation: v })} disabled={!ready && !form.require_email_confirmation} />
              </Flex>
              {!ready && <Text size="1" color="amber">Set an SMTP server and a From address before turning this on.</Text>}
              {field('Site URL', <TextField.Root value={form.site_url} onChange={(e) => set({ site_url: e.target.value })} placeholder="https://app.example.com" />, 'Links in emails land here. Redirects to other sites are refused.')}
            </Flex>
          </Card>
          <Card size="2">
            <Flex direction="column" gap="3">
              <Text size="2" weight="medium">SMTP server</Text>
              <Grid columns={{ initial: '1', sm: '3' }} gap="3">
                <div className="sm:col-span-2">{field('Host', <TextField.Root value={form.smtp_host ?? ''} onChange={(e) => set({ smtp_host: e.target.value })} placeholder="smtp.example.com" />)}</div>
                {field('Port', <TextField.Root type="number" value={String(form.smtp_port)} onChange={(e) => set({ smtp_port: Number(e.target.value) })} />)}
              </Grid>
              {field('Security', <Select label="Security" value={form.smtp_security} onChange={(v) => set({ smtp_security: v as Settings['smtp_security'] })} options={[{ value: 'starttls', label: 'STARTTLS (port 587)' }, { value: 'tls', label: 'TLS (port 465)' }, { value: 'none', label: 'None (local relay only)' }]} />)}
              <Grid columns={{ initial: '1', sm: '2' }} gap="3">
                {field('Username', <TextField.Root value={form.smtp_user ?? ''} onChange={(e) => set({ smtp_user: e.target.value })} autoComplete="off" />)}
                {field(
                  'Password',
                  <TextField.Root type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={form.smtp_password_set ? 'Saved — leave empty to keep' : ''} />,
                  'Stored encrypted. It is never shown again.',
                )}
              </Grid>
              {field('From address', <TextField.Root value={form.smtp_from ?? ''} onChange={(e) => set({ smtp_from: e.target.value })} placeholder="Shop <no-reply@shop.example>" />)}
            </Flex>
          </Card>
          <Flex justify="end"><Button loading={busy === 'save'}>Save settings</Button></Flex>
        </Flex>
      </form>
      <Card size="2" className="self-start">
        <Flex direction="column" gap="3">
          <Text size="2" weight="medium">Send a test email</Text>
          <Text size="2" color="gray">Uses the saved settings and shows the server’s answer.</Text>
          <TextField.Root aria-label="Send test email to" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
          <Button variant="soft" color="gray" onClick={test} loading={busy === 'test'} disabled={!testTo}><Send size={14} />Send test</Button>
          {result && <Callout.Root size="1" color={result.ok ? 'green' : 'red'} role="status"><Callout.Text>{result.text}</Callout.Text></Callout.Root>}
        </Flex>
      </Card>
    </Grid>
  )
}

const SAMPLE = { link: 'https://api.example.com/auth/v1/verify?token=…&type=confirm', email: 'customer@example.com', project: 'demo-store', site_url: 'https://app.example.com' }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** Same substitution as the server: {{name}} → HTML-escaped value. */
const render = (t: string) => Object.entries(SAMPLE).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, esc(v)), t)

export function EmailTemplates() {
  const { data, error, loading, reload, setError } = useLoad(() => kodu<Template[]>('auth/v1/admin/templates'))
  const [kind, setKind] = useState<Template['kind']>('confirm')
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const current = data?.find((t) => t.kind === kind)

  useEffect(() => { if (current) setDraft({ subject: current.subject, body: current.body }) }, [current])
  const preview = useMemo(() => (draft ? render(draft.body) : ''), [draft])
  const link = kind === 'confirm' || kind === 'recovery'
  const dirty = !!current && !!draft && (draft.subject !== current.subject || draft.body !== current.body)

  async function save() {
    if (!draft) return
    setBusy(true)
    try {
      await kodu(`auth/v1/admin/templates/${kind}`, json('PUT', draft))
      toast('Template saved')
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (loading && !data) return <Skeleton rows={6} />
  return (
    <Flex direction="column" gap="3">
      <Tabs tabs={[{ value: 'confirm', label: 'Confirm sign-up' }, { value: 'recovery', label: 'Reset password' }, { value: 'password_changed', label: 'Password changed' }, { value: 'mfa_enabled', label: 'Two-factor on' }, { value: 'mfa_disabled', label: 'Two-factor off' }]} value={kind} onChange={(v) => setKind(v as Template['kind'])}>
        <ErrorBox error={error} />
        {draft && (
          <Grid columns={{ initial: '1', lg: '2' }} gap="5">
            <Flex direction="column" gap="3">
              {field('Subject', <TextField.Root value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />)}
              {field('Body (HTML)', <TextArea className="font-mono" rows={14} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />, (link ? 'Placeholders: {{link}} (required), {{email}}, {{project}}, {{site_url}}. Values are escaped.' : 'A notice sent after the change, without a link. Placeholders: {{email}}, {{project}}, {{site_url}}. Sent only when SMTP is set up.'))}
              <Flex gap="2" justify="end">
                <Button variant="soft" color="gray" disabled={!dirty} onClick={() => current && setDraft({ subject: current.subject, body: current.body })}>Discard</Button>
                <Button loading={busy} disabled={!dirty} onClick={save}>Save template</Button>
              </Flex>
            </Flex>
            <Flex direction="column" gap="2">
              <Text size="2" weight="medium">Preview</Text>
              <Card size="1" className="!p-0 overflow-hidden">
                <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--gray-a4)' }}>
                  <Text as="div" size="1" color="gray">To {SAMPLE.email}</Text>
                  <Text as="div" size="3" weight="medium">{render(draft.subject).replace(/&amp;/g, '&')}</Text>
                </div>
                <iframe title="Email preview" sandbox="" srcDoc={`<body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#1d1c1a;margin:16px">${preview}</body>`} className="block h-[320px] w-full bg-white" />
              </Card>
            </Flex>
          </Grid>
        )}
      </Tabs>
    </Flex>
  )
}

export function SentEmails() {
  const { data, error, loading, reload } = useLoad(() => kodu<Sent[]>('auth/v1/admin/emails'))
  const failed = data?.filter((e) => e.status !== 'sent').length ?? 0
  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="2">
        <Text size="2" color="gray">{data ? `${data.length} recent emails · ${failed} failed` : 'Loading…'}</Text>
        <div className="flex-1" />
        <Button variant="soft" color="gray" onClick={reload}><RefreshCw size={14} />Refresh</Button>
      </Flex>
      <ErrorBox error={error} />
      {loading && !data ? <Skeleton /> : data?.length ? (
        <Table.Root variant="ghost" size="1" className="kd-table">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Sent</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Kind</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>To</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Subject</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Result</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.map((e) => (
              <Table.Row key={e.id}>
                <Table.Cell className="num"><Text color="gray">{new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</Text></Table.Cell>
                <Table.Cell><Badge color="gray" variant="soft">{e.kind}</Badge></Table.Cell>
                <Table.Cell>{e.to_email}</Table.Cell>
                <Table.Cell><Text color="gray">{e.subject ?? '—'}</Text></Table.Cell>
                <Table.Cell>{e.status === 'sent' ? <Text color="gray">Delivered to SMTP</Text> : <Text color="red" title={e.error ?? ''}>{e.error ?? 'Failed'}</Text>}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      ) : <Empty>No emails sent yet.</Empty>}
    </Flex>
  )
}
