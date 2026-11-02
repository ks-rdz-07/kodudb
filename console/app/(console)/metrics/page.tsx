'use client'
import { useEffect, useState } from 'react'
import { Card, Flex, Grid, SegmentedControl, Table, Text } from '@radix-ui/themes'
import { fmtBytes, kodu } from '@/lib/api'
import { BarList, LineChart, Point } from '@/components/charts'
import { ErrorBox, PageHeader, Section, Skeleton, Switch } from '@/components/ui'

type Bucket = { t: string; n: number; e4: number; e5: number; p50: number; p95: number }
type M = {
  bucket_seconds: number
  series: Bucket[]
  totals: { requests: number; errors: number; client_errors: number; p50: number; p95: number; p99: number }
  status: { class: string; n: number }[]
  services: { service: string; n: number; avg_ms: number }[]
  top_routes: { method: string; route: string; n: number; errors: number; p95: number }[]
  slowest: { at: string; method: string; path: string; status: number; ms: number }[]
  db: { cache_hit_pct: number | null; commits: number; rollbacks: number; deadlocks: number; rows_read: number; rows_written: number; connections: number; size: number }
  table_sizes: { name: string; bytes: number; rows: number }[]
}

const WINDOWS = [['15', '15m'], ['60', '1h'], ['360', '6h'], ['1440', '24h'], ['10080', '7d']] as const

/** Fill empty buckets with zeros so a gap reads as "no traffic", not as an interpolated line. */
function fill(series: Bucket[], minutes: number, step: number) {
  const by = new Map(series.map((b) => [new Date(b.t).getTime(), b]))
  const stepMs = step * 1000
  const end = Math.floor(Date.now() / stepMs) * stepMs
  const out: (Bucket & { ts: number })[] = []
  for (let ts = end - minutes * 60_000 + stepMs; ts <= end; ts += stepMs) {
    const b = by.get(ts)
    out.push({ ts, t: '', n: b?.n ?? 0, e4: b?.e4 ?? 0, e5: b?.e5 ?? 0, p50: b?.p50 ?? 0, p95: b?.p95 ?? 0 })
  }
  return out
}

