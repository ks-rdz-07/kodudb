'use client'
import { useState } from 'react'
import { Badge, Button, Callout, Flex, IconButton, Text, TextArea, TextField, Tooltip } from '@radix-ui/themes'
import { Play, Plug, Plus, Trash2 } from 'lucide-react'
import { json, kodu } from '@/lib/api'
import { SqlEditor } from '@/components/sql-editor'
import { DataTable, Empty, ErrorBox, Modal, PageHeader, Select, Skeleton, useConfirm, useLoad, useToast } from '@/components/ui'

type Kind = 'postgres' | 'mysql' | 'mssql' | 'mongodb'
type Conn = { id: string; name: string; kind: Kind; host_hint: string | null; created_at: string }
type Result = { columns: string[]; rows: unknown[][]; row_count: number; truncated: boolean; ms: number }

const KINDS: Record<Kind, { label: string; placeholder: string; sample: string }> = {
  postgres: { label: 'PostgreSQL', placeholder: 'postgres://user:password@host:5432/database', sample: 'select table_name from information_schema.tables\nwhere table_schema = \'public\'\nlimit 20;' },
  mysql: { label: 'MySQL / MariaDB', placeholder: 'mysql://user:password@host:3306/database', sample: 'show tables;' },
  mssql: { label: 'SQL Server', placeholder: 'server=tcp:host,1433;user=sa;password=…;database=app;TrustServerCertificate=true', sample: 'select top 20 table_schema, table_name\nfrom information_schema.tables;' },
  mongodb: { label: 'MongoDB', placeholder: 'mongodb://user:password@host:27017/database', sample: '{\n  "collection": "users",\n  "filter": {},\n  "limit": 50\n}' },
}

export default function DataSources() {
  const conns = useLoad(() => kodu<Conn[]>('connect/v1/connections'))
  const [activeId, setActiveId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const active = conns.data?.find((c) => c.id === (activeId ?? conns.data?.[0]?.id)) ?? null

  return (
    <>
      <PageHeader
        title="Data sources"
        description="Query external PostgreSQL, MySQL, SQL Server and MongoDB databases next to your own. Connection strings are encrypted at rest and never sent back to the browser."
        actions={<Button onClick={() => setAdding(true)}><Plus size={15} />Add data source</Button>}
      />
      <ErrorBox error={conns.error} />
      <div className="grid items-start gap-5 lg:grid-cols-[208px_1fr]">
        <nav aria-label="Data sources" className="flex flex-col gap-0.5">
          {conns.loading && !conns.data && <Skeleton rows={3} />}
          {conns.data?.map((c) => (
            <Button key={c.id} variant={c.id === active?.id ? 'soft' : 'ghost'} color="gray" onClick={() => setActiveId(c.id)} className="!m-0 !h-auto !justify-start !py-1.5">
              <Flex direction="column" align="start">
                <Text truncate style={{ color: 'var(--gray-12)' }} weight={c.id === active?.id ? 'medium' : 'regular'}>{c.name}</Text>
                <Text size="1" color="gray">{KINDS[c.kind].label}</Text>
              </Flex>
            </Button>
          ))}
          {conns.data?.length === 0 && <Empty>No data sources yet.</Empty>}
        </nav>
        <section className="min-w-0">
          {active && <Workspace key={active.id} conn={active} onDeleted={() => { setActiveId(null); conns.reload() }} />}
        </section>
      </div>
      <AddConn open={adding} onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); conns.reload(); setActiveId(id) }} />
    </>
  )
}

