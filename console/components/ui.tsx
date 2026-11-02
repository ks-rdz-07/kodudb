'use client'
// Shared console kit on Radix Themes. Every control is a Radix component; Tailwind only lays things out.
import {
  AlertDialog, Button, Callout, Code, Dialog, Flex, Heading, IconButton, Select as RSelect, Skeleton as RSkeleton,
  Switch as RSwitch, Table, Tabs as RTabs, Text, TextField, Tooltip,
} from '@radix-ui/themes'
import * as RToast from '@radix-ui/react-toast'
import { Check, Copy, Eye, EyeOff, TriangleAlert, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

// ---------- page frame ----------
export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Flex justify="between" align="start" gap="4" wrap="wrap" mb="5">
      <div className="min-w-0">
        <Heading as="h1" size="6" weight="medium" trim="start">{title}</Heading>
        {description && <Text as="p" size="2" color="gray" mt="1">{description}</Text>}
      </div>
      {actions && <Flex gap="2" align="center" wrap="wrap">{actions}</Flex>}
    </Flex>
  )
}

export function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <Flex justify="between" align="center" mb="2" gap="3">
        <Heading as="h2" size="3" weight="medium">{title}</Heading>
        {aside}
      </Flex>
      {children}
    </section>
  )
}

export function ErrorBox({ error }: { error: string }) {
  if (!error) return null
  return (
    <Callout.Root color="red" size="1" role="alert" my="2" className="animate-in fade-in slide-in-from-top-1">
      <Callout.Icon><TriangleAlert size={14} /></Callout.Icon>
      <Callout.Text className="whitespace-pre-wrap">{error}</Callout.Text>
    </Callout.Root>
  )
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Flex direction="column" gap="2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <RSkeleton key={i} height="32px" />)}
    </Flex>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed px-4 py-3" style={{ borderColor: 'var(--gray-a6)' }}>
      <Text size="2" color="gray">{children}</Text>
    </div>
  )
}

// ---------- data tables ----------
const NUMERIC = /^-?\d[\d,]*(\.\d+)?$/
export const isNumeric = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && NUMERIC.test(v))

export function Cell({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <Table.Cell className="kd-null">—</Table.Cell>
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return <Table.Cell className={isNumeric(v) ? 'num' : ''} title={s}>{s}</Table.Cell>
}

export function DataTable({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  if (!columns.length) return <Empty>No rows returned.</Empty>
  const numericCol = columns.map((_, j) => rows.length > 0 && rows.every((r) => r[j] === null || isNumeric(r[j])))
  return (
    <div className="kd-table">
      <Table.Root variant="ghost" size="1">
        <Table.Header>
          <Table.Row>{columns.map((c, j) => <Table.ColumnHeaderCell key={c} className={numericCol[j] ? 'num' : ''}>{c}</Table.ColumnHeaderCell>)}</Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r, i) => <Table.Row key={i}>{r.map((v, j) => <Cell key={j} v={v} />)}</Table.Row>)}
        </Table.Body>
      </Table.Root>
    </div>
  )
}

/** Renders an array of objects as a table. */
export function ObjectTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = rows.length ? Object.keys(rows[0]) : []
  if (!rows.length) return <Empty>Nothing here yet.</Empty>
  return <DataTable columns={columns} rows={rows.map((r) => columns.map((c) => r[c]))} />
}

// ---------- keys ----------
export function KeyField({ label, value, secret = false, hint }: { label: string; value: string; secret?: boolean; hint?: string }) {
  const [shown, setShown] = useState(!secret)
  const toast = useToast()
  return (
    <label className="flex flex-col gap-1.5">
      <Text size="2" weight="medium">{label}</Text>
      <TextField.Root readOnly value={shown ? value : '•'.repeat(32)} className="font-mono" size="2">
        <TextField.Slot side="right" gap="1">
          {secret && (
            <Tooltip content={shown ? 'Hide' : 'Reveal'}>
              <IconButton size="1" variant="ghost" color="gray" aria-label={shown ? 'Hide key' : 'Reveal key'} onClick={(e) => { e.preventDefault(); setShown(!shown) }}>
                {shown ? <EyeOff size={14} /> : <Eye size={14} />}
              </IconButton>
            </Tooltip>
          )}
          <Tooltip content="Copy">
            <IconButton size="1" variant="ghost" color="gray" aria-label={`Copy ${label}`} onClick={async (e) => { e.preventDefault(); await navigator.clipboard.writeText(value); toast(`${label} copied`) }}>
              <Copy size={14} />
            </IconButton>
          </Tooltip>
        </TextField.Slot>
      </TextField.Root>
      {hint && <Text size="1" color="gray">{hint}</Text>}
    </label>
  )
}

// ---------- dialogs ----------
export function Modal({ open, onClose, title, description, children, width = '520px' }: { open: boolean; onClose: () => void; title: string; description?: string; children: React.ReactNode; width?: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Content maxWidth={width} aria-describedby={description ? undefined : undefined}>
        <Flex justify="between" align="start" gap="4">
          <Dialog.Title size="4" weight="medium">{title}</Dialog.Title>
          <Dialog.Close><IconButton size="1" variant="ghost" color="gray" aria-label="Close"><X size={16} /></IconButton></Dialog.Close>
        </Flex>
        {description ? <Dialog.Description size="2" color="gray" mb="4">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
        {open && children}
      </Dialog.Content>
    </Dialog.Root>
  )
}

/** The name to type back, highlighted, with a copy button. */
function ConfirmName({ name, danger }: { name: string; danger?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(name)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Flex align="center" gap="1">
      <Code size="2" weight="bold" color={danger ? 'red' : undefined} variant="soft" className="break-all">{name}</Code>
      <Tooltip content={copied ? 'Copied' : 'Copy name'}>
        <IconButton type="button" size="1" variant="ghost" color="gray" aria-label="Copy name" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}</IconButton>
      </Tooltip>
    </Flex>
  )
}

