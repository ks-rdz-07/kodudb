'use client'
import { useEffect, useState } from 'react'
import { Badge, Button, Callout, Card, Code, Flex, Grid, IconButton, ScrollArea, Table, Text, TextField } from '@radix-ui/themes'
import { Check, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { json, kodu } from '@/lib/api'
import { Empty, ErrorBox, KeyField, Modal, Skeleton, Switch, useConfirm, useLoad, useToast } from '@/components/ui'
import { ProviderIcon } from '@/components/provider-icon'

type Preset = { id: string; name: string; group: string; protocol: 'oidc' | 'oauth2'; issuer: string | null; issuer_hint: string; scopes: string; enterprise_url: boolean }
type Provider = {
  provider: string; preset: string; name: string; display_name: string | null; enabled: boolean; ready: boolean; protocol: 'oidc' | 'oauth2'
  client_id: string | null; client_secret_set: boolean; enterprise_url: string | null; issuer: string | null; scopes: string | null
  default_scopes: string; trust_email: boolean; callback_url: string; updated_at: string
}

const field = (label: string, input: React.ReactNode, hint?: string) => (
  <label className="flex flex-col gap-1.5">
    <Text size="2" weight="medium">{label}</Text>
    {input}
    {hint && <Text size="1" color="gray">{hint}</Text>}
  </label>
)

const status = (p: Provider) =>
  p.enabled && p.ready ? <Badge color="green" variant="soft">On</Badge> : p.enabled ? <Badge color="amber" variant="soft">Needs setup</Badge> : <Badge color="gray" variant="soft">Off</Badge>

export function SignInProviders() {
  const { data, error, loading, reload } = useLoad(() => Promise.all([kodu<Provider[]>('auth/v1/admin/providers'), kodu<Preset[]>('auth/v1/admin/providers/presets')]))
  const [editing, setEditing] = useState('')
  const [adding, setAdding] = useState(false)
  const confirm = useConfirm()
  const toast = useToast()

  if (loading && !data) return <Skeleton rows={6} />
  if (!data) return <ErrorBox error={error} />
  const [providers, presets] = data
  const current = providers.find((p) => p.provider === editing) ?? null

  async function remove(p: Provider) {
    if (!(await confirm({ title: `Remove ${p.name}?`, description: 'People can no longer sign in with it. Their accounts stay linked, so adding it again under the same id signs them into the same users.', action: 'Remove provider', danger: true }))) return
    await kodu(`auth/v1/admin/providers/${p.provider}`, { method: 'DELETE' })
    toast(`${p.name} removed`)
    if (editing === p.provider) setEditing('')
    reload()
  }

  return (
    <Flex direction="column" gap="5">
      <Flex justify="between" align="center" gap="4" wrap="wrap">
        <Text size="2" color="gray">Social logins, your company directory (Okta, Microsoft Entra, Auth0, Clerk) or a self-hosted identity server such as Keycloak, authentik or ZITADEL. Any OpenID Connect provider works.</Text>
        <Button onClick={() => setAdding(true)}><Plus size={15} />Add provider</Button>
      </Flex>
      <ErrorBox error={error} />
      {providers.length === 0 ? (
        <Empty>No sign-in providers yet. People sign in with email and password only.</Empty>
      ) : (
        <div className="kd-table">
          <Table.Root variant="ghost" size="2">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Provider</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Id</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Protocol</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell aria-label="Actions" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {providers.map((p) => (
                <Table.Row key={p.provider} align="center">
                  <Table.RowHeaderCell><Flex align="center" gap="2"><ProviderIcon preset={p.preset} size={18} /><Text weight="medium">{p.name}</Text></Flex></Table.RowHeaderCell>
                  <Table.Cell><Text className="font-mono" size="1" color="gray">{p.provider}</Text></Table.Cell>
                  <Table.Cell><Text color="gray">{p.protocol === 'oidc' ? 'OpenID Connect' : 'OAuth 2.0'}</Text></Table.Cell>
                  <Table.Cell>{status(p)}</Table.Cell>
                  <Table.Cell justify="end">
                    <Flex gap="3" justify="end">
                      <IconButton size="1" variant="ghost" color="gray" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p.provider)}><Pencil size={14} /></IconButton>
                      <IconButton size="1" variant="ghost" color="gray" aria-label={`Remove ${p.name}`} onClick={() => remove(p)}><Trash2 size={14} /></IconButton>
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </div>
      )}
      {current && <Editor key={current.provider} provider={current} preset={presets.find((x) => x.id === current.preset)} onSaved={reload} />}
      <AddProvider open={adding} presets={presets} taken={providers.map((p) => p.provider)} onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setEditing(id); reload() }} />
    </Flex>
  )
}