function Workspace({ conn, onDeleted }: { conn: Conn; onDeleted: () => void }) {
  const objects = useLoad(() => kodu<Result>(`connect/v1/connections/${conn.id}/objects`))
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [query, setQuery] = useState(KINDS[conn.kind].sample)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const confirm = useConfirm()

  async function test() {
    setStatus({ ok: true, text: 'Connecting…' })
    try {
      const r = await kodu<{ version: string; ms: number }>(`connect/v1/connections/${conn.id}/test`, { method: 'POST' })
      setStatus({ ok: true, text: `Connected in ${r.ms} ms · ${String(r.version).split('\n')[0]}` })
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message })
    }
  }

  async function run() {
    setBusy(true)
    setError('')
    try {
      const body = conn.kind === 'mongodb' ? JSON.parse(query) : { query }
      setResult(await kodu<Result>(`connect/v1/connections/${conn.id}/query`, json('POST', body)))
    } catch (e) {
      setResult(null)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Completion from the source's own table list (schema-qualified for SQL sources).
  const schema = Object.fromEntries((objects.data?.rows ?? []).map((r) => [String(r[1] ?? r[0]), [] as string[]]))

  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="2" wrap="wrap">
        <Text size="4" weight="medium">{conn.name}</Text>
        <Badge color="gray" variant="soft">{KINDS[conn.kind].label}</Badge>
        <Text size="1" color="gray" className="font-mono">{conn.host_hint}</Text>
        <div className="flex-1" />
        <Button variant="soft" color="gray" onClick={test}><Plug size={15} />Test connection</Button>
        <Tooltip content="Remove data source">
          <IconButton variant="soft" color="red" aria-label="Remove data source" onClick={async () => {
            if (await confirm({ title: `Remove ${conn.name}?`, description: 'Only the saved connection is removed; the external database is not touched.', action: 'Remove', danger: true }))
              kodu(`connect/v1/connections/${conn.id}`, { method: 'DELETE' }).then(() => { toast(`Removed ${conn.name}`); onDeleted() })
          }}><Trash2 size={15} /></IconButton>
        </Tooltip>
      </Flex>
      {status && (
        <Callout.Root size="1" color={status.ok ? 'gray' : 'red'} role="status"><Callout.Text>{status.text}</Callout.Text></Callout.Root>
      )}
      <details open>
        <summary><Text size="2" weight="medium">{conn.kind === 'mongodb' ? 'Collections' : 'Tables'} <Text color="gray" className="num">{objects.data ? objects.data.row_count : ''}</Text></Text></summary>
        <div className="mt-2">
          <ErrorBox error={objects.error} />
          {objects.loading && !objects.data ? <Skeleton rows={3} /> : objects.data && <DataTable columns={objects.data.columns} rows={objects.data.rows.slice(0, 50)} />}
        </div>
      </details>
      <Text size="2" weight="medium">{conn.kind === 'mongodb' ? 'Query: {collection, filter} or {collection, pipeline}' : 'SQL'}</Text>
      {conn.kind === 'mongodb' ? (
        <TextArea className="font-mono" rows={8} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="MongoDB query" />
      ) : (
        <SqlEditor label="SQL query for this data source" value={query} onChange={setQuery} onRun={run} schema={schema} height="180px" />
      )}
      <Flex align="center" gap="3">
        <Button onClick={run} loading={busy}><Play size={15} />Run</Button>
        {result && <Text size="2" color="gray" className="num">{result.row_count.toLocaleString()} rows{result.truncated ? ' (first 1,000)' : ''} · {result.ms} ms</Text>}
      </Flex>
      <ErrorBox error={error} />
      {result && <DataTable columns={result.columns} rows={result.rows} />}
    </Flex>
  )
}

function AddConn({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const [kind, setKind] = useState<Kind>('postgres')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    try {
      const c = await kodu<Conn>('connect/v1/connections', json('POST', { name: f.get('name'), kind, url: f.get('url') }))
      setError('')
      toast(`Added ${c.name}`)
      onDone(c.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add data source" description="The connection string is encrypted in the database and never sent back to the browser.">
      <form onSubmit={submit}>
        <Flex direction="column" gap="3">
          <label className="flex flex-col gap-1.5">
            <Text size="2" weight="medium">Database</Text>
            <Select label="Database type" value={kind} onChange={(v) => setKind(v as Kind)} options={Object.entries(KINDS).map(([k, v]) => ({ value: k, label: v.label }))} />
          </label>
          <label className="flex flex-col gap-1.5"><Text size="2" weight="medium">Name</Text><TextField.Root name="name" required placeholder="legacy-orders" /></label>
          <label className="flex flex-col gap-1.5"><Text size="2" weight="medium">Connection string</Text><TextField.Root name="url" required className="font-mono" placeholder={KINDS[kind].placeholder} autoComplete="off" /></label>
          <ErrorBox error={error} />
          <Flex gap="2" justify="end">
            <Button type="button" variant="soft" color="gray" onClick={onClose}>Cancel</Button>
            <Button loading={busy}>Save data source</Button>
          </Flex>
        </Flex>
      </form>
    </Modal>
  )
}