type ConfirmOpts = { title: string; description: React.ReactNode; action: string; danger?: boolean; typeToConfirm?: string }
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false)
export const useConfirm = () => useContext(ConfirmCtx)

function ConfirmHost({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null)
  const [typed, setTyped] = useState('')
  const resolver = useRef<(v: boolean) => void>(() => {})
  const confirm = useCallback((o: ConfirmOpts) => {
    setTyped('')
    setOpts(o)
    return new Promise<boolean>((res) => { resolver.current = res })
  }, [])
  const close = (v: boolean) => { resolver.current(v); setOpts(null) }
  const blocked = !!opts?.typeToConfirm && typed !== opts.typeToConfirm
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <AlertDialog.Root open={!!opts} onOpenChange={(o) => !o && close(false)}>
        <AlertDialog.Content maxWidth="460px">
          <AlertDialog.Title size="4" weight="medium">{opts?.title}</AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">{opts?.description}</AlertDialog.Description>
          {opts?.typeToConfirm && (
            <label className="mt-4 flex flex-col gap-1.5">
              <Flex align="center" gap="2" wrap="wrap">
                <Text size="2">Type</Text>
                <ConfirmName name={opts.typeToConfirm} danger={opts.danger} />
                <Text size="2">to confirm</Text>
              </Flex>
              <TextField.Root autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" />
            </label>
          )}
          <Flex gap="3" mt="5" justify="end">
            <AlertDialog.Cancel><Button variant="soft" color="gray">Cancel</Button></AlertDialog.Cancel>
            <AlertDialog.Action>
              <Button color={opts?.danger ? 'red' : undefined} disabled={blocked} onClick={() => close(true)}>{opts?.action}</Button>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </ConfirmCtx.Provider>
  )
}

// ---------- inputs ----------
export function Tabs({ tabs, value, onChange, children }: { tabs: { value: string; label: string }[]; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <RTabs.Root value={value} onValueChange={onChange}>
      <RTabs.List size="2" color="red">
        {tabs.map((t) => <RTabs.Trigger key={t.value} value={t.value}>{t.label}</RTabs.Trigger>)}
      </RTabs.List>
      <div className="pt-4 animate-in fade-in duration-200">{children}</div>
    </RTabs.Root>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <RSwitch size="1" color="gray" highContrast checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
}

export function Select({ value, onChange, options, label, placeholder, size = '2', width }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string; placeholder?: string; size?: '1' | '2' | '3'; width?: string
}) {
  // Radix Select cannot hold an empty value, so "" maps to a sentinel.
  const EMPTY = '__all__'
  return (
    <RSelect.Root value={value === '' ? EMPTY : value} onValueChange={(v) => onChange(v === EMPTY ? '' : v)} size={size}>
      <RSelect.Trigger aria-label={label} placeholder={placeholder} style={width ? { width } : undefined} />
      <RSelect.Content position="popper">
        {options.map((o) => <RSelect.Item key={o.value || EMPTY} value={o.value === '' ? EMPTY : o.value}>{o.label}</RSelect.Item>)}
      </RSelect.Content>
    </RSelect.Root>
  )
}

// ---------- toasts ----------
type ToastItem = { id: number; message: string; tone: 'ok' | 'error' }
const ToastCtx = createContext<(message: string, tone?: 'ok' | 'error') => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function Providers({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((message: string, tone: 'ok' | 'error' = 'ok') => {
    setItems((prev) => [...prev, { id: Date.now() + Math.random(), message, tone }])
  }, [])
  return (
    <RToast.Provider swipeDirection="right" duration={3500}>
      <ToastCtx.Provider value={push}>
        <ConfirmHost>{children}</ConfirmHost>
      </ToastCtx.Provider>
      {items.map((t) => (
        <RToast.Root
          key={t.id}
          onOpenChange={(open) => !open && setItems((prev) => prev.filter((x) => x.id !== t.id))}
          className="flex items-center gap-2 rounded-lg border px-3.5 py-2.5 text-[13px] shadow-lg data-[state=open]:animate-in data-[state=open]:slide-in-from-right-full data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:slide-out-to-right-full"
          style={{ background: 'var(--color-panel-solid)', borderColor: t.tone === 'error' ? 'var(--red-7)' : 'var(--gray-a5)', color: t.tone === 'error' ? 'var(--red-11)' : 'var(--gray-12)' }}
        >
          {t.tone === 'ok' ? <Check size={16} color="var(--accent-9)" /> : <X size={16} />}
          <RToast.Description>{t.message}</RToast.Description>
        </RToast.Root>
      ))}
      <RToast.Viewport className="fixed bottom-4 right-4 z-[60] flex w-[min(380px,92vw)] flex-col gap-2 outline-none" />
    </RToast.Provider>
  )
}

/** Runs an async loader on mount and on demand, tracking loading/error. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const reload = async () => {
    setLoading(true)
    try {
      setData(await fn())
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload() }, deps)
  return { data, error, loading, reload, setError }
}
