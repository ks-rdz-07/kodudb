'use client'
import { useEffect, useState } from 'react'
import { Badge, Button, Flex, Table, Text, TextField } from '@radix-ui/themes'
import { Search } from 'lucide-react'
import { kodu } from '@/lib/api'
import { Empty, ErrorBox, PageHeader, Select, Switch } from '@/components/ui'

type Log = { id: number; at: string; method: string; path: string; route: string | null; status: number; ms: number; ip: string | null }
const STATUS_TONE = (s: number) => (s >= 500 ? 'red' : s >= 400 ? 'amber' : 'gray') as 'red' | 'amber' | 'gray'

export default function RequestLogs() {
  const [status, setStatus] = useState('')
  const [method, setMethod] = useState('')
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [tail, setTail] = useState(true)
  const [rows, setRows] = useState<Log[]>([])
  const [error, setError] = useState('')

  const params = (extra: Record<string, string> = {}) =>
    new URLSearchParams(Object.entries({ status, method, q: term, limit: '200', ...extra }).filter(([, v]) => v) as [string, string][])

  useEffect(() => {
    let stop = false
    const load = () => kodu<Log[]>(`meta/v1/logs?${params()}`).then((r) => { if (!stop) { setRows(r); setError('') } }, (e) => !stop && setError(e.message))
    load()
    const id = tail ? setInterval(load, 3000) : undefined
    return () => { stop = true; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, method, term, tail])

  async function older() {
    const last = rows[rows.length - 1]
    if (!last) return
    setTail(false)
    try {
      setRows([...rows, ...(await kodu<Log[]>(`meta/v1/logs?${params({ before: String(last.id) })}`))])
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <PageHeader
        title="Request logs"
        description="Every API call to this project: data, identity, files, live events and data sources. Kept for 14 days."
        actions={<Text as="label" size="2"><Flex gap="2" align="center"><Switch label="Live tail" checked={tail} onChange={setTail} />Live tail{tail && <Badge color="red" variant="soft">live</Badge>}</Flex></Text>}
      />
      <form className="mb-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); setTerm(q) }}>
        <Select label="Status" value={status} onChange={setStatus} options={[{ value: '', label: 'All statuses' }, { value: 'errors', label: 'Errors (4xx and 5xx)' }, ...['2xx', '3xx', '4xx', '5xx'].map((s) => ({ value: s, label: s }))]} width="170px" />
        <Select label="Method" value={method} onChange={setMethod} options={[{ value: '', label: 'All methods' }, ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }))]} width="140px" />
        <TextField.Root aria-label="Search path" placeholder="Path contains, e.g. /rest/v1/orders" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 300 }}>
          <TextField.Slot><Search size={14} /></TextField.Slot>
        </TextField.Root>
        <Button variant="soft" color="gray" type="submit">Search</Button>
      </form>
      <ErrorBox error={error} />
      {rows.length ? (
        <Table.Root variant="ghost" size="1" className="kd-table">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Time</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Request</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell className="num">Duration</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Client</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((r) => (
              <Table.Row key={r.id}>
                <Table.Cell className="num"><Text color="gray">{new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Text></Table.Cell>
                <Table.Cell><Badge color={STATUS_TONE(r.status)} variant={r.status >= 400 ? 'soft' : 'outline'} className="num">{r.status}</Badge></Table.Cell>
                <Table.Cell><Text className="font-mono" size="1" title={r.route ?? ''}><Text color="gray">{r.method}</Text> {r.path}</Text></Table.Cell>
                <Table.Cell className="num">{r.ms.toFixed(1)} <Text color="gray">ms</Text></Table.Cell>
                <Table.Cell><Text className="font-mono" size="1" color="gray">{r.ip ?? '—'}</Text></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      ) : <Empty>No requests match these filters.</Empty>}
      <Flex align="center" gap="3" mt="3">
        <Button variant="soft" color="gray" onClick={older} disabled={!rows.length}>Load older</Button>
        <Text size="2" color="gray" className="num">{rows.length} shown</Text>
      </Flex>
    </>
  )
}
