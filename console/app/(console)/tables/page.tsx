'use client'
import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Badge, Button, Checkbox, Code, Flex, IconButton, ScrollArea, Table, Text, TextArea, TextField, Tooltip,
} from '@radix-ui/themes'
import { Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Column, TableInfo, json, kodu, qi, sql } from '@/lib/api'
import { Cell, Empty, ErrorBox, Modal, PageHeader, Select, Skeleton, useConfirm, useLoad, useToast } from '@/components/ui'

const PAGE = 50
const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'is'] as const
type Row = Record<string, unknown>
type Filter = { col: string; op: string; value: string }

export default function Page() {
  return <Suspense><DataExplorer /></Suspense>
}

function DataExplorer() {
  const params = useSearchParams()
  const tables = useLoad(() => kodu<TableInfo[]>('meta/v1/tables'))
  const [active, setActive] = useState<string | null>(params.get('t'))
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!active && tables.data?.length) setActive(tables.data[0].name)
  }, [tables.data, active])

  return (
    <>
      <PageHeader
        title="Data explorer"
        description="Browse and edit rows in the public schema. Edits go through the same REST API your app uses."
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} />New table</Button>}
      />
      <ErrorBox error={tables.error} />
      <div className="grid items-start gap-5 lg:grid-cols-[208px_1fr]">
        <nav aria-label="Tables" className="flex flex-col gap-0.5">
          <Text size="1" color="gray" mb="1" className="px-2">{tables.data?.length ?? 0} tables</Text>
          {tables.loading && !tables.data && <Skeleton rows={4} />}
          {tables.data?.map((t) => (
            <Button key={t.name} variant={t.name === active ? 'soft' : 'ghost'} color="gray" onClick={() => setActive(t.name)} className="!m-0 !justify-between">
              <Text truncate style={{ color: 'var(--gray-12)' }} weight={t.name === active ? 'medium' : 'regular'}>{t.name}</Text>
              {!t.rls_enabled && <Tooltip content="Row security is off: the public key can read every row"><Badge color="amber" size="1">open</Badge></Tooltip>}
            </Button>
          ))}
          {tables.data?.length === 0 && <Empty>No tables yet. Create one to start.</Empty>}
        </nav>
        <section className="min-w-0">{active && <Grid key={active} table={active} />}</section>
      </div>
      <CreateTable
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(name) => { setCreating(false); tables.reload(); setActive(name) }}
      />
    </>
  )
}

