'use client'
import Link from 'next/link'
import { Badge, Button, Card, Code, Flex, Grid, Link as RLink, Table, Text } from '@radix-ui/themes'
import { ArrowUpRight, CircleCheck } from 'lucide-react'
import { fmtBytes, kodu } from '@/lib/api'
import { LineChart } from '@/components/charts'
import { ErrorBox, KeyField, PageHeader, Section, Skeleton, useLoad } from '@/components/ui'

type Project = { slug: string; name: string; endpoint: string; publicKey: string; secretKey: string }
type Stats = { db_size: number; tables: number; users: number; buckets: number; objects: number; storage_bytes: number; logins_24h: number; connections: number; version: string }
type Metrics = { bucket_seconds: number; series: { t: string; n: number; e5: number; p95: number }[]; totals: { requests: number; errors: number; client_errors: number; p95: number } }
type Migration = { version: number; at: string; tag: string; object: string | null; pushed_at: string | null; git_sha: string | null }
type Policy = { table: string }
type Detail = { github_connected: boolean; git_branch: string }

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

export default function Overview({ project }: { project: Project }) {
  const stats = useLoad(() => kodu<Stats>('meta/v1/stats'))
  const metrics = useLoad(() => kodu<Metrics>('meta/v1/metrics?minutes=60'))
  const migrations = useLoad(() => kodu<Migration[]>('meta/v1/migrations'))
  const policies = useLoad(() => kodu<Policy[]>('meta/v1/policies'))
  const detail = useLoad(() => kodu<Detail>(`platform/v1/projects/${project.slug}`), [project.slug])

  const s = stats.data
  const t = metrics.data?.totals
  const pending = migrations.data?.filter((m) => !m.pushed_at).length ?? 0
  const errRate = t && t.requests ? (100 * t.errors) / t.requests : 0

  // The one finding, read first: errors beat pending migrations beat a quiet hour.
  const finding = !t ? 'Loading the last hour…'
    : t.errors > 0 ? `${t.errors} server error${t.errors === 1 ? '' : 's'} in the last hour (${errRate.toFixed(2)}% of ${t.requests.toLocaleString()} requests).`
    : pending > 0 ? `${pending} schema change${pending === 1 ? ' is' : 's are'} not on GitHub yet. ${t.requests.toLocaleString()} requests in the last hour, no server errors.`
    : `${t.requests.toLocaleString()} requests in the last hour, no server errors, schema in sync.`

  const setup = [
    { done: (s?.tables ?? 0) > 0, title: 'Create a table', text: 'Model your data in the explorer or with SQL.', href: '/tables' },
    { done: (policies.data?.filter((p) => !p.table.startsWith('objects')).length ?? 0) > 0, title: 'Add a row security policy', text: 'Decide who can read and write each row.', href: '/database' },
    { done: (s?.users ?? 0) > 0, title: 'Sign up a first user', text: 'Your app calls /auth/v1/signup with the public key.', href: '/auth' },
    { done: !!detail.data?.github_connected, title: 'Connect GitHub', text: 'Ship every schema change as a migration file.', href: '/versions' },
  ]
  const setupLeft = setup.filter((x) => !x.done).length

  const step = (metrics.data?.bucket_seconds ?? 60) * 1000
  const end = Math.floor(Date.now() / step) * step
  const byT = new Map(metrics.data?.series.map((b) => [new Date(b.t).getTime(), b]) ?? [])
  const points = Array.from({ length: 60 }, (_, i) => end - (59 - i) * step).map((ts) => ({ t: ts, values: [byT.get(ts)?.n ?? 0] }))

  return (
    <>
      <PageHeader
        title={project.name}
        description={finding}
        actions={<Button asChild><Link href="/tables">Open data explorer</Link></Button>}
      />

      {setupLeft > 0 && (
        <Card size="1" mb="5" className="!p-0">
          <Grid columns={{ initial: '1', sm: '2', md: '4' }}>
            {setup.map((x, i) => (
              <Link key={x.title} href={x.href} className="group block p-4 no-underline" style={{ borderLeft: i ? '1px solid var(--gray-a4)' : undefined, color: 'inherit' }}>
                <Flex justify="between" align="start" gap="2">
                  <Text size="2" weight="medium" color={x.done ? 'gray' : undefined}>{x.title}</Text>
                  {x.done ? <CircleCheck size={16} color="var(--accent-9)" aria-label="Done" /> : <ArrowUpRight size={16} color="var(--gray-9)" aria-hidden />}
                </Flex>
                <Text as="p" size="1" color="gray" mt="1">{x.text}</Text>
              </Link>
            ))}
          </Grid>
        </Card>
      )}

      <ErrorBox error={stats.error || metrics.error} />

      <Card size="1" mb="5" className="!p-0">
        <Grid columns={{ initial: '2', md: '5' }}>
          {[
            ['Requests', t ? t.requests.toLocaleString() : null, 'last hour'],
            ['Latency p95', t ? String(t.p95) : null, 'ms'],
            ['Server errors', t ? errRate.toFixed(2) : null, '%'],
            ['Users', s ? s.users.toLocaleString() : null, s ? `${s.logins_24h} sign-ins today` : ''],
            ['Database', s ? fmtBytes(s.db_size) : null, s ? `${s.tables} tables` : ''],
          ].map(([label, value, unit], i) => (
            <div key={label} className="px-4 py-3" style={{ borderLeft: i ? '1px solid var(--gray-a4)' : undefined }}>
              <Text as="div" size="2" weight="medium">{label}</Text>
              <Text as="div" size="6" className="num" mt="1" color={label === 'Server errors' && errRate > 1 ? 'red' : undefined}>
                {value ?? <span className="kd-null">—</span>} <Text size="2" color="gray">{unit}</Text>
              </Text>
            </div>
          ))}
        </Grid>
      </Card>

      <Grid columns={{ initial: '1', lg: '3' }} gap="5" mb="5">
        <div className="lg:col-span-2">
          <Section title="Requests per minute" aside={<RLink asChild size="2"><Link href="/metrics">Metrics</Link></RLink>}>
            {metrics.loading && !metrics.data ? <Skeleton rows={4} /> : <LineChart label="Requests per minute, last hour" area points={points} series={[{ name: 'Requests', color: 'var(--accent-9)' }]} />}
          </Section>
        </div>
        <Section
          title="Migrations"
          aside={<Flex gap="2" align="center"><Badge color={pending ? 'red' : 'gray'} variant="soft">{pending ? `${pending} not pushed` : 'in sync'}</Badge><RLink asChild size="2"><Link href="/versions">All</Link></RLink></Flex>}
        >
          {migrations.loading && !migrations.data ? <Skeleton rows={4} /> : (
            <ol className="flex flex-col">
              {migrations.data?.slice(0, 5).map((m) => (
                <li key={m.version} className="flex items-center gap-3 py-2" style={{ borderBottom: '1px solid var(--rule)' }}>
                  <span className="size-2 shrink-0 rounded-full" style={m.pushed_at ? { background: 'var(--gray-8)' } : { border: '1.5px solid var(--gray-9)' }} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <Text as="div" size="2" truncate>{m.tag} <Text color="gray">{m.object}</Text></Text>
                    <Text as="div" size="1" color="gray">v{m.version} · {ago(m.at)} · {m.pushed_at ? `pushed ${m.git_sha?.slice(0, 7) ?? ''}` : 'not pushed'}</Text>
                  </div>
                </li>
              ))}
              {migrations.data?.length === 0 && <Text size="2" color="gray">No schema changes yet. Create a table and it shows up here as version 1.</Text>}
            </ol>
          )}
        </Section>
      </Grid>

      <Grid columns={{ initial: '1', lg: '2' }} gap="5">
        <Section title="Connect your app">
          <Flex direction="column" gap="3">
            <KeyField label="API endpoint" value={project.endpoint} />
            <KeyField label="Public key" value={project.publicKey} hint="Safe in browsers and mobile apps. Row security policies decide what it can reach." />
            <KeyField label="Secret key" value={project.secretKey} secret hint="Server-side only. Skips row security. Rotate it under Projects & keys." />
          </Flex>
        </Section>
        <Section title="Resources">
          <Table.Root variant="ghost" size="1" className="kd-table">
            <Table.Body>
              {[
                ['Tables', s?.tables],
                ['Users', s?.users],
                ['File buckets', s?.buckets],
                ['Files', s ? `${s.objects} · ${fmtBytes(s.storage_bytes)}` : undefined],
                ['Open connections', s?.connections],
                ['Postgres', s?.version.split(' ')[0]],
              ].map(([k, v]) => (
                <Table.Row key={String(k)}>
                  <Table.RowHeaderCell><Text color="gray">{k}</Text></Table.RowHeaderCell>
                  <Table.Cell className="num">{v ?? <span className="kd-null">—</span>}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
          <Text as="p" size="1" color="gray" mt="3">Quick check: <Code size="1">curl {project.endpoint}/rest/v1/&lt;table&gt; -H &quot;apikey: …&quot;</Code></Text>
        </Section>
      </Grid>
    </>
  )
}
