'use client'
import { useState } from 'react'
import { Button, Callout, Flex, IconButton, Text, Tooltip } from '@radix-ui/themes'
import { Copy, Eye, EyeOff, RotateCw } from 'lucide-react'
import { kodu } from '@/lib/api'
import { ErrorBox, KeyField, Section, Skeleton, Tabs, useConfirm, useLoad, useToast } from '@/components/ui'

type Details = { configured: boolean; host: string | null; port: number; database: string; user: string; password: string; sslmode: string; uri: string }

const MASK = '••••••••'
const NPGSQL_SSL: Record<string, string> = { disable: 'Disable', prefer: 'Prefer', require: 'Require', 'verify-ca': 'VerifyCA', 'verify-full': 'VerifyFull' }
const q = JSON.stringify // a double-quoted string literal that is valid in JS, Python, Go, Java and C#
const enc = encodeURIComponent

/** Connection string with the password swapped for `pw` (already URL-safe or masked). */
const uriWith = (d: Details, host: string, pw: string) => `postgresql://${enc(d.user)}:${pw}@${host}:${d.port}/${enc(d.database)}?sslmode=${d.sslmode}`

export const SNIPPETS: { value: string; label: string; code: (d: Details, host: string, pw: string, uri: string) => string }[] = [
  { value: 'uri', label: 'URI', code: (_d, _h, _pw, uri) => uri },
  { value: 'psql', label: 'psql', code: (_d, _h, _pw, uri) => `psql ${q(uri)}` },
  { value: 'node', label: 'Node.js', code: (_d, _h, _pw, uri) => `// npm install pg\nimport pg from 'pg'\n\nconst client = new pg.Client({ connectionString: ${q(uri)} })\nawait client.connect()\nconsole.log((await client.query('select now()')).rows)\nawait client.end()` },
  { value: 'python', label: 'Python', code: (_d, _h, _pw, uri) => `# pip install "psycopg[binary]"\nimport psycopg\n\nwith psycopg.connect(${q(uri)}) as conn:\n    print(conn.execute("select now()").fetchone())` },
  { value: 'go', label: 'Go', code: (_d, _h, _pw, uri) => `// go get github.com/jackc/pgx/v5\nconn, err := pgx.Connect(context.Background(), ${q(uri)})\nif err != nil {\n\tlog.Fatal(err)\n}\ndefer conn.Close(context.Background())` },
  { value: 'java', label: 'Java', code: (d, h, pw) => `// JDBC driver: org.postgresql:postgresql\nString url = "jdbc:postgresql://${h}:${d.port}/${enc(d.database)}?sslmode=${d.sslmode}";\nConnection conn = DriverManager.getConnection(url, ${q(d.user)}, ${q(pw)});` },
  { value: 'csharp', label: 'C#', code: (d, h, pw) => `// dotnet add package Npgsql\nvar cs = ${q(`Host=${h};Port=${d.port};Database=${d.database};Username=${d.user};Password=${pw};SSL Mode=${NPGSQL_SSL[d.sslmode]}`)};\nawait using var conn = new NpgsqlConnection(cs);\nawait conn.OpenAsync();` },
  { value: 'rust', label: 'Rust', code: (_d, _h, _pw, uri) => `// sqlx with the "postgres" and "tls-rustls" features\nlet pool = sqlx::PgPool::connect(${q(uri)}).await?;` },
]

function Code({ shown, copy }: { shown: string; copy: string }) {
  const toast = useToast()
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md p-3 pr-10 font-mono text-xs" style={{ background: 'var(--gray-a3)' }}><code>{shown}</code></pre>
      <Tooltip content="Copy">
        <IconButton size="1" variant="ghost" color="gray" aria-label="Copy snippet" className="!absolute right-2 top-2" onClick={async () => { await navigator.clipboard.writeText(copy); toast('Snippet copied') }}>
          <Copy size={14} />
        </IconButton>
      </Tooltip>
    </div>
  )
}

export function DirectConnection({ slug }: { slug: string }) {
  const [tab, setTab] = useState('uri')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const confirm = useConfirm()
  const conn = useLoad(() => (slug === 'default' ? Promise.resolve(null) : kodu<Details>(`platform/v1/projects/${slug}/connection`)), [slug])
  const d = conn.data

  async function rotate() {
    if (!(await confirm({ title: 'Rotate the database password?', description: 'A new password is issued and open direct connections are closed. Update every app and tool that uses it.', action: 'Rotate password', danger: true }))) return
    setBusy(true)
    try {
      await kodu(`platform/v1/projects/${slug}/connection/rotate`, { method: 'POST' })
      await conn.reload()
      toast('New database password issued')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const host = d?.host ?? 'your-db-host'
  const snippet = SNIPPETS.find((s) => s.value === tab) ?? SNIPPETS[0]

  return (
    <Section title="Direct connection" aside={d && <Button size="1" variant="soft" color="red" loading={busy} onClick={rotate}><RotateCw size={14} />Rotate password</Button>}>
      <Flex direction="column" gap="3">
        {slug === 'default' && <Callout.Root size="1" color="gray"><Callout.Text>The default project shares the platform database, so it has no direct connection. Create a project to get one.</Callout.Text></Callout.Root>}
        <ErrorBox error={conn.error} />
        {conn.loading && !d && slug !== 'default' && <Skeleton rows={3} />}
        {d && (
          <>
            {!d.configured && (
              <Callout.Root size="1" color="amber" role="status">
                <Callout.Text>
                  The database address is not set, so snippets use a placeholder host. Publish the Postgres port, then set DB_PUBLIC_HOST and DB_PUBLIC_PORT (and DB_PUBLIC_SSLMODE) on the API and restart it. Keep the port closed to the internet unless a firewall or private network limits who can reach it.
                </Callout.Text>
              </Callout.Root>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <KeyField label="Host" value={host} />
              <KeyField label="Port" value={String(d.port)} />
              <KeyField label="Database" value={d.database} />
              <KeyField label="User" value={d.user} />
              <KeyField label="Password" value={d.password} secret />
              <KeyField label="SSL mode" value={d.sslmode} />
            </div>
            <KeyField label="Connection string" value={d.uri} secret hint="The password is part of this string. Keep it out of source control." />
            <Flex align="center" justify="between" gap="2">
              <Text size="2" weight="medium">Snippets</Text>
              <Button size="1" variant="ghost" color="gray" onClick={() => setReveal(!reveal)}>{reveal ? <EyeOff size={14} /> : <Eye size={14} />}{reveal ? 'Hide password' : 'Show password'}</Button>
            </Flex>
            <Tabs tabs={SNIPPETS.map(({ value, label }) => ({ value, label }))} value={tab} onChange={setTab}>
              <Code
                shown={snippet.code(d, host, reveal ? enc(d.password) : MASK, reveal ? d.uri : uriWith(d, host, MASK))}
                copy={snippet.code(d, host, d.password, d.uri)}
              />
            </Tabs>
            <Text size="1" color="gray">
              Direct connections are for servers and tools; they are not limited by row security policies unless the role is subject to them. This login can use only this project&apos;s database and acts as its table owner, so tables it creates appear in the API like any other.
            </Text>
          </>
        )}
      </Flex>
    </Section>
  )
}