function Grid({ table }: { table: string }) {
  const cols = useLoad(() => kodu<Column[]>(`meta/v1/tables/${table}/columns`))
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState<Filter[]>([])
  const [draft, setDraft] = useState<Filter>({ col: '', op: 'eq', value: '' })
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Row | 'new' | null>(null)
  const toast = useToast()
  const confirm = useConfirm()

  const columns = cols.data ?? []
  const pk = columns.filter((c) => c.primary_key).map((c) => c.name)
  const numeric = (t: string) => /int|numeric|double|real|decimal/.test(t)

  async function load() {
    if (!cols.data) return
    const p = new URLSearchParams({ select: '*', limit: String(PAGE), offset: String(page * PAGE) })
    if (pk.length) p.set('order', pk.map((k) => `${k}.asc`).join(','))
    for (const f of filters) p.append(f.col, `${f.op}.${f.value}`)
    try {
      const res = await fetch(`/api/kodu/rest/v1/${table}?${p}`, { headers: { prefer: 'count=exact' } })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error)
      setRows(body)
      setTotal(Number(res.headers.get('x-total-count') ?? body.length))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [cols.data, page, filters])

  const match = (r: Row) => pk.map((k) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(String(r[k]))}`).join('&')

  async function remove(r: Row) {
    const ok = await confirm({ title: `Delete row from ${table}?`, description: `Row ${pk.map((k) => `${k} = ${r[k]}`).join(', ')} is removed for good.`, action: 'Delete row', danger: true })
    if (!ok) return
    try {
      await kodu(`rest/v1/${table}?${match(r)}`, { method: 'DELETE' })
      toast('Row deleted')
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function save(values: Row) {
    if (editing === 'new') await kodu(`rest/v1/${table}`, json('POST', values))
    else if (editing) await kodu(`rest/v1/${table}?${match(editing)}`, json('PATCH', values))
    toast(editing === 'new' ? 'Row inserted' : 'Row updated')
    setEditing(null)
    load()
  }

  const pages = Math.max(1, Math.ceil(total / PAGE))
  const first = total ? page * PAGE + 1 : 0

  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="2" wrap="wrap">
        <Text size="4" weight="medium" className="font-mono">{table}</Text>
        <Text size="2" color="gray" className="num">{total.toLocaleString()} rows</Text>
        <div className="flex-1" />
        <Tooltip content="Reload rows"><IconButton variant="soft" color="gray" aria-label="Reload rows" onClick={load}><RefreshCw size={15} /></IconButton></Tooltip>
        <Button variant="soft" color="gray" onClick={() => setEditing('new')} disabled={!columns.length}><Plus size={15} />Insert row</Button>
      </Flex>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!draft.col) return
          setPage(0)
          setFilters([...filters, draft])
          setDraft({ ...draft, value: '' })
        }}
      >
        <Select label="Filter column" value={draft.col} onChange={(v) => setDraft({ ...draft, col: v })} placeholder="Column" options={columns.map((c) => ({ value: c.name, label: c.name }))} width="160px" />
        <Select label="Operator" value={draft.op} onChange={(v) => setDraft({ ...draft, op: v })} options={OPS.map((o) => ({ value: o, label: o }))} width="90px" />
        <TextField.Root aria-label="Filter value" placeholder={draft.op === 'ilike' ? '*text*' : 'value'} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
        <Button variant="soft" color="gray" type="submit" disabled={!draft.col}>Add filter</Button>
        {filters.map((f, i) => (
          <Badge key={i} size="2" color="gray" variant="surface">
            <span className="font-mono">{f.col} {f.op} {f.value}</span>
            <IconButton size="1" variant="ghost" color="gray" aria-label="Remove filter" onClick={() => setFilters(filters.filter((_, j) => j !== i))}><X size={12} /></IconButton>
          </Badge>
        ))}
      </form>

      <ErrorBox error={error || cols.error} />
      {cols.loading && <Skeleton rows={8} />}
      {!pk.length && columns.length > 0 && <Text size="2" color="gray">This table has no primary key, so rows can be inserted here but not edited or deleted.</Text>}

      {columns.length > 0 && (
        <ScrollArea type="auto" scrollbars="both" style={{ maxHeight: '62vh' }}>
          <Table.Root variant="ghost" size="1" className="kd-table">
            <Table.Header>
              <Table.Row>
                {columns.map((c) => (
                  <Table.ColumnHeaderCell key={c.name} className={numeric(c.type) ? 'num' : ''}>
                    <span style={{ color: 'var(--gray-12)', fontWeight: 500 }}>{c.name}</span>{c.primary_key && <Text color="red"> ·pk</Text>}
                    <span className="block font-mono text-[11px]">{c.type}</span>
                  </Table.ColumnHeaderCell>
                ))}
                {pk.length > 0 && <Table.ColumnHeaderCell aria-label="Actions" />}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r, i) => (
                <Table.Row key={i}>
                  {columns.map((c) => <Cell key={c.name} v={r[c.name]} />)}
                  {pk.length > 0 && (
                    <Table.Cell justify="end">
                      <Flex gap="1" justify="end">
                        <Tooltip content="Edit row"><IconButton size="1" variant="ghost" color="gray" aria-label="Edit row" onClick={() => setEditing(r)}><Pencil size={13} /></IconButton></Tooltip>
                        <Tooltip content="Delete row"><IconButton size="1" variant="ghost" color="red" aria-label="Delete row" onClick={() => remove(r)}><Trash2 size={13} /></IconButton></Tooltip>
                      </Flex>
                    </Table.Cell>
                  )}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
          {rows.length === 0 && <div className="py-3"><Empty>No rows match{filters.length ? ' these filters' : ''}.</Empty></div>}
        </ScrollArea>
      )}

      <Flex align="center" gap="2">
        <Text size="2" color="gray" className="num">{first.toLocaleString()}–{(page * PAGE + rows.length).toLocaleString()} of {total.toLocaleString()}</Text>
        <div className="flex-1" />
        <Button variant="soft" color="gray" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
        <Button variant="soft" color="gray" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</Button>
      </Flex>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? `Insert into ${table}` : `Edit row in ${table}`}>
        <RowForm columns={columns} row={editing === 'new' ? null : editing} onSave={save} onCancel={() => setEditing(null)} />
      </Modal>
    </Flex>
  )
}

const isJson = (t: string) => t === 'json' || t === 'jsonb'
const isBool = (t: string) => t === 'boolean'

function RowForm({ columns, row, onSave, onCancel }: { columns: Column[]; row: Row | null; onSave: (v: Row) => Promise<void>; onCancel: () => void }) {
  const initial = Object.fromEntries(columns.map((c) => {
    const v = row?.[c.name]
    return [c.name, v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)]
  }))
  const [values, setValues] = useState<Record<string, string>>(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: string) => setValues({ ...values, [k]: v })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const out: Row = {}
    try {
      for (const c of columns) {
        const v = values[c.name]
        if (row === null && v === '') continue // defaults apply on insert
        if (row !== null && v === initial[c.name]) continue // only send changed fields
        out[c.name] = v === '' ? null : isJson(c.type) ? JSON.parse(v) : v
      }
    } catch {
      setError('JSON columns must hold valid JSON.')
      return
    }
    setBusy(true)
    try {
      await onSave(out)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <ScrollArea type="auto" style={{ maxHeight: '58vh' }}>
        <Flex direction="column" gap="3" pr="3">
          {columns.map((c) => (
            <label key={c.name} className="flex flex-col gap-1.5">
              <Text size="2" weight="medium">
                {c.name} <Code size="1" variant="ghost" color="gray">{c.type}</Code>
                {!c.nullable && !c.default && <Text size="1" color="red"> required</Text>}
              </Text>
              {isJson(c.type) ? (
                <TextArea className="font-mono" rows={4} value={values[c.name]} onChange={(e) => set(c.name, e.target.value)} />
              ) : isBool(c.type) ? (
                <Select label={c.name} value={values[c.name]} onChange={(v) => set(c.name, v)} options={[{ value: '', label: 'Default / null' }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} />
              ) : (
                <TextField.Root value={values[c.name]} placeholder={c.default ? `default: ${c.default}` : ''} onChange={(e) => set(c.name, e.target.value)} />
              )}
            </label>
          ))}
        </Flex>
      </ScrollArea>
      <ErrorBox error={error} />
      <Flex gap="2" justify="end" mt="4">
        <Button type="button" variant="soft" color="gray" onClick={onCancel}>Cancel</Button>
        <Button loading={busy}>Save</Button>
      </Flex>
    </form>
  )
}

const TYPES = ['text', 'bigint', 'integer', 'numeric', 'boolean', 'uuid', 'timestamptz', 'date', 'jsonb', 'text[]', 'double precision']
type NewCol = { name: string; type: string; nullable: boolean; def: string }

function CreateTable({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('')
  const [rls, setRls] = useState(true)
  const [live, setLive] = useState(false)
  const [cols, setCols] = useState<NewCol[]>([{ name: 'name', type: 'text', nullable: true, def: '' }])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const statement = () => {
    const defs = [
      'id bigint generated by default as identity primary key',
      'created_at timestamptz not null default now()',
      ...cols.filter((c) => c.name.trim()).map((c) => `${qi(c.name.trim())} ${c.type}${c.nullable ? '' : ' not null'}${c.def ? ` default ${c.def}` : ''}`),
    ]
    const t = `public.${qi(name.trim())}`
    const parts = [`create table ${t} (\n  ${defs.join(',\n  ')}\n);`]
    if (rls) parts.push(`alter table ${t} enable row level security;`)
    if (live) parts.push(`create trigger kodudb_realtime after insert or update or delete on ${t} for each row execute function realtime.broadcast_change();`)
    return parts.join('\n')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await sql(`begin;\n${statement()}\ncommit;`)
      toast(`Created ${name.trim()}`)
      onCreated(name.trim())
      setName('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New table" description="Every table gets an id (identity primary key) and created_at." width="640px">
      <form onSubmit={submit}>
        <Flex direction="column" gap="3">
          <label className="flex flex-col gap-1.5">
            <Text size="2" weight="medium">Table name</Text>
            <TextField.Root required pattern="[A-Za-z_][A-Za-z0-9_]*" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders" />
          </label>
          <Text size="2" weight="medium">Columns</Text>
          {cols.map((c, i) => {
            const set = (patch: Partial<NewCol>) => setCols(cols.map((x, j) => (j === i ? { ...x, ...patch } : x)))
            return (
              <Flex key={i} gap="2" align="center" wrap="wrap">
                <TextField.Root aria-label="Column name" placeholder="column" value={c.name} onChange={(e) => set({ name: e.target.value })} className="flex-1" />
                <Select label="Column type" value={c.type} onChange={(v) => set({ type: v })} options={TYPES.map((t) => ({ value: t, label: t }))} width="150px" />
                <TextField.Root aria-label="Default expression" placeholder="default (SQL)" value={c.def} onChange={(e) => set({ def: e.target.value })} style={{ width: 130 }} />
                <Text as="label" size="2"><Flex gap="1" align="center"><Checkbox checked={c.nullable} onCheckedChange={(v) => set({ nullable: v === true })} />Nullable</Flex></Text>
                <IconButton type="button" variant="ghost" color="gray" aria-label="Remove column" onClick={() => setCols(cols.filter((_, j) => j !== i))}><X size={14} /></IconButton>
              </Flex>
            )
          })}
          <div><Button type="button" variant="soft" color="gray" onClick={() => setCols([...cols, { name: '', type: 'text', nullable: true, def: '' }])}><Plus size={14} />Add column</Button></div>
          <Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={rls} onCheckedChange={(v) => setRls(v === true)} />Turn on row security (recommended)</Flex></Text>
          <Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={live} onCheckedChange={(v) => setLive(v === true)} />Stream changes as live events</Flex></Text>
          <details>
            <summary><Text size="2" color="gray">SQL that will run</Text></summary>
            <pre className="mt-2 overflow-auto rounded-md p-3 text-xs" style={{ background: 'var(--gray-a2)', fontFamily: 'var(--code-font-family)' }}>{statement()}</pre>
          </details>
          <ErrorBox error={error} />
          <Flex gap="2" justify="end">
            <Button type="button" variant="soft" color="gray" onClick={onClose}>Cancel</Button>
            <Button loading={busy}>Create table</Button>
          </Flex>
        </Flex>
      </form>
    </Modal>
  )
}