function AddProvider({ open, presets, taken, onClose, onAdded }: { open: boolean; presets: Preset[]; taken: string[]; onClose: () => void; onAdded: (id: string) => void }) {
  const [preset, setPreset] = useState('')
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (open) { setPreset(''); setId(''); setError('') } }, [open])
  const choose = (v: string) => { setPreset(v); if (!id || presets.some((p) => p.id === id)) setId(taken.includes(v) ? `${v}-2` : v) }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await kodu(`auth/v1/admin/providers/${id}`, json('PUT', { preset, enabled: false }))
      onAdded(id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a sign-in provider" description="Pick the provider, then fill in the app credentials it gives you.">
      <form onSubmit={add}>
        <Flex direction="column" gap="3" mt="3">
          <ErrorBox error={error} />
          <PresetPicker presets={presets} value={preset} onChange={choose} />
          {field('Id', <TextField.Root value={id} onChange={(e) => setId(e.target.value.toLowerCase())} className="font-mono" placeholder="okta" />, 'Used in /auth/v1/authorize?provider=… Add the same provider twice with different ids, for example okta-staff and okta-partners.')}
          <Flex justify="end" gap="3" mt="2">
            <Button type="button" variant="soft" color="gray" onClick={onClose}>Cancel</Button>
            <Button loading={busy} disabled={!preset || !id || taken.includes(id)}>Add provider</Button>
          </Flex>
        </Flex>
      </form>
    </Modal>
  )
}

