'use client'
import { useEffect, useState } from 'react'
import { Button, Flex, IconButton, Kbd, Text, Tooltip } from '@radix-ui/themes'
import { Play, Save, Trash2 } from 'lucide-react'
import { SqlResult, sql } from '@/lib/api'
import { SqlEditor, useSchema } from '@/components/sql-editor'
import { DataTable, ErrorBox, Modal, PageHeader, useConfirm, useToast } from '@/components/ui'
import { TextField } from '@radix-ui/themes'

const SNIPPETS_KEY = 'kodudb.sql.snippets'
type Snippet = { name: string; query: string }

const EXAMPLES: Snippet[] = [
  { name: 'Tables and row counts', query: "select relname as table, n_live_tup as rows\nfrom pg_stat_user_tables\nwhere schemaname = 'public'\norder by rows desc;" },
  {
    name: 'Owner-only row security',
    query: `alter table public.todos enable row level security;
create policy "owners manage their rows" on public.todos
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());`,
  },
  { name: 'Stream a table as live events', query: 'create trigger kodudb_realtime after insert or update or delete on public.todos\n  for each row execute function realtime.broadcast_change();' },
  { name: 'Track row changes', query: 'create trigger kodudb_history after insert or update or delete on public.todos\n  for each row execute function history.capture();' },
]

function loadSnippets(): Snippet[] {
  try {
    return JSON.parse(localStorage.getItem(SNIPPETS_KEY) ?? '[]')
  } catch {
    return []
  }
}

export default function QueryConsole() {
  const [query, setQuery] = useState('select now();')
  const [result, setResult] = useState<SqlResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [naming, setNaming] = useState(false)
  const [snippetName, setSnippetName] = useState('')
  const schema = useSchema()
  const toast = useToast()
  const confirm = useConfirm()

  useEffect(() => setSnippets(loadSnippets()), [])

  const persist = (s: Snippet[]) => {
    setSnippets(s)
    try {
      localStorage.setItem(SNIPPETS_KEY, JSON.stringify(s))
    } catch {}
  }

  async function run() {
    setBusy(true)
    setError('')
    try {
      setResult(await sql(query))
    } catch (e) {
      setResult(null)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Query console"
        description={<>Runs as the database owner. Table and column names complete as you type; <Kbd size="1">Ctrl Enter</Kbd> runs.</>}
        actions={
          <>
            <Button variant="soft" color="gray" onClick={() => { setSnippetName(''); setNaming(true) }}><Save size={15} />Save query</Button>
            <Button onClick={run} loading={busy} disabled={!query.trim()}><Play size={15} />Run</Button>
          </>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[208px_1fr]">
        <aside className="flex flex-col gap-4">
          <div>
            <Text as="div" size="1" color="gray" mb="1" className="px-2">Saved</Text>
            {snippets.map((s, i) => (
              <Flex key={i} align="center" gap="1">
                <Button variant="ghost" color="gray" className="!m-0 !flex-1 !justify-start" onClick={() => setQuery(s.query)}><Text truncate style={{ color: 'var(--gray-12)' }}>{s.name}</Text></Button>
                <Tooltip content="Delete saved query">
                  <IconButton size="1" variant="ghost" color="gray" aria-label={`Delete ${s.name}`} onClick={async () => {
                    if (await confirm({ title: `Delete “${s.name}”?`, description: 'The saved query is removed from this browser.', action: 'Delete', danger: true })) persist(snippets.filter((_, j) => j !== i))
                  }}><Trash2 size={13} /></IconButton>
                </Tooltip>
              </Flex>
            ))}
            {!snippets.length && <Text as="p" size="2" color="gray" className="px-2">Saved queries stay in this browser.</Text>}
          </div>
          <div>
            <Text as="div" size="1" color="gray" mb="1" className="px-2">Examples</Text>
            {EXAMPLES.map((s) => (
              <Button key={s.name} variant="ghost" color="gray" className="!m-0 !w-full !justify-start" onClick={() => setQuery(s.query)}>
                <Text truncate style={{ color: 'var(--gray-12)' }}>{s.name}</Text>
              </Button>
            ))}
          </div>
        </aside>
        <section className="flex min-w-0 flex-col gap-3">
          <SqlEditor label="SQL query" value={query} onChange={setQuery} onRun={run} schema={schema} />
          <ErrorBox error={error} />
          {result && (
            <>
              <Text size="2" color="gray" className="num">{result.row_count.toLocaleString()} row{result.row_count === 1 ? '' : 's'} · {result.ms} ms</Text>
              {result.columns.length ? <DataTable columns={result.columns} rows={result.rows} /> : <Text size="2" color="gray">Statement ran. It returned no rows.</Text>}
            </>
          )}
        </section>
      </div>
      <Modal open={naming} onClose={() => setNaming(false)} title="Save query">
        <form onSubmit={(e) => { e.preventDefault(); persist([...snippets, { name: snippetName.trim(), query }]); setNaming(false); toast('Query saved') }}>
          <label className="flex flex-col gap-1.5">
            <Text size="2" weight="medium">Name</Text>
            <TextField.Root autoFocus required value={snippetName} onChange={(e) => setSnippetName(e.target.value)} placeholder="Orders by status" />
          </label>
          <Flex gap="2" justify="end" mt="4">
            <Button type="button" variant="soft" color="gray" onClick={() => setNaming(false)}>Cancel</Button>
            <Button disabled={!snippetName.trim()}>Save</Button>
          </Flex>
        </form>
      </Modal>
    </>
  )
}
