// Captures the Files → S3 access dialog into docs/samples (run against a local stack with S3 storage).
//   cd marketing && node shot-s3.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const env = Object.fromEntries(readFileSync(`${root}.env`, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const base = 'http://127.0.0.1:3100'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(`${base}/login`)
await page.getByLabel('Username').fill(env.DASHBOARD_USERNAME || 'admin')
await page.getByLabel('Password').fill(env.DASHBOARD_PASSWORD)
await page.getByRole('button', { name: 'Sign in' }).click()
await page.waitForURL(`${base}/`)
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme })
  await page.goto(`${base}/storage`)
  await page.getByRole('button', { name: 'S3 access' }).click()
  await page.getByRole('dialog').waitFor()
  await page.waitForTimeout(600)
  const file = `${root}docs/samples/40-files-s3-access${scheme === 'dark' ? '-dark' : ''}.png`
  await page.screenshot({ path: file })
  console.log('wrote', file.slice(root.length))
}
await browser.close()
