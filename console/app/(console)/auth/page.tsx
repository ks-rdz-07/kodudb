'use client'
import { useState } from 'react'
import { Badge, Button, DropdownMenu, Flex, IconButton, Table, Text, TextField } from '@radix-ui/themes'
import { Ellipsis, Plus, RefreshCw, Search } from 'lucide-react'
import { json, kodu } from '@/lib/api'
import { Empty, ErrorBox, Modal, PageHeader, Skeleton, Tabs, useConfirm, useLoad, useToast } from '@/components/ui'
import { EmailSettings, EmailTemplates, SentEmails } from './email'
import { SignInProviders } from './providers'
import { ProviderIcon } from '@/components/provider-icon'

type User = { id: string; email: string; banned: boolean; created_at: string; last_sign_in_at: string | null; email_confirmed_at: string | null; mfa_enabled?: boolean; providers?: string[]; user_metadata: Record<string, unknown> }
type IdentityTab = 'users' | 'audit' | 'providers' | 'email' | 'templates' | 'sent'
type AuditRow = { id: number; at?: string; created_at: string; email: string | null; action: string; ip: string | null }
const PER_PAGE = 50

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—')
const ACTIONS: Record<string, { label: string; color: 'gray' | 'red' | 'green' | 'amber' }> = {
  login: { label: 'Signed in', color: 'green' },
  login_failed: { label: 'Wrong password', color: 'red' },
  login_throttled: { label: 'Too many attempts', color: 'amber' },
  login_mfa_challenge: { label: 'Password ok, code asked', color: 'gray' },
  signup: { label: 'Signed up', color: 'gray' },
  admin_create: { label: 'Created by admin', color: 'gray' },
}

