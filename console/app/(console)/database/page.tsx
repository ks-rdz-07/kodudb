'use client'
import { useState } from 'react'
import { Badge, Button, Code, Flex, IconButton, Table, Text, TextField, Tooltip } from '@radix-ui/themes'
import { Plus, Search, Trash2 } from 'lucide-react'
import { TableInfo, fmtBytes, json, kodu, qi, sql } from '@/lib/api'
import { Empty, ErrorBox, Modal, ObjectTable, PageHeader, Select, Skeleton, Switch, Tabs, useConfirm, useLoad, useToast } from '@/components/ui'

const TABS = [
  ['tables', 'Tables'], ['policies', 'Row security'], ['functions', 'Functions'], ['triggers', 'Triggers'],
  ['extensions', 'Extensions'], ['indexes', 'Indexes'], ['types', 'Enums'], ['roles', 'Roles'], ['schemas', 'Schemas'],
] as const
type Tab = (typeof TABS)[number][0]

export default function Schema() {
  const [tab, setTab] = useState<Tab>('tables')
  return (
    <>
      <PageHeader title="Schema" description="Tables, row security, functions and extensions of this project’s database." />
      <Tabs tabs={TABS.map(([value, label]) => ({ value, label }))} value={tab} onChange={(v) => setTab(v as Tab)}>
        {tab === 'tables' ? <Tables /> : tab === 'policies' ? <Policies /> : tab === 'extensions' ? <Extensions /> : <Catalog key={tab} kind={tab} />}
      </Tabs>
    </>
  )
}

function Catalog({ kind }: { kind: Tab }) {
  const { data, error, loading } = useLoad(() => kodu<Record<string, unknown>[]>(`meta/v1/${kind}`), [kind])
  return (
    <>
      <ErrorBox error={error} />
      {loading && !data ? <Skeleton /> : data && <ObjectTable rows={data} />}
    </>
  )
}

