'use client'
import { useState } from 'react'
import { Badge, Button, DropdownMenu, Flex, IconButton, Table, Text, TextField } from '@radix-ui/themes'
import { Ellipsis, KeyRound, Plus } from 'lucide-react'
import { fmtBytes, json, kodu } from '@/lib/api'
import { ErrorBox, KeyField, Modal, PageHeader, Skeleton, useConfirm, useLoad, useToast } from '@/components/ui'
import { selectProject } from '../project-switcher'

type Project = { slug: string; name: string; db_name: string; parent: string | null; git_branch: string; github_repo: string | null; created_at: string; size: number }
type Detail = Project & { path: string; public_key: string; secret_key: string }

const API_URL = process.env.NEXT_PUBLIC_KODUDB_URL ?? 'http://localhost:8787'

export default function Projects() {
  const projects = useLoad(() => kodu<Project[]>('platform/v1/projects'))
  const [creating, setCreating] = useState(false)
  const [branchOf, setBranchOf] = useState<Project | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const toast = useToast()
  const confirm = useConfirm()

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn()
      toast(done)
      projects.reload()
    } catch (e) {
      projects.setError((e as Error).message)
    }
  }

  async function rotate(p: Project) {
    if (!(await confirm({
      title: `Rotate keys for ${p.name}?`,
      description: 'New public and secret keys are issued. Every app using the old keys and every signed-in user session stops working until it uses the new keys.',
      action: 'Rotate keys', danger: true,
    }))) return
    try {
      const d = await kodu<Detail>(`platform/v1/projects/${p.slug}/rotate-keys`, { method: 'POST' })
      await fetch('/api/project', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: p.slug }) })
      toast(`New keys issued for ${p.name}`)
      setDetail(d)
    } catch (e) {
      projects.setError((e as Error).message)
    }
  }

  async function rotateAll() {
    if (!(await confirm({
      title: 'Rotate keys in every project?',
      description: 'Each project gets new public and secret keys and all its sessions end. The default project keeps the keys from .env; rotate those with scripts/gen-env.mjs --rotate.',
      action: 'Rotate all keys', danger: true, typeToConfirm: 'rotate all',
    }))) return
    try {
      const r = await kodu<{ rotated: string[] }>('platform/v1/rotate-keys', { method: 'POST' })
      await Promise.all(r.rotated.map((slug) => fetch('/api/project', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug }) })))
      toast(`Rotated keys in ${r.rotated.length} project${r.rotated.length === 1 ? '' : 's'}`)
    } catch (e) {
      projects.setError((e as Error).message)
    }
  }

  return (
    <>
      <PageHeader
        title="Projects & keys"
        description="Each project is its own Postgres database with its own keys, files and live events. A branch is a full copy tied to a Git branch."
        actions={
          <>
            <Button variant="soft" color="gray" onClick={rotateAll}><KeyRound size={15} />Rotate all keys</Button>
            <Button onClick={() => setCreating(true)}><Plus size={15} />New project</Button>
          </>
        }
      />
      <ErrorBox error={projects.error} />
      {projects.loading && !projects.data ? <Skeleton /> : (
        <Table.Root variant="ghost" size="2" className="kd-table">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Project</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Database</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Git branch</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Repository</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell className="num">Size</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell aria-label="Actions" />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {projects.data?.map((p) => (
              <Table.Row key={p.slug} align="center">
                <Table.RowHeaderCell>
                  <Flex direction="column" className={p.parent ? 'pl-4' : ''}>
                    <Text weight="medium">{p.parent && <Text color="gray">↳ </Text>}{p.name}</Text>
                    <Text size="1" color="gray" className="font-mono">{p.slug}</Text>
                  </Flex>
                </Table.RowHeaderCell>
                <Table.Cell><Text className="font-mono" size="1">{p.db_name}</Text></Table.Cell>
                <Table.Cell><Badge color="gray" variant="outline">{p.git_branch}</Badge></Table.Cell>
                <Table.Cell><Text color="gray">{p.github_repo ?? '—'}</Text></Table.Cell>
                <Table.Cell className="num">{fmtBytes(p.size)}</Table.Cell>
                <Table.Cell justify="end">
                  <Flex gap="2" justify="end" align="center">
                    <Button size="1" variant="soft" color="gray" onClick={() => selectProject(p.slug, '/')}>Open</Button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger><IconButton size="1" variant="ghost" color="gray" aria-label={`More for ${p.name}`}><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
                      <DropdownMenu.Content align="end">
                        <DropdownMenu.Item onSelect={async () => setDetail(await kodu<Detail>(`platform/v1/projects/${p.slug}`))}>Show API keys</DropdownMenu.Item>
                        {p.slug !== 'default' && <DropdownMenu.Item onSelect={() => rotate(p)}>Rotate keys…</DropdownMenu.Item>}
                        {p.slug !== 'default' && <DropdownMenu.Item onSelect={() => setBranchOf(p)}>Create branch…</DropdownMenu.Item>}
                        {p.slug !== 'default' && (
                          <>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item color="red" onSelect={async () => {
                              if (await confirm({ title: `Delete ${p.name}?`, description: `Its database ${p.db_name}${p.parent ? '' : ', every branch'} and all files are deleted. This cannot be undone.`, action: 'Delete project', danger: true, typeToConfirm: p.slug }))
                                act(() => kodu(`platform/v1/projects/${p.slug}`, { method: 'DELETE' }), `Deleted ${p.name}`)
                            }}>Delete project…</DropdownMenu.Item>
                          </>
                        )}
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  </Flex>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}

      <NameDialog
        open={creating} title="New project" label="Project name" action="Create project"
        hint="A database named after the project is created with identity, files, live events, change log and migrations ready."
        onClose={() => setCreating(false)}
        onSubmit={async (name) => {
          const d = await kodu<Detail>('platform/v1/projects', json('POST', { name }))
          toast(`Created ${d.name} with database ${d.db_name}`)
          setCreating(false)
          projects.reload()
          setDetail(d)
        }}
      />
      <NameDialog
        open={branchOf !== null} title={`Branch ${branchOf?.name ?? ''}`} label="Branch name" action="Create branch"
        hint="Copies the database (schema and data) into a new project tied to a Git branch of the same name. The source disconnects for a moment while it is copied."
        onClose={() => setBranchOf(null)}
        onSubmit={async (name) => {
          const d = await kodu<Detail>(`platform/v1/projects/${branchOf!.slug}/branches`, json('POST', { name }))
          toast(`Branch ${d.git_branch} created`)
          setBranchOf(null)
          projects.reload()
          setDetail(d)
        }}
      />
      <Modal open={detail !== null} onClose={() => setDetail(null)} title={`${detail?.name ?? ''} API keys`} width="600px">
        {detail && (
          <Flex direction="column" gap="3">
            <KeyField label="API endpoint" value={`${API_URL}${detail.path}`} />
            <KeyField label="Public key" value={detail.public_key} hint="For browsers and apps. Row security decides what it reaches." />
            <KeyField label="Secret key" value={detail.secret_key} secret hint="Server-side only. Skips row security." />
            <Flex gap="2" justify="end" mt="2">
              <Button variant="soft" color="gray" onClick={() => setDetail(null)}>Close</Button>
              <Button onClick={() => selectProject(detail.slug, '/')}>Open project</Button>
            </Flex>
          </Flex>
        )}
      </Modal>
    </>
  )
}

function NameDialog({ open, title, label, hint, action, onClose, onSubmit }: { open: boolean; title: string; label: string; hint: string; action: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSubmit(String(new FormData(e.currentTarget).get('name')))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={title} description={hint}>
      <form onSubmit={submit}>
        <Flex direction="column" gap="3">
          <label className="flex flex-col gap-1.5"><Text size="2" weight="medium">{label}</Text><TextField.Root name="name" required minLength={2} maxLength={40} autoFocus /></label>
          <ErrorBox error={error} />
          <Flex gap="2" justify="end">
            <Button type="button" variant="soft" color="gray" onClick={onClose}>Cancel</Button>
            <Button loading={busy}>{action}</Button>
          </Flex>
        </Flex>
      </form>
    </Modal>
  )
}
