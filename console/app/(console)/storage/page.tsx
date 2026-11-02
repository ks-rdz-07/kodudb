'use client'
import { useRef, useState } from 'react'
import { Badge, Button, Checkbox, DropdownMenu, Flex, IconButton, Table, Text, TextField, Tooltip } from '@radix-ui/themes'
import { Download, Ellipsis, ExternalLink, FolderSearch, KeyRound, Link2, Plus, RotateCw, Settings2, Trash2, Upload } from 'lucide-react'
import { fmtBytes, json, kodu } from '@/lib/api'
import { Empty, ErrorBox, KeyField, Modal, PageHeader, Skeleton, Switch, useConfirm, useLoad, useToast } from '@/components/ui'
import { ProviderDialog } from './provider-dialog'

type Bucket = { id: string; public: boolean; created_at: string; objects: number; bytes: number }
type S3Access =
  | { backend: 'local'; provider?: string }
  | { backend: 's3'; provider?: string; secret_set?: boolean; endpoint: string; region: string; bucket: string; access_key: string | null; secret_key: string | null; console_url: string | null; key_error?: string }
type Obj = { id: string; name: string; size: number; mimetype: string | null; created_at: string }

const encodeName = (name: string) => name.split('/').map(encodeURIComponent).join('/')
const objPath = (bucket: string, name: string) => `storage/v1/object/${bucket}/${encodeName(name)}`

export default function Files() {
  const buckets = useLoad(() => kodu<Bucket[]>('storage/v1/bucket'))
  const [active, setActive] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [access, setAccess] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)
  const storage = useLoad(async () => {
    const { slug, endpoint: apiUrl } = (await (await fetch('/api/project')).json()) as { slug: string; endpoint: string }
    return { slug, apiUrl, ...(await kodu<S3Access>(`platform/v1/projects/${slug}/storage`)) }
  })
  const bucket = buckets.data?.find((b) => b.id === (active ?? buckets.data?.[0]?.id)) ?? null

  return (
    <>
      <PageHeader
        title="Files"
        description="Buckets of files your app uploads. Public buckets serve files to anyone with the link; private files follow row security on storage.objects."
        actions={
          <Flex gap="2">
            {storage.data && <Button variant="soft" color="gray" onClick={() => setProviderOpen(true)}><Settings2 size={15} />Storage provider</Button>}
            {storage.data?.backend === 's3' && <Button variant="soft" color="gray" onClick={() => setAccess(true)}><KeyRound size={15} />S3 access</Button>}
            <Button onClick={() => setCreating(true)}><Plus size={15} />New bucket</Button>
          </Flex>
        }
      />
      <ErrorBox error={buckets.error} />
      <div className="grid items-start gap-5 lg:grid-cols-[208px_1fr]">
        <nav aria-label="Buckets" className="flex flex-col gap-0.5">
          <Text size="1" color="gray" mb="1" className="px-2">{buckets.data?.length ?? 0} buckets</Text>
          {buckets.loading && !buckets.data && <Skeleton rows={3} />}
          {buckets.data?.map((b) => (
            <Button key={b.id} variant={b.id === bucket?.id ? 'soft' : 'ghost'} color="gray" onClick={() => setActive(b.id)} className="!m-0 !justify-between">
              <Text truncate style={{ color: 'var(--gray-12)' }} weight={b.id === bucket?.id ? 'medium' : 'regular'}>{b.id}</Text>
              {b.public && <Badge size="1" color="gray" variant="outline">public</Badge>}
            </Button>
          ))}
          {buckets.data?.length === 0 && <Empty>No buckets yet.</Empty>}
        </nav>
        <section className="min-w-0">
          {bucket && <FileList apiUrl={storage.data?.apiUrl ?? ''} key={bucket.id} bucket={bucket} onChanged={buckets.reload} onDeleted={() => { setActive(null); buckets.reload() }} />}
        </section>
      </div>
      {storage.data?.backend === 's3' && <S3AccessDialog open={access} onClose={() => setAccess(false)} info={storage.data} onRotated={storage.reload} />}
      {storage.data && providerOpen && <ProviderDialog open onClose={() => setProviderOpen(false)} slug={storage.data.slug} current={storage.data} onSaved={storage.reload} />}
      <NewBucket open={creating} onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); buckets.reload(); setActive(id) }} />
    </>
  )
}

