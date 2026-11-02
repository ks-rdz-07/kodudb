'use client'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Badge, Button, Callout, Checkbox, Code, ContextMenu, DropdownMenu, Flex, IconButton, ScrollArea, Table, Text, TextArea, TextField, Tooltip,
} from '@radix-ui/themes'
import {
  Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Ellipsis, KeyRound, Pencil, Plus, RefreshCw, Search, Settings2, Trash2, TriangleAlert, X,
} from 'lucide-react'
import { Column, TableInfo, json, kodu, qi, sql } from '@/lib/api'
import { ARCHIVED_TABLES_SQL, type Generator, alterTableSql, archiveSql, dropSql, generatorOf, isInteger, primaryKeyDef, restoreSql, rewritesValues, transaction } from '@/lib/table-edit.mjs'
import { Cell, Empty, ErrorBox, Modal, PageHeader, Select, Skeleton, useConfirm, useLoad, useToast } from '@/components/ui'

const PAGE = 50
type Row = Record<string, unknown>
type Sort = { col: string; dir: 'asc' | 'desc' } | null

export default function Page() {
  return <Suspense><DataExplorer /></Suspense>
}

function DataExplorer() {
  const params = useSearchParams()
  const tables = useLoad(() => kodu<TableInfo[]>('meta/v1/tables'))
  const archived = useLoad(async () => (await sql(ARCHIVED_TABLES_SQL)).rows.map((r) => ({ name: String(r[0]), rows: Number(r[1] ?? 0) })))
  const [active, setActive] = useState<string | null>(params.get('t'))
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [find, setFind] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const toast = useToast()
  const confirm = useConfirm()

  useEffect(() => {
    if (!active && tables.data?.length) setActive(tables.data[0].name)
  }, [tables.data, active])

  const reloadAll = () => { tables.reload(); archived.reload() }
  const run = async (statements: string[], done: string) => {
    try {
      await sql(transaction(statements))
      toast(done)
      return true
    } catch (e) {
      toast((e as Error).message)
      return false
    }
  }

  async function archive(name: string) {
    const ok = await confirm({
      title: `Archive ${name}?`,
      description: 'The table leaves the public schema: the REST API, live events and your apps stop seeing it. Its rows, policies, indexes and triggers are kept, and you can restore it at any time.',
      action: 'Archive table',
    })
    if (ok && (await run(archiveSql(name), `${name} archived`))) {
      if (active === name) setActive(null)
      reloadAll()
    }
  }

  async function restore(name: string) {
    if (await run(restoreSql(name), `${name} restored`)) {
      reloadAll()
      setActive(name)
    }
  }

  async function remove(name: string, isArchived = false) {
    const ok = await confirm({
      title: `Delete ${name} permanently?`,
      description: 'The table and every row in it are deleted for good. Consider archiving instead if you might need it again.',
      action: 'Delete table',
      danger: true,
      typeToConfirm: name,
    })
    if (ok && (await run(dropSql(name, isArchived), `${name} deleted`))) {
      if (active === name) setActive(null)
      reloadAll()
    }
  }

  const visible = (tables.data ?? []).filter((t) => t.name.toLowerCase().includes(find.trim().toLowerCase()))
  const menuItems = (Item: typeof DropdownMenu.Item, Sep: typeof DropdownMenu.Separator, name: string) => (
    <>
      <Item onSelect={() => setEditing(name)}><Pencil size={14} />Modify table…</Item>
      <Item onSelect={() => archive(name)}><Archive size={14} />Archive</Item>
      <Sep />
      <Item color="red" onSelect={() => remove(name)}><Trash2 size={14} />Delete table…</Item>
    </>
  )

  return (
    <>
      <PageHeader
        title="Data explorer"
        description="Browse, search and edit rows in the public schema. Right-click a table to modify, archive or delete it."
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} />New table</Button>}
      />
      <ErrorBox error={tables.error} />
      <div className="grid items-start gap-5 lg:grid-cols-[232px_1fr]">
        <nav aria-label="Tables" className="flex flex-col gap-1">
          <TextField.Root size="1" placeholder="Find a table" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a table" mb="1">
            <TextField.Slot><Search size={13} /></TextField.Slot>
          </TextField.Root>
          <Text size="1" color="gray" className="px-2">{tables.data?.length ?? 0} tables</Text>
          {tables.loading && !tables.data && <Skeleton rows={4} />}
          {visible.map((t) => (
            <ContextMenu.Root key={t.name}>
              <ContextMenu.Trigger>
                <div className="group flex items-center gap-1">
                  <Button variant={t.name === active ? 'soft' : 'ghost'} color="gray" onClick={() => setActive(t.name)} className="!m-0 min-w-0 flex-1 !justify-between">
                    <Text truncate style={{ color: 'var(--gray-12)' }} weight={t.name === active ? 'medium' : 'regular'}>{t.name}</Text>
                    {!t.rls_enabled && <Tooltip content="Row security is off: the public key can read every row"><Badge color="amber" size="1">open</Badge></Tooltip>}
                  </Button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      <IconButton size="1" variant="ghost" color="gray" aria-label={`Actions for ${t.name}`} className="opacity-60 group-hover:opacity-100"><Ellipsis size={14} /></IconButton>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content size="1">{menuItems(DropdownMenu.Item, DropdownMenu.Separator, t.name)}</DropdownMenu.Content>
                  </DropdownMenu.Root>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Content size="1">{menuItems(ContextMenu.Item as typeof DropdownMenu.Item, ContextMenu.Separator as typeof DropdownMenu.Separator, t.name)}</ContextMenu.Content>
            </ContextMenu.Root>
          ))}
          {tables.data?.length === 0 && <Empty>No tables yet. Create one to start.</Empty>}

          {(archived.data?.length ?? 0) > 0 && (
            <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--gray-a5)' }}>
              <Button variant="ghost" color="gray" size="1" onClick={() => setShowArchived(!showArchived)} className="!m-0 w-full !justify-start">
                {showArchived ? <ChevronDown size={13} /> : <ChevronRight size={13} />}Archived ({archived.data?.length})
              </Button>
              {showArchived && archived.data?.map((a) => (
                <Flex key={a.name} align="center" gap="1" className="px-2 py-1">
                  <Archive size={12} style={{ color: 'var(--gray-9)' }} />
                  <Text size="2" color="gray" truncate className="flex-1">{a.name}</Text>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger><IconButton size="1" variant="ghost" color="gray" aria-label={`Actions for archived ${a.name}`}><Ellipsis size={14} /></IconButton></DropdownMenu.Trigger>
                    <DropdownMenu.Content size="1">
                      <DropdownMenu.Item onSelect={() => restore(a.name)}><ArchiveRestore size={14} />Restore</DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item color="red" onSelect={() => remove(a.name, true)}><Trash2 size={14} />Delete permanently…</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                </Flex>
              ))}
            </div>
          )}
        </nav>
        <section className="min-w-0">{active && <Grid key={active} table={active} onModify={() => setEditing(active)} />}</section>
      </div>
      <CreateTable open={creating} onClose={() => setCreating(false)} onCreated={(name) => { setCreating(false); reloadAll(); setActive(name) }} />
      {editing && (
        <EditTable table={editing} onClose={() => setEditing(null)}
          onDone={(name) => { setEditing(null); reloadAll(); setActive(name) }} />
      )}
    </>
  )
}