export default function Metrics() {
  const [minutes, setMinutes] = useState('60')
  const [data, setData] = useState<M | null>(null)
  const [error, setError] = useState('')
  const [live, setLive] = useState(true)

  useEffect(() => {
    let stop = false
    const load = () => kodu<M>(`meta/v1/metrics?minutes=${minutes}`).then((d) => { if (!stop) { setData(d); setError('') } }, (e) => !stop && setError(e.message))
    load()
    const id = live ? setInterval(load, 10_000) : undefined
    return () => { stop = true; clearInterval(id) }
  }, [minutes, live])

  const filled = data ? fill(data.series, Number(minutes), data.bucket_seconds) : []
  const pts = (f: (b: Bucket) => number[]): Point[] => filled.map((b) => ({ t: b.ts, values: f(b) }))
  const t = data?.totals
  const errRate = t && t.requests ? (100 * t.errors) / t.requests : 0
  const per = data?.bucket_seconds === 60 ? 'minute' : data?.bucket_seconds === 600 ? '10 minutes' : 'hour'
  const label = WINDOWS.find(([m]) => m === minutes)?.[1]

  return (
    <>
      <PageHeader
        title="Metrics"
        description={t ? `${t.requests.toLocaleString()} requests in the last ${label}; ${t.errors ? `${t.errors} server errors (${errRate.toFixed(2)}%)` : 'no server errors'}; p95 ${t.p95} ms.` : 'Traffic, latency and database health for this project.'}
        actions={
          <>
            <SegmentedControl.Root value={minutes} onValueChange={setMinutes} aria-label="Time window">
              {WINDOWS.map(([m, l]) => <SegmentedControl.Item key={m} value={m}>{l}</SegmentedControl.Item>)}
            </SegmentedControl.Root>
            <Text as="label" size="2"><Flex gap="2" align="center"><Switch label="Refresh every 10 seconds" checked={live} onChange={setLive} />Auto-refresh</Flex></Text>
          </>
        }
      />
      <ErrorBox error={error} />
      {!data && !error && <Skeleton rows={6} />}
      {data && t && (
        <Flex direction="column" gap="5">
          <Card size="1" className="!p-0">
            <Grid columns={{ initial: '2', md: '6' }}>
              {[
                ['Requests', t.requests.toLocaleString(), ''],
                ['Server errors', errRate.toFixed(2), '%'],
                ['Client errors', t.client_errors.toLocaleString(), '4xx'],
                ['Latency p50', String(t.p50), 'ms'],
                ['Latency p95', String(t.p95), 'ms'],
                ['Latency p99', String(t.p99), 'ms'],
              ].map(([l, v, u], i) => (
                <div key={l} className="px-4 py-3" style={{ borderLeft: i ? '1px solid var(--gray-a4)' : undefined }}>
                  <Text as="div" size="2" weight="medium">{l}</Text>
                  <Text as="div" size="6" mt="1" className="num" color={l === 'Server errors' && errRate > 1 ? 'red' : undefined}>{v} <Text size="2" color="gray">{u}</Text></Text>
                </div>
              ))}
            </Grid>
          </Card>

          <Section title={`Requests per ${per}`}>
            <LineChart label={`Requests per ${per}`} area points={pts((b) => [b.n])} series={[{ name: 'Requests', color: 'var(--accent-9)' }]} />
          </Section>

          <Grid columns={{ initial: '1', md: '2' }} gap="5">
            <Section title="Latency">
              <LineChart label="Latency p95 and p50" unit=" ms" points={pts((b) => [b.p95, b.p50])} series={[{ name: 'p95', color: 'var(--accent-9)' }, { name: 'p50', color: 'var(--series-muted)' }]} />
            </Section>
            <Section title="Errors">
              <LineChart label="Server and client errors" points={pts((b) => [b.e5, b.e4])} series={[{ name: '5xx server', color: 'var(--status-critical)' }, { name: '4xx client', color: 'var(--status-warning)' }]} />
            </Section>
          </Grid>

          <Grid columns={{ initial: '1', md: '2' }} gap="5">
            <Section title="Traffic by service">
              <BarList label="Requests by service" items={data.services.map((s) => ({ name: s.service, value: s.n, note: `avg ${s.avg_ms} ms` }))} color="var(--accent-9)" />
            </Section>
            <Section title="Responses by status">
              <BarList label="Responses by status class" items={data.status.map((s) => ({ name: s.class, value: s.n }))} color="var(--gray-9)" />
            </Section>
          </Grid>

          <Section title="Busiest routes">
            <Table.Root variant="ghost" size="1" className="kd-table">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Route</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell className="num">Requests</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell className="num">Errors</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell className="num">p95</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.top_routes.map((r) => (
                  <Table.Row key={r.method + r.route}>
                    <Table.RowHeaderCell><Text className="font-mono" size="1"><Text color="gray">{r.method}</Text> {r.route}</Text></Table.RowHeaderCell>
                    <Table.Cell className="num">{r.n.toLocaleString()}</Table.Cell>
                    <Table.Cell className="num"><Text color={r.errors ? 'amber' : 'gray'}>{r.errors}</Text></Table.Cell>
                    <Table.Cell className="num">{r.p95} <Text color="gray">ms</Text></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Section>

          <Grid columns={{ initial: '1', md: '2' }} gap="5">
            <Section title="Slowest requests">
              <BarList label="Slowest requests" items={data.slowest.map((s) => ({ name: `${s.method} ${s.path}`, value: Number(s.ms), note: `${s.status} at ${new Date(s.at).toLocaleTimeString()}` }))} format={(v) => `${v} ms`} color="var(--gray-9)" />
            </Section>
            <Section title="Largest tables">
              <BarList label="Table sizes" items={data.table_sizes.map((s) => ({ name: s.name, value: s.bytes, note: `${s.rows} rows` }))} format={fmtBytes} color="var(--gray-9)" />
            </Section>
          </Grid>

          <Section title="Database">
            <Card size="1" className="!p-0">
              <Grid columns={{ initial: '2', md: '6' }}>
                {[
                  ['Cache hit', data.db.cache_hit_pct === null ? '—' : `${data.db.cache_hit_pct}%`],
                  ['Size', fmtBytes(data.db.size)],
                  ['Connections', String(data.db.connections)],
                  ['Commits', data.db.commits.toLocaleString()],
                  ['Rollbacks', data.db.rollbacks.toLocaleString()],
                  ['Deadlocks', String(data.db.deadlocks)],
                ].map(([l, v], i) => (
                  <div key={l} className="px-4 py-3" style={{ borderLeft: i ? '1px solid var(--gray-a4)' : undefined }}>
                    <Text as="div" size="2" color="gray">{l}</Text>
                    <Text as="div" size="4" mt="1" className="num" color={l === 'Deadlocks' && data.db.deadlocks ? 'red' : undefined}>{v}</Text>
                  </div>
                ))}
              </Grid>
            </Card>
          </Section>
        </Flex>
      )}
    </>
  )
}
