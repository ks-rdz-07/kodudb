import type { NextConfig } from 'next'
import pkg from './package.json'

// The Docker image ships the standalone server; buildpacks, Nixpacks, Railpack and PM2 run `next start`.
const config: NextConfig = {
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  env: { NEXT_PUBLIC_KODUDB_VERSION: pkg.version }, // shown on the sign-in card
}

export default config
