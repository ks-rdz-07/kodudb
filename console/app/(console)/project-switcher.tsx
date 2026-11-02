'use client'
import { useEffect, useState } from 'react'
import { Text } from '@radix-ui/themes'
import { kodu } from '@/lib/api'
import { Select } from '@/components/ui'

type P = { slug: string; name: string; parent: string | null }

export async function selectProject(slug: string, to?: string) {
  await fetch('/api/project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug }) })
  if (to) window.location.href = to
  else window.location.reload()
}

export default function ProjectSwitcher() {
  const [projects, setProjects] = useState<P[]>([])
  const [current, setCurrent] = useState('default')

  useEffect(() => {
    kodu<P[]>('platform/v1/projects').then(setProjects, () => {})
    fetch('/api/project').then((r) => r.json()).then((p) => setCurrent(p.slug), () => {})
  }, [])

  const options = projects.length ? projects.map((p) => ({ value: p.slug, label: p.parent ? `↳ ${p.name}` : p.name })) : [{ value: current, label: 'Loading…' }]
  return (
    <label className="flex flex-col gap-1">
      <Text size="1" color="gray" className="px-1">Project</Text>
      <Select label="Project" value={current} onChange={(s) => { setCurrent(s); selectProject(s) }} options={options} width="100%" />
    </label>
  )
}
