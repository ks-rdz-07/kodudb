// PM2 (Linux, macOS, Windows): `pm2 start ecosystem.config.cjs`.
// Completes .env first (scripts/gen-env.mjs only adds what is missing), then runs the API and the console
// with it. Build once before: `cargo build --release` in api/, `npm ci && npm run build` in console/.
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const root = __dirname
const envFile = process.env.KODUDB_ENV_FILE || path.join(root, '.env')
execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-env.mjs')], { stdio: 'inherit', env: { ...process.env, KODUDB_ENV_FILE: envFile } })
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const apiPort = process.env.API_PORT || env.API_PORT || '8787'

module.exports = {
  apps: [
    {
      name: 'kodudb-api',
      cwd: root,
      script: path.join(root, 'api', 'target', 'release', process.platform === 'win32' ? 'kodudb-api.exe' : 'kodudb-api'),
      interpreter: 'none',
      env: { ...env, PORT: apiPort, STORAGE_ROOT: env.STORAGE_ROOT || path.join(root, 'data', 'storage'), KODUDB_ENV_FILE: envFile },
      max_restarts: 20,
      restart_delay: 2000,
    },
    {
      name: 'kodudb-console',
      cwd: path.join(root, 'console'),
      script: path.join(root, 'console', 'node_modules', 'next', 'dist', 'bin', 'next'),
      args: 'start',
      // The console keeps no secrets: it signs in through the API.
      env: {
        NODE_ENV: 'production',
        PORT: process.env.CONSOLE_PORT || env.CONSOLE_PORT || '3100',
        KODUDB_API_URL: env.KODUDB_API_URL || `http://127.0.0.1:${apiPort}`,
        KODUDB_PUBLIC_URL: env.KODUDB_PUBLIC_URL,
      },
      max_restarts: 20,
      restart_delay: 2000,
    },
  ],
}
