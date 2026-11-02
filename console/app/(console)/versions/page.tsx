'use client'
import { Fragment, useEffect, useState } from 'react'
import { Badge, Button, Callout, Card, Flex, Grid, IconButton, Table, Text, TextField } from '@radix-ui/themes'
import { ChevronDown, ChevronRight, GitPullRequest, Upload } from 'lucide-react'
import { json, kodu } from '@/lib/api'
import { Empty, ErrorBox, PageHeader, Section, Skeleton, useLoad, useToast } from '@/components/ui'

type Migration = { version: number; at: string; tag: string; object: string | null; statement: string; actor: string; pushed_at: string | null; git_sha: string | null }
type Project = { slug: string; name: string; parent: string | null; git_branch: string; github_repo: string | null; github_api_url: string | null; github_connected: boolean }

export default function Migrations() {
  const [slug, setSlug] = useState<string | null>(null)
  useEffect(() => { fetch('/api/project').then((r) => r.json()).then((p) => setSlug(p.slug)) }, [])
  const project = useLoad(() => (slug ? kodu<Project>(`platform/v1/projects/${slug}`) : Promise.resolve(null)), [slug])
  const migrations = useLoad(() => kodu<Migration[]>('meta/v1/migrations'))
  const [open, setOpen] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const p = project.data
  const pending = migrations.data?.filter((m) => !m.pushed_at).length ?? 0

  async function act(fn: () => Promise<string>) {
    setBusy(true)
    setMessage('')
    try {
      const msg = await fn()
      setMessage(msg)
      toast(msg)
      migrations.reload()
    } catch (e) {
      migrations.setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Migrations"
        description={p ? `${pending} schema change${pending === 1 ? '' : 's'} on branch ${p.git_branch} ${pending === 1 ? 'is' : 'are'} not on GitHub yet. Every create, alter and drop is recorded here automatically.` : 'Every create, alter and drop in this project is recorded as a numbered migration.'}
        actions={p && (
          <>
            {p.parent && (
              <Button variant="soft" color="gray" disabled={busy || !p.github_connected} onClick={() => act(async () => {
                const r = await kodu<{ url: string; number: number }>(`platform/v1/projects/${p.slug}/github/pull-request`, { method: 'POST' })
                return `Opened pull request #${r.number}`
              })}><GitPullRequest size={15} />Open pull request</Button>
            )}
            <Button loading={busy} disabled={!p.github_connected || pending === 0} onClick={() => act(async () => {
              const r = await kodu<{ pushed: unknown[]; branch: string; repo: string }>(`platform/v1/projects/${p.slug}/github/push`, { method: 'POST' })
              return `Pushed ${r.pushed.length} migration${r.pushed.length === 1 ? '' : 's'} to ${r.repo} on ${r.branch}`
            })}><Upload size={15} />Push to GitHub</Button>
          </>
        )}
      />
      <ErrorBox error={project.error || migrations.error} />
      {message && <Callout.Root size="1" color="gray" mb="3" role="status"><Callout.Text>{message}</Callout.Text></Callout.Root>}

      <Grid columns={{ initial: '1', lg: '3' }} gap="5">
        <div className="min-w-0 lg:col-span-2">
          <Section title="History" aside={<Text size="2" color="gray" className="num">{migrations.data?.length ?? 0} versions</Text>}>
            {migrations.loading && !migrations.data ? <Skeleton /> : migrations.data?.length ? (
              <Table.Root variant="ghost" size="1" className="kd-table">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell aria-label="Expand" />
                    <Table.ColumnHeaderCell className="num">Version</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Change</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Object</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Recorded</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Git</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {migrations.data.map((m) => (
                    <Fragment key={m.version}>
                      <Table.Row align="center">
                        <Table.Cell>
                          <IconButton size="1" variant="ghost" color="gray" aria-expanded={open === m.version} aria-label={`Show SQL of version ${m.version}`} onClick={() => setOpen(open === m.version ? null : m.version)}>
                            {open === m.version ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </IconButton>
                        </Table.Cell>
                        <Table.Cell className="num"><Text className="font-mono">{String(m.version).padStart(6, '0')}</Text></Table.Cell>
                        <Table.Cell><Badge color={m.tag.startsWith('DROP') ? 'amber' : 'gray'} variant="soft">{m.tag.toLowerCase()}</Badge></Table.Cell>
                        <Table.Cell><Text className="font-mono" size="1">{m.object}</Text></Table.Cell>
                        <Table.Cell><Text color="gray">{new Date(m.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</Text></Table.Cell>
                        <Table.Cell>
                          {m.pushed_at
                            ? <Text size="1" color="gray" className="font-mono">{m.git_sha?.slice(0, 7) ?? 'pushed'}</Text>
                            : <Badge color="red" variant="soft">not pushed</Badge>}
                        </Table.Cell>
                      </Table.Row>
                      {open === m.version && (
                        <Table.Row>
                          <Table.Cell colSpan={6} style={{ whiteSpace: 'normal' }}>
                            <pre className="overflow-auto rounded-md p-3 text-xs" style={{ background: 'var(--gray-a2)', fontFamily: 'var(--code-font-family)' }}>{m.statement}</pre>
                          </Table.Cell>
                        </Table.Row>
                      )}
                    </Fragment>
                  ))}
                </Table.Body>
              </Table.Root>
            ) : <Empty>No schema changes recorded yet. Create a table and it becomes version 1.</Empty>}
          </Section>
        </div>
        <Section title="GitHub">
          {p ? <GithubForm project={p} onSaved={() => project.reload()} /> : <Skeleton rows={3} />}
        </Section>
      </Grid>
    </>
  )
}

function GithubForm({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    try {
      await kodu(`platform/v1/projects/${project.slug}/github`, json('PUT', { repo: f.get('repo'), token: f.get('token'), branch: f.get('branch'), api_url: f.get('api_url') }))
      setError('')
      toast('GitHub settings saved')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card size="2">
      <form onSubmit={submit}>
        <Flex direction="column" gap="3">
          <Text size="2" color="gray">
            Migrations are committed as <Text className="font-mono">kodudb/&lt;project&gt;/migrations/000012_create_table.sql</Text>.
          </Text>
          <label className="flex flex-col gap-1.5"><Text size="2" weight="medium">Repository</Text><TextField.Root name="repo" required defaultValue={project.github_repo ?? ''} placeholder="owner/name" /></label>
          <label className="flex flex-col gap-1.5">
            <Flex gap="2" align="center"><Text size="2" weight="medium">Access token</Text>{project.github_connected && <Badge color="gray" variant="soft">saved</Badge>}</Flex>
            <TextField.Root name="token" type="password" autoComplete="off" required={!project.github_connected} placeholder={project.github_connected ? 'Leave empty to keep the saved token' : 'Fine-grained: Contents and Pull requests, write'} />
          </label>
          <label className="flex flex-col gap-1.5"><Text size="2" weight="medium">Git branch</Text><TextField.Root name="branch" defaultValue={project.git_branch} /></label>
          <label className="flex flex-col gap-1.5"><Text size="2" weight="medium">API address</Text><TextField.Root name="api_url" defaultValue={project.github_api_url ?? ''} placeholder="https://api.github.com" /><Text size="1" color="gray">Only for GitHub Enterprise.</Text></label>
          <ErrorBox error={error} />
          <Flex justify="end"><Button variant="soft" color="gray" loading={busy}>{project.github_connected ? 'Save' : 'Connect'}</Button></Flex>
        </Flex>
      </form>
    </Card>
  )
}
