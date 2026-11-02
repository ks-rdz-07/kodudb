import type { NextConfig } from 'next'

// The Docker image ships the standalone server; buildpacks, Nixpacks, Railpack and PM2 run `next start`.
const config: NextConfig = process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}

export default config
