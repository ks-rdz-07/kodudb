'use client'
import { useState } from 'react'
import { Badge, Code, Flex, IconButton, Table, Text } from '@radix-ui/themes'
import { RefreshCw } from 'lucide-react'
import { TableInfo, kodu, qi, sql } from '@/lib/api'
import { Empty, ErrorBox, PageHeader, Select, Skeleton, Switch, useLoad, useToast } from '@/components/ui'

type Change = { id: number; at: string; table_name: string; op: string; actor: string | null; actor_email: string | null; actor_role: string | null; old_record: Record<string, unknown> | null; new_record: Record<string, unknown> | null }
type Tracked = TableInfo & { history: boolean }
const TONE: Record<string, 'green' | 'amber' | 'red'> = { INSERT: 'green', UPDATE: 'amber', DELETE: 'red' }

const show = (v: unknown) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** One line per changed field: "status: pending → paid". Inserts and deletes list the whole row. */
function Diff({ c }: { c: Change }) {
  if (!c.old_record || !c.new_record) {
    const r = (c.new_record ?? c.old_record ?? {}) as Record<string, unknown>
    return <Text size="1" className="font-mono" color="gray">{Object.entries(r).map(([k, v]) => `${k}: ${show(v)}`).join(' · ')}</Text>
  }
  const keys = Object.keys({ ...c.old_record, ...c.new_record }).filter((k) => show(c.old_record?.[k]) !== show(c.new_record?.[k]))
  return (
    <Flex direction="column" gap="1">
      {keys.map((k) => (
        <Text key={k} size="1" className="font-mono">
          {k}: <Text color="gray" style={{ textDecoration: 'line-through' }}>{show(c.old_record?.[k])}</Text> → {show(c.new_record?.[k])}
        </Text>
      ))}
    </Flex>
  )
}

export default function ChangeLog() {
  const tables = useLoad(() => kodu<Tracked[]>('meta/v1/tables'))
  const [table, setTable] = useState('')
  const changes = useLoad(() => kodu<Change[]>(`meta/v1/history?table=${encodeURIComponent(table)}&limit=300`), [table])
  const toast = useToast()

  async function toggle(t: Tracked) {
    const ref = `public.${qi(t.name)}`
    try {
      await sql(t.history ? `drop trigger kodudb_history on ${ref}` : `create trigger kodudb_history after insert or update or delete on ${ref} for each row execute function history.capture()`)
      toast(`Change log ${t.history ? 'off' : 'on'} for ${t.name}`)
      tables.reload()
    } catch (e) {
      tables.setError((e as Error).message)
    }
  }

  const tracked = tables.data?.filter((t) => t.history).length ?? 0

  return (
    <>
      <PageHeader
        title="Change log"
        description="Who changed which row, and the exact values before and after. Turn it on per table."
        actions={
          <>
            <Select label="Filter by table" value={table} onChange={setTable} options={[{ value: '', label: 'All tables' }, ...(tables.data ?? []).map((t) => ({ value: t.name, label: t.name }))]} width="180px" />
            <IconButton variant="soft" color="gray" aria-label="Reload changes" onClick={changes.reload}><RefreshCw size={15} /></IconButton>
          </>
        }
      />
      <ErrorBox error={tables.error || changes.error} />
      <div className="grid items-start gap-5 lg:grid-cols-[208px_1fr]">
        <aside className="flex flex-col gap-2">
          <Text size="1" color="gray" className="px-1">Recording {tracked} of {tables.data?.length ?? 0} tables</Text>
          {tables.data?.map((t) => (
            <Text as="label" size="2" key={t.name}>
              <Flex justify="between" align="center" gap="2" px="1">
                <Text truncate className="font-mono">{t.name}</Text>
                <Switch label={`Record changes to ${t.name}`} checked={t.history} onChange={() => toggle(t)} />
              </Flex>
            </Text>
          ))}
        </aside>
        <section className="min-w-0">
          {changes.loading && !changes.data ? <Skeleton /> : changes.data?.length ? (
            <Table.Root variant="ghost" size="1" className="kd-table">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>When</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Change</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Table</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>By</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Values</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {changes.data.map((c) => (
                  <Table.Row key={c.id} align="start">
                    <Table.Cell className="num"><Text color="gray">{new Date(c.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text></Table.Cell>
                    <Table.Cell><Badge color={TONE[c.op] ?? 'gray'} variant="soft">{c.op.toLowerCase()}</Badge></Table.Cell>
                    <Table.Cell><Code size="1" variant="ghost">{c.table_name}</Code></Table.Cell>
                    <Table.Cell>{c.actor_email ?? <Text color="gray">{c.actor_role === 'service_role' ? 'secret key' : c.actor_role ?? 'database'}</Text>}</Table.Cell>
                    <Table.Cell style={{ whiteSpace: 'normal', maxWidth: 520 }}><Diff c={c} /></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          ) : <Empty>No changes recorded yet. Switch recording on for a table, then edit a row.</Empty>}
        </section>
      </div>
    </>
  )
}