export default function Identity() {
  const [tab, setTab] = useState<IdentityTab>('users')
  const [adding, setAdding] = useState(false)
  const [version, setVersion] = useState(0)
  return (
    <>
      <PageHeader
        title="Identity"
        description="People who can sign in to this project, with a password or a sign-in provider. Their tokens carry the id your row security reads with auth.uid()."
        actions={<Button onClick={() => setAdding(true)}><Plus size={15} />Add user</Button>}
      />
      <Tabs
        tabs={[
          { value: 'users', label: 'Users' }, { value: 'audit', label: 'Sign-in activity' }, { value: 'providers', label: 'Sign-in providers' },
          { value: 'email', label: 'Email settings' },
          { value: 'templates', label: 'Email templates' }, { value: 'sent', label: 'Sent emails' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as IdentityTab)}
      >
        {tab === 'users' ? <Users key={version} /> : tab === 'audit' ? <Audit /> : tab === 'providers' ? <SignInProviders /> : tab === 'email' ? <EmailSettings /> : tab === 'templates' ? <EmailTemplates /> : <SentEmails />}
      </Tabs>
      <AddUser open={adding} onClose={() => setAdding(false)} onDone={() => { setAdding(false); setVersion((v) => v + 1) }} />
    </>
  )
}

function Users() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const { data, error, loading, reload, setError } = useLoad(
    () => kodu<{ users: User[]; total: number }>(`auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}&search=${encodeURIComponent(term)}`),
    [page, term],
  )
  // Provider id -> preset and label, for the icons in the Linked column.
  const providers = useLoad(() => kodu<{ provider: string; preset: string; name: string }[]>('auth/v1/admin/providers'))
  const linked = Object.fromEntries((providers.data ?? []).map((p) => [p.provider, p]))
  const toast = useToast()
  const confirm = useConfirm()

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn()
      toast(done)
      reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PER_PAGE))

  return (
    <Flex direction="column" gap="3">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setTerm(search) }}>
        <TextField.Root aria-label="Search by email" placeholder="Search by email" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 300 }}>
          <TextField.Slot><Search size={14} /></TextField.Slot>
        </TextField.Root>
        <Button variant="soft" color="gray" type="submit">Search</Button>
        <div className="flex-1" />
        <Text size="2" color="gray" className="num">{total.toLocaleString()} user{total === 1 ? '' : 's'}</Text>
      </form>
      <ErrorBox error={error} />
      {loading && !data ? <Skeleton /> : (
        <Table.Root variant="ghost" size="2" className="kd-table">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Email</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Linked</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Two-factor</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Last sign-in</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Joined</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>User id</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell aria-label="Actions" />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data?.users.map((u) => (
              <Table.Row key={u.id} align="center">
                <Table.RowHeaderCell><Text weight="medium">{u.email}</Text></Table.RowHeaderCell>
                <Table.Cell>
                  {u.banned ? <Badge color="red">Banned</Badge> : u.email_confirmed_at ? <Badge color="gray" variant="soft">Active</Badge> : <Badge color="amber" variant="soft">Awaiting confirmation</Badge>}
                </Table.Cell>
                <Table.Cell>
                  {u.providers?.length ? (
                    <Flex gap="1" wrap="wrap">
                      {u.providers.map((p) => (
                        <Badge key={p} color="gray" variant="outline"><ProviderIcon preset={linked[p]?.preset ?? p} size={12} />{linked[p]?.name ?? p}</Badge>
                      ))}
                    </Flex>
                  ) : <Text color="gray">—</Text>}
                </Table.Cell>
                <Table.Cell>{u.mfa_enabled ? <Badge color="gray" variant="outline">Authenticator</Badge> : <Text color="gray">—</Text>}</Table.Cell>
                <Table.Cell><Text color="gray">{when(u.last_sign_in_at)}</Text></Table.Cell>
                <Table.Cell><Text color="gray">{when(u.created_at)}</Text></Table.Cell>
                <Table.Cell><Text className="font-mono" size="1" color="gray">{u.id.slice(0, 8)}…</Text></Table.Cell>
                <Table.Cell justify="end">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger><IconButton size="1" variant="ghost" color="gray" aria-label={`Actions for ${u.email}`}><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end">
                      <DropdownMenu.Item onSelect={() => navigator.clipboard.writeText(u.id).then(() => toast('User id copied'))}>Copy user id</DropdownMenu.Item>
                      <DropdownMenu.Item onSelect={() => act(() => kodu(`auth/v1/admin/users/${u.id}`, json('PUT', { ban: !u.banned })), `${u.banned ? 'Unbanned' : 'Banned'} ${u.email}`)}>
                        {u.banned ? 'Allow sign-in again' : 'Ban from signing in'}
                      </DropdownMenu.Item>
                      {u.mfa_enabled && (
                        <DropdownMenu.Item onSelect={async () => {
                          if (await confirm({ title: `Reset two-factor for ${u.email}?`, description: 'Their authenticator is removed. They sign in with their password alone until they set up a new one.', action: 'Reset two-factor', danger: true }))
                            act(() => kodu(`auth/v1/admin/users/${u.id}/factors`, { method: 'DELETE' }), `Two-factor reset for ${u.email}`)
                        }}>Reset two-factor…</DropdownMenu.Item>
                      )}
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item color="red" onSelect={async () => {
                        if (await confirm({ title: `Delete ${u.email}?`, description: 'Their account is removed. Rows they own stay, with their user id.', action: 'Delete user', danger: true }))
                          act(() => kodu(`auth/v1/admin/users/${u.id}`, { method: 'DELETE' }), `Deleted ${u.email}`)
                      }}>Delete user</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
      {data?.users.length === 0 && <Empty>{term ? `No user email contains “${term}”.` : 'No users yet. Your app signs people up with POST /auth/v1/signup.'}</Empty>}
      {pages > 1 && (
        <Flex align="center" gap="2" justify="end">
          <Text size="2" color="gray" className="num">Page {page} of {pages}</Text>
          <Button variant="soft" color="gray" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <Button variant="soft" color="gray" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
        </Flex>
      )}
    </Flex>
  )
}

function AddUser({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    try {
      await kodu('auth/v1/admin/users', json('POST', { email: f.get('email'), password: f.get('password') }))
      setError('')
      toast('User created')
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add user" description="They can sign in right away with this email and password.">
      <form onSubmit={submit}>
        <Flex direction="column" gap="3">
          <label className="flex flex-col gap-1.5"><Text size="2" weight="medium">Email</Text><TextField.Root name="email" type="email" required autoComplete="off" /></label>
          <label className="flex flex-col gap-1.5"><Text size="2" weight="medium">Password</Text><TextField.Root name="password" type="password" minLength={8} maxLength={72} required autoComplete="new-password" /><Text size="1" color="gray">8 to 72 characters.</Text></label>
          <ErrorBox error={error} />
          <Flex gap="2" justify="end">
            <Button type="button" variant="soft" color="gray" onClick={onClose}>Cancel</Button>
            <Button loading={busy}>Create user</Button>
          </Flex>
        </Flex>
      </form>
    </Modal>
  )
}

function Audit() {
  const { data, error, loading, reload } = useLoad(() => kodu<AuditRow[]>('auth/v1/admin/audit?per_page=200'))
  const failed = data?.filter((r) => r.action === 'login_failed').length ?? 0
  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="2">
        <Text size="2" color="gray">{data ? `${data.length} recent events · ${failed} wrong-password attempt${failed === 1 ? '' : 's'}` : 'Loading…'}</Text>
        <div className="flex-1" />
        <IconButton variant="soft" color="gray" aria-label="Reload activity" onClick={reload}><RefreshCw size={15} /></IconButton>
      </Flex>
      <ErrorBox error={error} />
      {loading && !data ? <Skeleton /> : (
        <Table.Root variant="ghost" size="1" className="kd-table">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>When</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Event</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Email</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Client address</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data?.map((r) => {
              const a = ACTIONS[r.action] ?? (r.action.startsWith('login_') ? { label: `Signed in with ${r.action.slice(6)}`, color: 'green' as const } : { label: r.action, color: 'gray' as const })
              return (
                <Table.Row key={r.id}>
                  <Table.Cell><Text color="gray">{when(r.created_at)}</Text></Table.Cell>
                  <Table.Cell><Badge color={a.color} variant="soft">{a.label}</Badge></Table.Cell>
                  <Table.Cell>{r.email ?? '—'}</Table.Cell>
                  <Table.Cell><Text className="font-mono" size="1" color="gray">{r.ip ?? '—'}</Text></Table.Cell>
                </Table.Row>
              )
            })}
          </Table.Body>
        </Table.Root>
      )}
      {data?.length === 0 && <Empty>No sign-in activity yet.</Empty>}
    </Flex>
  )
}
