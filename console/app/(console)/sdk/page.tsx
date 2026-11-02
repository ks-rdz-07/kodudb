import { PUBLIC_URL, currentProject } from '@/lib/project'
import { SdkSamples } from './samples-view'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const p = await currentProject()
  return <SdkSamples endpoint={PUBLIC_URL + p.path} publicKey={p.public_key} project={p.name} />
}
