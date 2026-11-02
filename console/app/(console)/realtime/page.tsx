'use client'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Flex, Table, Text } from '@radix-ui/themes'
import { Pause, Play } from 'lucide-react'
import { TableInfo, kodu } from '@/lib/api'
import { Empty, ErrorBox, PageHeader, Select, useLoad } from '@/components/ui'

type Event = { type: string; table?: string; record?: unknown; error?: string; at: string }
const MAX_EVENTS = 200
const TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = { INSERT: 'green', UPDATE: 'amber', DELETE: 'red' }

export default function LiveEvents() {
  const tables = useLoad(() => kodu<TableInfo[]>('meta/v1/tables'))
  const [table, setTable] = useState('*')
  const [listening, setListening] = useState(false)
  const [events, setEvents] = useState<Event[]>([])
  const source = useRef<EventSource | null>(null)

  useEffect(() => () => source.current?.close(), [])

  function toggle() {
    if (listening) {
      source.current?.close()
      setListening(false)
      return
    }
    const es = new EventSource(`/api/realtime?table=${encodeURIComponent(table)}`)
    es.onmessage = (m) => {
      const ev = { ...JSON.parse(m.data), at: new Date().toLocaleTimeString() }
      if (ev.type === 'subscribed') return
      setEvents((prev) => [ev, ...prev].slice(0, MAX_EVENTS))
    }
    es.onerror = () => setEvents((prev) => [{ type: 'error', error: 'Stream disconnected; reconnecting', at: new Date().toLocaleTimeString() }, ...prev])
    source.current = es
    setListening(true)
  }

  const streaming = tables.data?.filter((t) => t.realtime) ?? []

  return (
    <>
      <PageHeader
        title="Live events"
        description="Inserts, updates and deletes as they happen. Your app receives the same stream over /realtime/v1/websocket, filtered by row security."
        actions={
          <>
            <Select label="Table" value={table} onChange={setTable} options={[{ value: '*', label: 'All streaming tables' }, ...streaming.map((t) => ({ value: t.name, label: t.name }))]} width="200px" />
            <Button onClick={toggle} variant={listening ? 'soft' : 'solid'} color={listening ? 'gray' : undefined}>
              {listening ? <><Pause size={15} />Pause</> : <><Play size={15} />Listen</>}
            </Button>
          </>
        }
      />
      <ErrorBox error={tables.error} />
      <Flex align="center" gap="2" mb="3">
        <Text size="2" color="gray">
          {streaming.length ? `${streaming.length} table${streaming.length === 1 ? '' : 's'} stream changes: ${streaming.map((t) => t.name).join(', ')}.` : 'No table streams changes yet. Turn live events on under Schema → Tables.'}
        </Text>
        <div className="flex-1" />
        {listening && <Badge color="red" variant="soft" aria-live="polite"><span className="size-1.5 animate-pulse rounded-full" style={{ background: 'var(--red-9)' }} />Listening</Badge>}
        <Button variant="ghost" color="gray" onClick={() => setEvents([])} disabled={!events.length}>Clear</Button>
      </Flex>
      {events.length ? (
        <Table.Root variant="ghost" size="1" className="kd-table">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Time</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Change</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Table</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Row</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {events.map((e, i) => (
              <Table.Row key={i} className="animate-in fade-in slide-in-from-top-1 duration-300">
                <Table.Cell className="num"><Text color="gray">{e.at}</Text></Table.Cell>
                <Table.Cell><Badge color={TONE[e.type] ?? 'gray'} variant="soft">{e.type.toLowerCase()}</Badge></Table.Cell>
                <Table.Cell><Text className="font-mono">{e.table ?? ''}</Text></Table.Cell>
                <Table.Cell><Text className="font-mono" size="1" title={JSON.stringify(e.record ?? e.error)}>{JSON.stringify(e.record ?? e.error ?? '')}</Text></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      ) : (
        <Empty>{listening ? 'Waiting for the first change…' : 'Press Listen, then insert or edit a row in a streaming table.'}</Empty>
      )}
    </>
  )
}
