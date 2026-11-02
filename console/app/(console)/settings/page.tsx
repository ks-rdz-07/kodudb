import { currentProject } from '@/lib/project'
import ProjectSettings from './settings'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const p = await currentProject()
  return <ProjectSettings slug={p.slug} name={p.name} />
}