function Tables() {
  const { data, error, loading, reload, setError } = useLoad(() => kodu<TableInfo[]>('meta/v1/tables'))
  const toast = useToast()
  const confirm = useConfirm()
  async function exec(q: string, done: string) {
    try {
      await sql(q)
      toast(done)
      reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  if (loading && !data) return <Skeleton />
  return (
    <>
      <ErrorBox error={error} />
      <Table.Root variant="ghost" size="2" className="kd-table">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Table</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell className="num">Rows (est.)</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell className="num">Size</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Row security</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Live events</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell aria-label="Actions" />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {data?.map((t) => {
            const ref = `public.${qi(t.name)}`
            return (
              <Table.Row key={t.name} align="center">
                <Table.RowHeaderCell><Text className="font-mono">{t.name}</Text></Table.RowHeaderCell>
                <Table.Cell className="num">{t.rows_estimate.toLocaleString()}</Table.Cell>
                <Table.Cell className="num">{fmtBytes(t.bytes)}</Table.Cell>
                <Table.Cell>
                  <Flex gap="2" align="center">
                    <Switch label={`Row security on ${t.name}`} checked={t.rls_enabled}
                      onChange={(on) => exec(`alter table ${ref} ${on ? 'enable' : 'disable'} row level security`, `Row security ${on ? 'on' : 'off'} for ${t.name}`)} />
                    {!t.rls_enabled && <Badge color="amber" size="1">readable with public key</Badge>}
                  </Flex>
                </Table.Cell>
                <Table.Cell>
                  <Switch label={`Live events on ${t.name}`} checked={t.realtime}
                    onChange={(on) => exec(
                      on ? `create trigger kodudb_realtime after insert or update or delete on ${ref} for each row execute function realtime.broadcast_change()` : `drop trigger kodudb_realtime on ${ref}`,
                      `Live events ${on ? 'on' : 'off'} for ${t.name}`,
                    )} />
                </Table.Cell>
                <Table.Cell justify="end">
                  <Tooltip content="Drop table">
                    <IconButton size="1" variant="ghost" color="red" aria-label={`Drop ${t.name}`} onClick={async () => {
                      if (await confirm({ title: `Drop ${t.name}?`, description: 'The table and every row in it are deleted. This cannot be undone.', action: 'Drop table', danger: true, typeToConfirm: t.name }))
                        exec(`drop table ${ref}`, `Dropped ${t.name}`)
                    }}><Trash2 size={14} /></IconButton>
                  </Tooltip>
                </Table.Cell>
              </Table.Row>
            )
          })}
        </Table.Body>
      </Table.Root>
      {data?.length === 0 && <Empty>No tables in the public schema yet.</Empty>}
    </>
  )
}

type Policy = { schema: string; table: string; name: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }

const TEMPLATES = {
  owner: { label: 'Owner only (user_id = auth.uid())', using: 'user_id = auth.uid()', check: 'user_id = auth.uid()', roles: 'authenticated' },
  read: { label: 'Anyone can read', using: 'true', check: '', roles: 'anon, authenticated' },
  signed: { label: 'Any signed-in user', using: 'true', check: 'true', roles: 'authenticated' },
} as const

function Policies() {
  const { data, error, loading, reload, setError } = useLoad(() => kodu<Policy[]>('meta/v1/policies'))
  const tables = useLoad(() => kodu<TableInfo[]>('meta/v1/tables'))
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ table: '', name: '', cmd: 'all', roles: 'authenticated', using: 'user_id = auth.uid()', check: 'user_id = auth.uid()' })
  const toast = useToast()
  const confirm = useConfirm()
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch })

  const statement = () => {
    const parts = [`create policy ${qi(form.name)} on public.${qi(form.table)}`, `  for ${form.cmd} to ${form.roles}`]
    if (form.cmd !== 'insert' && form.using) parts.push(`  using (${form.using})`)
    if (form.cmd !== 'select' && form.cmd !== 'delete' && form.check) parts.push(`  with check (${form.check})`)
    return parts.join('\n') + ';'
  }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    try {
      await sql(statement())
      toast(`Policy “${form.name}” created`)
      setOpen(false)
      reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Flex direction="column" gap="3">
      <Flex justify="between" align="center" gap="3" wrap="wrap">
        <Text size="2" color="gray">Policies decide which rows each request can read and write. Roles: <Code size="1">anon</Code> is the public key, <Code size="1">authenticated</Code> a signed-in user.</Text>
        <Button variant="soft" color="gray" onClick={() => setOpen(true)}><Plus size={15} />New policy</Button>
      </Flex>
      <ErrorBox error={error} />
      {loading && !data ? <Skeleton /> : (
        <Table.Root variant="ghost" size="2" className="kd-table">
          <Table.Header>
            <Table.Row>
              {['Table', 'Policy', 'Applies to', 'Roles', 'Rows visible when', 'Rows writable when', ''].map((h) => <Table.ColumnHeaderCell key={h}>{h}</Table.ColumnHeaderCell>)}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data?.map((p) => (
              <Table.Row key={`${p.schema}.${p.table}.${p.name}`} align="center">
                <Table.RowHeaderCell><Text className="font-mono">{p.schema}.{p.table}</Text></Table.RowHeaderCell>
                <Table.Cell>{p.name}</Table.Cell>
                <Table.Cell><Badge color="gray" variant="soft">{p.cmd.toLowerCase()}</Badge></Table.Cell>
                <Table.Cell>{p.roles.join(', ')}</Table.Cell>
                <Table.Cell><Code size="1" variant="ghost">{p.qual ?? '—'}</Code></Table.Cell>
                <Table.Cell><Code size="1" variant="ghost">{p.with_check ?? '—'}</Code></Table.Cell>
                <Table.Cell justify="end">
                  <IconButton size="1" variant="ghost" color="red" aria-label={`Drop policy ${p.name}`} onClick={async () => {
                    if (!(await confirm({ title: `Drop policy “${p.name}”?`, description: `Rows of ${p.table} it allowed become unreachable unless another policy allows them.`, action: 'Drop policy', danger: true }))) return
                    try {
                      await sql(`drop policy ${qi(p.name)} on ${qi(p.schema)}.${qi(p.table)}`)
                      toast('Policy dropped')
                      reload()
                    } catch (e) {
                      setError((e as Error).message)
                    }
                  }}><Trash2 size={14} /></IconButton>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="New row security policy" width="600px">
        <form onSubmit={create}>
          <Flex direction="column" gap="3">
            <label className="flex flex-col gap-1.5">
              <Text size="2" weight="medium">Start from</Text>
              <Select label="Template" value="" placeholder="Choose a template" onChange={(k) => {
                const t = TEMPLATES[k as keyof typeof TEMPLATES]
                if (t) set({ using: t.using, check: t.check, roles: t.roles })
              }} options={Object.entries(TEMPLATES).map(([value, t]) => ({ value, label: t.label }))} />
            </label>
            <Flex gap="3" wrap="wrap">
              <label className="flex flex-1 flex-col gap-1.5">
                <Text size="2" weight="medium">Table</Text>
                <Select label="Table" value={form.table} placeholder="Choose a table" onChange={(v) => set({ table: v })} options={(tables.data ?? []).map((t) => ({ value: t.name, label: t.name }))} />
              </label>
              <label className="flex flex-1 flex-col gap-1.5">
                <Text size="2" weight="medium">Applies to</Text>
                <Select label="Command" value={form.cmd} onChange={(v) => set({ cmd: v })} options={['all', 'select', 'insert', 'update', 'delete'].map((c) => ({ value: c, label: c }))} />
              </label>
            </Flex>
            <label className="flex flex-col gap-1.5">
              <Text size="2" weight="medium">Policy name</Text>
              <TextField.Root required value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="customers manage own orders" />
            </label>
            <label className="flex flex-col gap-1.5">
              <Text size="2" weight="medium">Roles</Text>
              <TextField.Root value={form.roles} onChange={(e) => set({ roles: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Text size="2" weight="medium">Rows visible when</Text>
              <TextField.Root className="font-mono" value={form.using} onChange={(e) => set({ using: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Text size="2" weight="medium">Rows writable when</Text>
              <TextField.Root className="font-mono" value={form.check} onChange={(e) => set({ check: e.target.value })} />
            </label>
            <pre className="overflow-auto rounded-md p-3 text-xs" style={{ background: 'var(--gray-a2)', fontFamily: 'var(--code-font-family)' }}>{statement()}</pre>
            <Flex gap="2" justify="end">
              <Button type="button" variant="soft" color="gray" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={!form.table || !form.name}>Create policy</Button>
            </Flex>
          </Flex>
        </form>
      </Modal>
    </Flex>
  )
}

type Ext = { name: string; default_version: string; installed_version: string | null; comment: string | null }

function Extensions() {
  const { data, error, loading, reload, setError } = useLoad(() => kodu<Ext[]>('meta/v1/extensions'))
  const [filter, setFilter] = useState('')
  const toast = useToast()
  async function toggle(x: Ext) {
    try {
      // Project databases are owned by a non-superuser role, so extensions go through the platform.
      const { slug } = (await (await fetch('/api/project')).json()) as { slug: string }
      if (slug === 'default') await sql(x.installed_version ? `drop extension ${qi(x.name)}` : `create extension ${qi(x.name)}`)
      else await kodu(`platform/v1/projects/${slug}/extensions`, json('POST', { name: x.name, enabled: !x.installed_version }))
      toast(`${x.installed_version ? 'Disabled' : 'Enabled'} ${x.name}`)
      reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const rows = data?.filter((x) => x.name.includes(filter.toLowerCase())) ?? []
  return (
    <Flex direction="column" gap="3">
      <Flex gap="3" align="center">
        <TextField.Root aria-label="Search extensions" placeholder="Search extensions" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 280 }}>
          <TextField.Slot><Search size={14} /></TextField.Slot>
        </TextField.Root>
        <Text size="2" color="gray" className="num">{data?.filter((x) => x.installed_version).length ?? 0} enabled of {data?.length ?? 0}</Text>
      </Flex>
      <ErrorBox error={error} />
      {loading && !data ? <Skeleton /> : (
        <Table.Root variant="ghost" size="1" className="kd-table">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Extension</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Version</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>What it does</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Enabled</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((x) => (
              <Table.Row key={x.name} align="center">
                <Table.RowHeaderCell><Text className="font-mono">{x.name}</Text></Table.RowHeaderCell>
                <Table.Cell className="num">{x.installed_version ?? x.default_version}</Table.Cell>
                <Table.Cell><Text color="gray" title={x.comment ?? ''}>{x.comment}</Text></Table.Cell>
                <Table.Cell><Switch label={`Enable ${x.name}`} checked={!!x.installed_version} onChange={() => toggle(x)} /></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
    </Flex>
  )
}