/** Searchable, grouped list of provider presets with their logos. */
function PresetPicker({ presets, value, onChange }: { presets: Preset[]; value: string; onChange: (id: string) => void }) {
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()
  const hits = presets.filter((p) => !term || `${p.name} ${p.id} ${p.group} ${p.protocol === 'oidc' ? 'openid connect oidc' : 'oauth'}`.toLowerCase().includes(term))
  const groups = [...new Set(hits.map((p) => p.group))]
  return (
    <div className="flex flex-col gap-1.5">
      <Text size="2" weight="medium" id="preset-label">Provider</Text>
      <TextField.Root
        autoFocus
        aria-label="Search providers"
        placeholder={`Search ${presets.length} providers: Google, Okta, Keycloak…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        // Enter picks the first match instead of submitting the form.
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (hits[0]) onChange(hits[0].id) } }}
      >
        <TextField.Slot><Search size={14} /></TextField.Slot>
      </TextField.Root>
      <ScrollArea type="auto" scrollbars="vertical" className="rounded-md border" style={{ height: 300, borderColor: 'var(--gray-a6)' }}>
        <div role="listbox" aria-labelledby="preset-label" className="p-1">
          {hits.length === 0 && <Text as="p" size="2" color="gray" className="p-3">No provider matches “{q}”. Use “Other OpenID Connect” for any provider that supports OpenID Connect.</Text>}
          {groups.map((g) => (
            <div key={g} role="group" aria-label={g}>
              <Text as="div" size="1" color="gray" weight="medium" className="px-2 pb-1 pt-2">{g}</Text>
              {hits.filter((p) => p.group === g).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={value === p.id}
                  onClick={() => onChange(p.id)}
                  className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--gray-a3)] aria-selected:bg-[var(--accent-a4)] focus-visible:outline-2 focus-visible:outline-[var(--accent-8)]"
                >
                  <ProviderIcon preset={p.id} size={18} />
                  <span className="flex-1">{p.name}</span>
                  <Text size="1" color="gray">{p.protocol === 'oidc' ? 'OpenID Connect' : 'OAuth 2.0'}</Text>
                  {value === p.id && <Check size={14} />}
                </button>
              ))}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function Editor({ provider, preset, onSaved }: { provider: Provider; preset?: Preset; onSaved: () => void }) {
  const [form, setForm] = useState(provider)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toast = useToast()
  const set = (patch: Partial<Provider>) => setForm({ ...form, ...patch })
  const oidc = form.protocol === 'oidc'
  const complete = !!form.client_id && (form.client_secret_set || !!secret) && (!oidc || !!form.issuer)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await kodu(`auth/v1/admin/providers/${form.provider}`, json('PUT', {
        display_name: form.display_name ?? '', enabled: form.enabled, client_id: form.client_id ?? '', client_secret: secret || undefined,
        issuer: oidc ? form.issuer ?? '' : undefined, enterprise_url: preset?.enterprise_url ? form.enterprise_url ?? '' : undefined,
        scopes: form.scopes ?? '', trust_email: form.trust_email,
      }))
      setSecret('')
      toast(`${form.display_name || preset?.name || form.provider} saved`)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const authorize = form.callback_url.replace(/callback$/, `authorize?provider=${form.provider}`)
  return (
    <Grid columns={{ initial: '1', lg: '3' }} gap="5">
      <form onSubmit={save} className="lg:col-span-2">
        <Flex direction="column" gap="4">
          <ErrorBox error={error} />
          <Card size="2">
            <Flex direction="column" gap="3">
              <Flex justify="between" align="start" gap="4">
                <div>
                  <Flex align="center" gap="2">
                    <ProviderIcon preset={provider.preset} size={20} />
                    <Text as="div" size="3" weight="medium">{provider.name}</Text>
                    {status(provider)}
                  </Flex>
                  <Text as="div" size="2" color="gray">
                    {oidc ? 'OpenID Connect: endpoints come from the issuer’s discovery document; ID tokens are checked against its signing keys.' : 'OAuth 2.0 with this provider’s own user API.'}
                  </Text>
                </div>
                <Switch label={`Enable ${provider.name}`} checked={form.enabled} onChange={(v) => set({ enabled: v })} disabled={!complete && !form.enabled} />
              </Flex>
              {!complete && <Text size="1" color="amber">Fill in the client ID, client secret{oidc ? ' and issuer URL' : ''} before turning this on.</Text>}
              {field('Button label', <TextField.Root value={form.display_name ?? ''} onChange={(e) => set({ display_name: e.target.value })} placeholder={preset?.name} />, 'Shown to people choosing how to sign in.')}
              {oidc && field('Issuer URL', <TextField.Root value={form.issuer ?? ''} onChange={(e) => set({ issuer: e.target.value })} placeholder={preset?.issuer_hint || preset?.issuer || ''} className="font-mono" />, preset?.issuer_hint ? `For example ${preset.issuer_hint}` : undefined)}
              {preset?.enterprise_url && field('GitHub Enterprise URL', <TextField.Root value={form.enterprise_url ?? ''} onChange={(e) => set({ enterprise_url: e.target.value })} placeholder="Leave empty for github.com" />)}
              <Grid columns={{ initial: '1', sm: '2' }} gap="3">
                {field('Client ID', <TextField.Root value={form.client_id ?? ''} onChange={(e) => set({ client_id: e.target.value })} autoComplete="off" className="font-mono" />)}
                {field(
                  'Client secret',
                  <TextField.Root type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" placeholder={form.client_secret_set ? 'Saved — leave empty to keep' : ''} />,
                  form.preset === 'apple' ? 'For Apple, the client secret JWT generated from your key (valid up to 6 months).' : 'Stored encrypted. It is never shown again.',
                )}
              </Grid>
              {field('Scopes', <TextField.Root value={form.scopes ?? ''} onChange={(e) => set({ scopes: e.target.value })} placeholder={form.default_scopes} className="font-mono" />, 'Leave empty for the default.')}
            </Flex>
          </Card>
          <Card size="2">
            <Flex justify="between" align="start" gap="4">
              <div>
                <Text as="div" size="2" weight="medium">Trust email addresses from this provider</Text>
                <Text as="div" size="2" color="gray">Off: only addresses the provider marks as verified can sign in. Turn on only for a directory you control, such as your own Okta or Keycloak, whose addresses are always real.</Text>
              </div>
              <Switch label="Trust email addresses from this provider" checked={form.trust_email} onChange={(v) => set({ trust_email: v })} />
            </Flex>
            {form.trust_email && <Callout.Root size="1" color="amber" mt="3"><Callout.Text>Anyone who can set an address in this provider can sign in as the KoduDB user with that address.</Callout.Text></Callout.Root>}
          </Card>
          <Flex justify="end"><Button loading={busy}>Save provider</Button></Flex>
        </Flex>
      </form>
      <Card size="2" className="self-start">
        <Flex direction="column" gap="3">
          <Text size="2" weight="medium">Connect your app</Text>
          <Text size="2" color="gray">Register this redirect (callback) URL in the provider’s app settings:</Text>
          <KeyField label="Callback URL" value={form.callback_url} />
          <Text size="2" color="gray">Your sign-in button sends people to:</Text>
          <Code size="2" className="break-all">{authorize}</Code>
          <Text size="1" color="gray">They come back to the site URL from Email settings with the session in the address fragment. List the providers that are on with GET /auth/v1/providers.</Text>
        </Flex>
      </Card>
    </Grid>
  )
}
