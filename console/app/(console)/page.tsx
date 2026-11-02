import { PUBLIC_URL, currentProject } from '@/lib/project'
import Overview from './overview'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const p = await currentProject()
  return <Overview project={{ slug: p.slug, name: p.name, endpoint: PUBLIC_URL + p.path, publicKey: p.public_key, secretKey: p.secret_key }} />
}