const NUMERIC = /int|numeric|double|real|decimal|serial/
const ORDERED = /int|numeric|double|real|decimal|serial|date|time/
const shortType = (t: string) => t.replace('timestamp with time zone', 'timestamptz').replace('timestamp without time zone', 'timestamp').replace('character varying', 'varchar').replace('double precision', 'float8')

/** A column search box value to a REST filter: text matches anywhere; numbers and dates accept =, !=, >, >=, <, <=. */
function columnFilter(c: Column, raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  if (v.toLowerCase() === 'null') return 'is.null'
  if (c.type === 'boolean') return ['true', 'false'].includes(v.toLowerCase()) ? `is.${v.toLowerCase()}` : null
  if (ORDERED.test(c.type)) {
    const m = v.match(/^(>=|<=|!=|=|>|<)?\s*(.+)$/)
    const op = { '>=': 'gte', '<=': 'lte', '!=': 'neq', '=': 'eq', '>': 'gt', '<': 'lt' }[m?.[1] ?? '='] ?? 'eq'
    return `${op}.${m?.[2] ?? v}`
  }
  return `ilike.*${v}*`
}

function Grid({ table, onModify }: { table: string; onModify: () => void }) {
  const cols = useLoad(() => kodu<Column[]>(`meta/v1/tables/${table}/columns`))
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<Sort>(null)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [colSearch, setColSearch] = useState<Record<string, string>>({})
  const [colQuery, setColQuery] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Row | 'new' | null>(null)
  const toast = useToast()
  const confirm = useConfirm()

  const columns = useMemo(() => cols.data ?? [], [cols.data])
  const pk = columns.filter((c) => c.primary_key).map((c) => c.name)

  // Typing settles for 300 ms before a request goes out.
  useEffect(() => { const t = setTimeout(() => { setQuery(search); setPage(0) }, 300); return () => clearTimeout(t) }, [search])
  useEffect(() => { const t = setTimeout(() => { setColQuery(colSearch); setPage(0) }, 300); return () => clearTimeout(t) }, [colSearch])

  async function load() {
    if (!cols.data) return
    const p = new URLSearchParams({ select: '*', limit: String(PAGE), offset: String(page * PAGE) })
    if (sort) p.set('order', `${sort.col}.${sort.dir}`)
    else if (pk.length) p.set('order', pk.map((k) => `${k}.asc`).join(','))
    const q = query.trim().replaceAll('"', '')
    if (q) p.set('or', `(${columns.map((c) => `${c.name}.ilike."*${q}*"`).join(',')})`)
    for (const c of columns) {
      const f = columnFilter(c, colQuery[c.name] ?? '')
      if (f) p.append(c.name, f)
    }
    setLoading(true)
    try {
      const res = await fetch(`/api/kodu/rest/v1/${table}?${p}`, { headers: { prefer: 'count=exact' } })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error)
      setRows(body)
      setTotal(Number(res.headers.get('x-total-count') ?? body.length))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [cols.data, page, sort, query, colQuery])

  const match = (r: Row) => pk.map((k) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(String(r[k]))}`).join('&')
  const cycleSort = (col: string) => {
    setPage(0)
    setSort(sort?.col !== col ? { col, dir: 'asc' } : sort.dir === 'asc' ? { col, dir: 'desc' } : null)
  }
  const filtered = Boolean(query.trim()) || Object.values(colQuery).some((v) => v.trim())
  const clearFilters = () => { setSearch(''); setColSearch({}) }

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
        <Flex direction="column" mr="2">
          <Text size="4" weight="medium" className="font-mono">{table}</Text>
          <Text size="1" color="gray" className="num">{total.toLocaleString()} rows{filtered ? ' match' : ''} · {columns.length} columns</Text>
        </Flex>
        <TextField.Root placeholder="Search all columns" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search all columns" className="min-w-56 flex-1" style={{ maxWidth: 360 }}>
          <TextField.Slot><Search size={14} /></TextField.Slot>
          {search && <TextField.Slot><IconButton size="1" variant="ghost" color="gray" aria-label="Clear search" onClick={() => setSearch('')}><X size={12} /></IconButton></TextField.Slot>}
        </TextField.Root>
        {filtered && <Button variant="ghost" color="gray" size="1" onClick={clearFilters}>Clear filters</Button>}
        <div className="flex-1" />
        <Tooltip content="Reload rows"><IconButton variant="soft" color="gray" aria-label="Reload rows" onClick={load} loading={loading}><RefreshCw size={15} /></IconButton></Tooltip>
        <Tooltip content="Modify table"><IconButton variant="soft" color="gray" aria-label="Modify table" onClick={onModify}><Settings2 size={15} /></IconButton></Tooltip>
        <Button onClick={() => setEditing('new')} disabled={!columns.length}><Plus size={15} />Insert row</Button>
      </Flex>

      <ErrorBox error={error || cols.error} />
      {cols.loading && <Skeleton rows={8} />}
      {!pk.length && columns.length > 0 && <Text size="2" color="gray">This table has no primary key, so rows can be inserted here but not edited or deleted.</Text>}

      {columns.length > 0 && (
        <div className="kd-grid overflow-hidden rounded-lg border" style={{ borderColor: 'var(--gray-a5)' }}>
          <ScrollArea type="auto" scrollbars="both" style={{ maxHeight: '64vh' }}>
            <Table.Root variant="ghost" size="1" className="kd-table">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell className="kd-num-col">#</Table.ColumnHeaderCell>
                  {columns.map((c) => {
                    const dir = sort?.col === c.name ? sort.dir : null
                    return (
                      <Table.ColumnHeaderCell key={c.name} className={NUMERIC.test(c.type) ? 'num' : ''} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
                        <button type="button" onClick={() => cycleSort(c.name)} className="kd-sort" title={`Sort by ${c.name}`} aria-label={`Sort by ${c.name}`}>
                          {c.primary_key && <KeyRound size={11} style={{ color: 'var(--accent-9)' }} aria-label="primary key" />}
                          <span className="kd-colname">{c.name}</span>
                          {dir === 'asc' ? <ArrowUp size={12} /> : dir === 'desc' ? <ArrowDown size={12} /> : <ArrowUpDown size={12} className="kd-sort-idle" />}
                        </button>
                        <span className="kd-coltype">{shortType(c.type)}</span>
                      </Table.ColumnHeaderCell>
                    )
                  })}
                </Table.Row>
                <Table.Row className="kd-filter-row">
                  <Table.ColumnHeaderCell className="kd-num-col" />
                  {columns.map((c) => (
                    <Table.ColumnHeaderCell key={c.name}>
                      <TextField.Root size="1" variant="soft" color="gray" value={colSearch[c.name] ?? ''} aria-label={`Search ${c.name}`}
                        placeholder={c.type === 'boolean' ? 'true / false' : ORDERED.test(c.type) ? '= > <' : 'Search'}
                        onChange={(e) => setColSearch({ ...colSearch, [c.name]: e.target.value })} />
                    </Table.ColumnHeaderCell>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((r, i) => (
                  <Table.Row key={i} className="kd-row">
                    <Table.Cell className="kd-num-col">
                      <Flex align="center" gap="3">
                        <span className="kd-rownum">{page * PAGE + i + 1}</span>
                        {pk.length > 0 && (
                          <Flex gap="2" className="kd-actions">
                            <Tooltip content="Edit row"><IconButton size="1" variant="soft" color="gray" aria-label="Edit row" onClick={() => setEditing(r)}><Pencil size={13} /></IconButton></Tooltip>
                            <Tooltip content="Delete row"><IconButton size="1" variant="soft" color="red" aria-label="Delete row" onClick={() => remove(r)}><Trash2 size={13} /></IconButton></Tooltip>
                          </Flex>
                        )}
                      </Flex>
                    </Table.Cell>
                    {columns.map((c) => <Cell key={c.name} v={r[c.name]} />)}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
            {rows.length === 0 && !loading && <div className="py-6"><Empty>{filtered ? 'No rows match this search.' : 'This table has no rows yet.'}</Empty></div>}
          </ScrollArea>
        </div>
      )}

      <Flex align="center" gap="2">
        <Text size="2" color="gray" className="num">{first.toLocaleString()}–{(page * PAGE + rows.length).toLocaleString()} of {total.toLocaleString()}</Text>
        <div className="flex-1" />
        <Text size="1" color="gray" className="num">Page {page + 1} of {pages}</Text>
        <Button variant="soft" color="gray" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
        <Button variant="soft" color="gray" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</Button>
      </Flex>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? `Insert into ${table}` : `Edit row in ${table}`}>
        <RowForm columns={columns} row={editing === 'new' ? null : editing} onSave={save} onCancel={() => setEditing(null)} />
      </Modal>
    </Flex>
  )
}

type EditCol = { orig: string | null; name: string; type: string; nullable: boolean; def: string; drop: boolean; using: string; generate?: Generator }

const GENERATE_LABEL: Record<Generator, string> = { identity: 'Auto-increment', uuid: 'Random uuid', none: 'None (set by app)' }
/** Generator choices that fit a key's type. */
const generatorsFor = (type: string): Generator[] => (isInteger(type) ? ['identity', 'none'] : type === 'uuid' ? ['uuid', 'none'] : ['none'])
/** Keep the chosen generator when the type still allows it, otherwise pick the natural one for the new type. */
const regenerate = (type: string, current?: Generator): Generator | undefined => {
  if (!current) return undefined
  const ok = generatorsFor(type)
  return ok.includes(current) ? current : ok[0]
}

function EditTable({ table, onClose, onDone }: { table: string; onClose: () => void; onDone: (name: string) => void }) {
  const cols = useLoad(() => kodu<Column[]>(`meta/v1/tables/${table}/columns`))
  const [name, setName] = useState(table)
  const [edited, setEdited] = useState<EditCol[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => {
    if (cols.data && !edited) {
      setEdited(cols.data.map((c) => ({ orig: c.name, name: c.name, type: c.type, nullable: c.nullable, def: c.default ?? '', drop: false, using: '', generate: c.primary_key ? generatorOf(c) : undefined })))
    }
  }, [cols.data, edited])

  const original = cols.data ?? []
  const byName = (n: string | null) => original.find((c) => c.name === n)
  let statements: string[] = []
  let invalid = ''
  try {
    if (edited) statements = alterTableSql({ name: table, columns: original }, { name, columns: edited })
  } catch (e) {
    invalid = (e as Error).message
  }
  const set = (i: number, patch: Partial<EditCol>) => setEdited((edited ?? []).map((c, j) => (j === i ? { ...c, ...patch } : c)))

  async function apply(e: React.FormEvent) {
    e.preventDefault()
    if (!statements.length) return onClose()
    setBusy(true)
    setError('')
    try {
      await sql(transaction(statements))
      toast(`${table} updated`)
      onDone(name.trim())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Modify ${table}`} description="Changes run together in one transaction: if any step fails, nothing changes." width="860px">
      <form onSubmit={apply}>
        <Flex direction="column" gap="3">
          <label className="flex flex-col gap-1.5">
            <Text size="2" weight="medium">Table name</Text>
            <TextField.Root required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <ErrorBox error={cols.error} />
          {!edited && <Skeleton rows={4} />}
          {edited && (
            <div className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--gray-a5)' }}>
              <Table.Root size="1" variant="ghost">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Column</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Nullable</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Default / generate</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell aria-label="Remove" />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {edited.map((c, i) => {
                    const before = byName(c.orig)
                    const typeChanged = before && c.type !== before.type
                    const rewrites = before && rewritesValues(before, c.type)
                    return (
                      <Table.Row key={i} style={{ opacity: c.drop ? 0.45 : 1 }}>
                        <Table.Cell>
                          <Flex align="center" gap="2">
                            {before?.primary_key && <Tooltip content="Primary key"><KeyRound size={13} style={{ color: 'var(--accent-9)', flex: 'none' }} /></Tooltip>}
                            <TextField.Root size="1" value={c.name} disabled={c.drop} aria-label="Column name" placeholder="new_column" onChange={(e) => set(i, { name: e.target.value })} />
                            {c.orig === null && <Badge size="1" color="green">new</Badge>}
                          </Flex>
                        </Table.Cell>
                        <Table.Cell>
                          <Flex direction="column" gap="1">
                            <Select label="Column type" value={c.type} width="170px" onChange={(v) => set(i, { type: v, using: '', generate: regenerate(v, c.generate) })}
                              options={[...new Set([...TYPES, c.type, before?.type ?? 'text'])].map((t) => ({ value: t, label: t }))} />
                            {typeChanged && (
                              <TextField.Root size="1" value={c.using} placeholder={rewrites ? 'gen_random_uuid()' : `${c.name}::${c.type}`} aria-label="Convert using"
                                onChange={(e) => set(i, { using: e.target.value })} title="Optional: SQL expression that converts existing values" />
                            )}
                          </Flex>
                        </Table.Cell>
                        <Table.Cell><Checkbox checked={c.nullable} disabled={c.drop} onCheckedChange={(v) => set(i, { nullable: v === true })} aria-label="Nullable" /></Table.Cell>
                        <Table.Cell>
                          {c.generate ? (
                            <Flex direction="column" gap="1">
                              <Select label="Generate key" value={c.generate} width="170px" onChange={(v) => set(i, { generate: v as Generator, def: v === 'uuid' ? 'gen_random_uuid()' : v === 'none' ? '' : c.def })}
                                options={generatorsFor(c.type).map((g) => ({ value: g, label: GENERATE_LABEL[g] }))} />
                              {c.generate === 'none' && <TextField.Root size="1" value={c.def} aria-label="Default expression" placeholder="default (SQL)" onChange={(e) => set(i, { def: e.target.value })} />}
                            </Flex>
                          ) : (
                            <TextField.Root size="1" value={c.def} disabled={c.drop} aria-label="Default expression" placeholder="none" onChange={(e) => set(i, { def: e.target.value })} />
                          )}
                        </Table.Cell>
                        <Table.Cell justify="end">
                          {c.orig === null ? (
                            <IconButton type="button" size="1" variant="ghost" color="gray" aria-label="Remove new column" onClick={() => setEdited(edited.filter((_, j) => j !== i))}><X size={13} /></IconButton>
                          ) : (
                            <Tooltip content={before?.primary_key ? 'The primary key cannot be dropped' : c.drop ? 'Keep column' : 'Drop column'}>
                              <IconButton type="button" size="1" variant="ghost" color={c.drop ? 'gray' : 'red'} disabled={before?.primary_key} aria-label={c.drop ? 'Keep column' : 'Drop column'} onClick={() => set(i, { drop: !c.drop })}>
                                {c.drop ? <ArchiveRestore size={13} /> : <Trash2 size={13} />}
                              </IconButton>
                            </Tooltip>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    )
                  })}
                </Table.Body>
              </Table.Root>
            </div>
          )}
          <div>
            <Button type="button" variant="soft" color="gray" disabled={!edited}
              onClick={() => setEdited([...(edited ?? []), { orig: null, name: '', type: 'text', nullable: true, def: '', drop: false, using: '' }])}>
              <Plus size={14} />Add column
            </Button>
          </div>
          {edited?.some((c) => { const b = byName(c.orig); return b && !c.using && rewritesValues(b, c.type) }) && (
            <Callout.Root color="amber" size="1">
              <Callout.Icon><TriangleAlert size={15} /></Callout.Icon>
              <Callout.Text>Changing an integer key to uuid gives every row a new value (gen_random_uuid()). Foreign keys and apps that store the old ids must be updated too.</Callout.Text>
            </Callout.Root>
          )}
          <details open={statements.length > 0}>
            <summary><Text size="2" color="gray">SQL that will run ({statements.length} {statements.length === 1 ? 'statement' : 'statements'})</Text></summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md p-3 text-xs" style={{ background: 'var(--gray-a2)', fontFamily: 'var(--code-font-family)' }}>
              {invalid ? `-- ${invalid}` : statements.length ? statements.map((s) => `${s};`).join('\n') : '-- no changes'}
            </pre>
          </details>
          <ErrorBox error={error || invalid} />
          <Flex gap="2" justify="end">
            <Button type="button" variant="soft" color="gray" onClick={onClose}>Cancel</Button>
            <Button loading={busy} disabled={Boolean(invalid) || !edited}>{statements.length ? 'Apply changes' : 'Close'}</Button>
          </Flex>
        </Flex>
      </form>
    </Modal>
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
  const [key, setKey] = useState<Generator>('identity')
  const [cols, setCols] = useState<NewCol[]>([{ name: 'name', type: 'text', nullable: true, def: '' }])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const statement = () => {
    const defs = [
      primaryKeyDef(key),
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
    <Modal open={open} onClose={onClose} title="New table" description="Every table gets an id primary key and created_at." width="640px">
      <form onSubmit={submit}>
        <Flex direction="column" gap="3">
          <label className="flex flex-col gap-1.5">
            <Text size="2" weight="medium">Table name</Text>
            <TextField.Root required pattern="[A-Za-z_][A-Za-z0-9_]*" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders" />
          </label>
          <label className="flex flex-col gap-1.5">
            <Text size="2" weight="medium">Primary key (id)</Text>
            <Select label="Primary key" value={key} onChange={(v) => setKey(v as Generator)} width="100%" options={[
              { value: 'identity', label: 'bigint, auto-increment (1, 2, 3...)' },
              { value: 'uuid', label: 'uuid, random (gen_random_uuid)' },
              { value: 'none', label: 'bigint, set by the app' },
            ]} />
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