function FileList({ apiUrl, bucket, onChanged, onDeleted }: { apiUrl: string; bucket: Bucket; onChanged: () => void; onDeleted: () => void }) {
  const [prefix, setPrefix] = useState('')
  const files = useLoad(() => kodu<Obj[]>(`storage/v1/object/list/${bucket.id}`, json('POST', { prefix })), [prefix])
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const confirm = useConfirm()

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn()
      if (done) toast(done)
      files.reload()
      onChanged()
    } catch (e) {
      files.setError((e as Error).message)
    }
  }

  async function upload(list: FileList | null) {
    if (!list?.length) return
    setBusy(true)
    for (const f of Array.from(list)) {
      await run(() => kodu(objPath(bucket.id, prefix + f.name), { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream', 'x-upsert': 'true' }, body: f }))
    }
    setBusy(false)
    toast(`Uploaded ${list.length} file${list.length === 1 ? '' : 's'}`)
  }

  async function download(o: Obj) {
    const res = await fetch(`/api/kodu/${objPath(bucket.id, o.name)}`)
    if (!res.ok) return files.setError(`Download failed (${res.status})`)
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = o.name.split('/').pop() ?? o.name
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="3" wrap="wrap">
        <Text size="4" weight="medium" className="font-mono">{bucket.id}</Text>
        <Text size="2" color="gray" className="num">{bucket.objects.toLocaleString()} files · {fmtBytes(bucket.bytes)}</Text>
        <div className="flex-1" />
        <Text as="label" size="2"><Flex gap="2" align="center">
          <Switch label="Public bucket" checked={bucket.public} onChange={(on) => run(() => kodu(`storage/v1/bucket/${bucket.id}`, json('PUT', { public: on })), on ? 'Bucket is now public' : 'Bucket is now private')} />Public
        </Flex></Text>
        <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        <Button variant="soft" color="gray" loading={busy} onClick={() => input.current?.click()}><Upload size={15} />Upload files</Button>
        <Tooltip content="Delete bucket">
          <IconButton variant="soft" color="red" aria-label="Delete bucket" onClick={async () => {
            if (await confirm({ title: `Delete bucket ${bucket.id}?`, description: `All ${bucket.objects} files in it are deleted for good.`, action: 'Delete bucket', danger: true, typeToConfirm: bucket.id }))
              kodu(`storage/v1/bucket/${bucket.id}`, { method: 'DELETE' }).then(() => { toast(`Deleted ${bucket.id}`); onDeleted() }, (e) => files.setError(e.message))
          }}><Trash2 size={15} /></IconButton>
        </Tooltip>
      </Flex>
      <TextField.Root aria-label="Folder prefix" placeholder="Folder, e.g. catalog/" value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ maxWidth: 320 }}>
        <TextField.Slot><FolderSearch size={14} /></TextField.Slot>
      </TextField.Root>
      <ErrorBox error={files.error} />
      {files.loading && !files.data ? <Skeleton /> : (
        <Table.Root variant="ghost" size="2" className="kd-table">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell className="num">Size</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Uploaded</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell aria-label="Actions" />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {files.data?.map((o) => (
              <Table.Row key={o.id} align="center">
                <Table.RowHeaderCell><Text className="font-mono">{o.name}</Text></Table.RowHeaderCell>
                <Table.Cell className="num">{fmtBytes(o.size)}</Table.Cell>
                <Table.Cell><Text color="gray">{o.mimetype ?? '—'}</Text></Table.Cell>
                <Table.Cell><Text color="gray">{new Date(o.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</Text></Table.Cell>
                <Table.Cell justify="end">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger><IconButton size="1" variant="ghost" color="gray" aria-label={`Actions for ${o.name}`}><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end">
                      <DropdownMenu.Item onSelect={() => download(o)}><Download size={14} />Download</DropdownMenu.Item>
                      {bucket.public && (
                        <DropdownMenu.Item onSelect={() => navigator.clipboard.writeText(`${apiUrl}/storage/v1/object/public/${encodeURIComponent(bucket.id)}/${encodeName(o.name)}`).then(() => toast('Public link copied'))}><Link2 size={14} />Copy public link</DropdownMenu.Item>
                      )}
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item color="red" onSelect={async () => {
                        if (await confirm({ title: `Delete ${o.name}?`, description: 'Links to this file stop working.', action: 'Delete file', danger: true }))
                          run(() => kodu(objPath(bucket.id, o.name), { method: 'DELETE' }), 'File deleted')
                      }}><Trash2 size={14} />Delete</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
      {files.data?.length === 0 && <Empty>{prefix ? `Nothing under “${prefix}”.` : 'This bucket is empty. Upload files or let your app POST to /storage/v1/object.'}</Empty>}
    </Flex>
  )
}

function NewBucket({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const [error, setError] = useState('')
  const [isPublic, setPublic] = useState(false)
  const toast = useToast()
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const id = String(new FormData(e.currentTarget).get('id'))
    try {
      await kodu('storage/v1/bucket', json('POST', { id, public: isPublic }))
      setError('')
      toast(`Bucket ${id} created`)
      onDone(id)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="New bucket">
      <form onSubmit={submit}>
        <Flex direction="column" gap="3">
          <label className="flex flex-col gap-1.5">
            <Text size="2" weight="medium">Bucket name</Text>
            <TextField.Root name="id" required pattern="[a-z0-9][a-z0-9_\-]{1,62}" placeholder="product-images" />
            <Text size="1" color="gray">Lowercase letters, digits, - and _.</Text>
          </label>
          <Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={isPublic} onCheckedChange={(v) => setPublic(v === true)} />Public: anyone with a link can download</Flex></Text>
          <ErrorBox error={error} />
          <Flex gap="2" justify="end">
            <Button type="button" variant="soft" color="gray" onClick={onClose}>Cancel</Button>
            <Button>Create bucket</Button>
          </Flex>
        </Flex>
      </form>
    </Modal>
  )
}

function S3AccessDialog({ open, onClose, info, onRotated }: { open: boolean; onClose: () => void; info: Extract<S3Access, { backend: 's3' }> & { slug: string }; onRotated: () => void }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const bundled = info.provider === 'rustfs'
  const rotate = async () => {
    if (!(await confirm({ title: 'Rotate the S3 key?', description: 'A new access key is issued for this project and the current one stops working at once. Update any tool that uses it.', action: 'Rotate key', danger: true }))) return
    setBusy(true)
    try {
      await kodu(`platform/v1/projects/${info.slug}/storage/rotate`, { method: 'POST' })
      toast('New S3 key issued')
      onRotated()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="S3 access" description={bundled ? "This project's own bucket and access key on the bundled RustFS. The key works only on this bucket." : 'The S3-compatible provider this project uses.'} width="600px">
      <Flex direction="column" gap="3">
        <KeyField label="Endpoint" value={info.endpoint} />
        <Flex gap="3">
          <div className="flex-1"><KeyField label="Bucket" value={info.bucket} /></div>
          <div className="w-40"><KeyField label="Region" value={info.region} /></div>
        </Flex>
        {info.access_key && !info.secret_key && info.secret_set ? (
          <KeyField label="Access key" value={info.access_key} hint="The secret key is stored encrypted and is not shown again." />
        ) : info.access_key && info.secret_key ? (
          <>
            <KeyField label="Access key" value={info.access_key} />
            <KeyField label="Secret key" value={info.secret_key} secret hint="Keep it on servers and in tools you trust; it can read and change every file in this bucket." />
          </>
        ) : (
          <ErrorBox error={info.key_error ?? 'No access key yet.'} />
        )}
        {bundled && info.access_key && info.secret_key && (
          <div className="rounded-md border border-[var(--gray-a6)] p-3">
            <Text size="2" weight="medium">Storage console login</Text>
            <Text as="p" size="1" color="gray" mb="2">Sign in to the RustFS console with the access key as the username and the secret key as the password.</Text>
            <Flex gap="3">
              <div className="flex-1"><KeyField label="Username" value={info.access_key} /></div>
              <div className="flex-1"><KeyField label="Password" value={info.secret_key} secret /></div>
            </Flex>
          </div>
        )}
        <Text size="1" color="gray">
          {bundled ? 'Use path-style requests (bucket in the path). ' : ''}Files written directly through S3 skip KoduDB&apos;s file list and row
          security; upload through the KoduDB files API when your app needs those.
        </Text>
        <Flex gap="2" justify="between" mt="2">
          {bundled ? <Button variant="soft" color="red" disabled={busy} onClick={rotate}><RotateCw size={15} />Rotate key</Button> : <span />}
          {info.console_url && (
            <Button asChild variant="soft">
              <a href={info.console_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Open storage console</a>
            </Button>
          )}
        </Flex>
      </Flex>
    </Modal>
  )
}
