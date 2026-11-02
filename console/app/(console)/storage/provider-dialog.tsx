'use client'
import { useState } from 'react'
import { Button, Callout, Flex, Text, TextField } from '@radix-ui/themes'
import { TriangleAlert } from 'lucide-react'
import { json, kodu } from '@/lib/api'
import { ErrorBox, Modal, Select, useToast } from '@/components/ui'

export type Current = { provider?: string; endpoint?: string; region?: string; bucket?: string; access_key?: string | null; secret_set?: boolean }

// Prefills only; the API validates and tests whatever is sent. {region} and {account} are filled in by the user.
const PRESETS: Record<string, { label: string; endpoint: string; region: string; hint?: string }> = {
  aws: { label: 'AWS S3', endpoint: 'https://s3.{region}.amazonaws.com', region: 'us-east-1' },
  r2: { label: 'Cloudflare R2', endpoint: 'https://{account}.r2.cloudflarestorage.com', region: 'auto', hint: 'Replace {account} with your Cloudflare account id.' },
  b2: { label: 'Backblaze B2', endpoint: 'https://s3.{region}.backblazeb2.com', region: 'us-west-004', hint: 'Use the region shown in your B2 bucket endpoint.' },
  wasabi: { label: 'Wasabi', endpoint: 'https://s3.{region}.wasabisys.com', region: 'us-east-1' },
  spaces: { label: 'DigitalOcean Spaces', endpoint: 'https://{region}.digitaloceanspaces.com', region: 'nyc3' },
  minio: { label: 'MinIO', endpoint: 'https://minio.example.com', region: 'us-east-1' },
  gcs: { label: 'Google Cloud Storage (S3 interoperability)', endpoint: 'https://storage.googleapis.com', region: 'auto', hint: 'Create an HMAC key under Cloud Storage settings, Interoperability.' },
  other: { label: 'Other S3-compatible', endpoint: 'https://s3.example.com', region: 'us-east-1' },
}
const fill = (endpoint: string, region: string) => endpoint.replace('{region}', region)
const OPTIONS = [{ value: 'rustfs', label: 'RustFS (bundled, default)' }, ...Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label }))]

export function ProviderDialog({ open, onClose, slug, current, onSaved }: { open: boolean; onClose: () => void; slug: string; current: Current; onSaved: () => void }) {
  const toast = useToast()
  const start = current.provider && current.provider in PRESETS ? current : { provider: 'rustfs' }
  const [provider, setProvider] = useState(start.provider ?? 'rustfs')
  // The saved values belong to the saved provider only; RustFS's own bucket and key are never reused elsewhere.
  const saved = (id: string) => (id === current.provider && id in PRESETS
    ? { endpoint: current.endpoint ?? '', region: current.region ?? '', bucket: current.bucket ?? '', access_key: current.access_key ?? '', secret_key: '' }
    : null)
  const [f, setF] = useState(saved(start.provider ?? 'rustfs') ?? { endpoint: '', region: '', bucket: '', access_key: '', secret_key: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const preset = PRESETS[provider]
  const pick = (id: string) => {
    setProvider(id)
    const p = PRESETS[id]
    if (p) setF(saved(id) ?? { endpoint: fill(p.endpoint, p.region), region: p.region, bucket: '', access_key: '', secret_key: '' })
  }
  const label = (text: string, input: React.ReactNode, hint?: string) => (
    <label className="flex flex-col gap-1.5"><Text size="2" weight="medium">{text}</Text>{input}{hint && <Text size="1" color="gray">{hint}</Text>}</label>
  )
  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await kodu(`platform/v1/projects/${slug}/storage/provider`, json('PUT', provider === 'rustfs' ? { provider } : { provider, ...f }))
      toast(provider === 'rustfs' ? 'Using the bundled RustFS storage' : 'Connection works. Storage provider saved')
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Storage provider" description="Where this project's files are stored. RustFS runs with KoduDB; any S3-compatible service can be used instead." width="600px">
      <form onSubmit={save}>
        <Flex direction="column" gap="3">
          <Select label="Storage provider" value={provider} onChange={pick} options={OPTIONS} />
          <Callout.Root color="amber" size="1"><Callout.Icon><TriangleAlert size={16} /></Callout.Icon>
            <Callout.Text>Switching does not move files. Files already uploaded stay on the previous provider and will no longer be found until you copy them over or switch back.</Callout.Text>
          </Callout.Root>
          {preset && (
            <>
              {label('Endpoint', <TextField.Root required value={f.endpoint} onChange={(e) => set({ endpoint: e.target.value })} className="font-mono" />, preset.hint)}
              <Flex gap="3">
                <div className="flex-1">{label('Bucket', <TextField.Root required value={f.bucket} onChange={(e) => set({ bucket: e.target.value })} className="font-mono" placeholder="my-app-files" />, 'The bucket must already exist.')}</div>
                <div className="w-40">{label('Region', <TextField.Root required value={f.region} onChange={(e) => set({ region: e.target.value })} className="font-mono" />)}</div>
              </Flex>
              {label('Access key', <TextField.Root required value={f.access_key} onChange={(e) => set({ access_key: e.target.value })} className="font-mono" autoComplete="off" />)}
              {label('Secret key', <TextField.Root type="password" required={!current.secret_set || provider !== current.provider} value={f.secret_key} onChange={(e) => set({ secret_key: e.target.value })} className="font-mono" autoComplete="new-password" placeholder={current.secret_set && provider === current.provider ? 'Saved. Leave empty to keep it' : ''} />, 'Stored encrypted and never shown again.')}
            </>
          )}
          <ErrorBox error={error} />
          <Flex gap="2" justify="end">
            <Button type="button" variant="soft" color="gray" onClick={onClose}>Cancel</Button>
            <Button disabled={busy}>{preset ? (busy ? 'Testing…' : 'Test and save') : 'Use RustFS'}</Button>
          </Flex>
        </Flex>
      </form>
    </Modal>
  )
}
