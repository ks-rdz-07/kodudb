import Docs from './docs'
import { PUBLIC_URL, currentProject } from '@/lib/project'

export const dynamic = 'force-dynamic'

export default async function ApiReference() {
  const p = await currentProject()
  return <Docs project={p.name} endpoint={PUBLIC_URL + p.path} publicKey={p.public_key} />
}
