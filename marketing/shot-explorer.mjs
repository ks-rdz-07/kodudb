// Screenshots of the Data explorer, table actions, command palette and SDKs page (local stack, demo data).
//   cd marketing && node shot-explorer.mjs <out-dir>
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = process.argv[2] ?? `${root}docs/samples`
const env = Object.fromEntries(readFileSync(`${root}.env`, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const base = 'http://127.0.0.1:3100'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${out}/${name}.png` }); console.log('wrote', name) }

await page.goto(`${base}/login`)
await page.getByLabel('Username').fill(env.DASHBOARD_USERNAME || 'admin')
await page.getByLabel('Password').fill(env.DASHBOARD_PASSWORD)
await page.getByRole('button', { name: 'Sign in' }).click()
await page.waitForURL(`${base}/`)
await page.evaluate(() => fetch('/api/project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'demo-store' }) }))

for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme })
  const sfx = scheme === 'dark' ? '-dark' : ''
  await page.goto(`${base}/tables?t=products`)
  await page.getByRole('button', { name: /^Sort by price/ }).click() // ascending
  await page.getByRole('button', { name: /^Sort by price/ }).click() // descending
  await shot(`41-data-explorer-sorted${sfx}`)
  await page.getByLabel('Search all columns').fill('co')
  await page.waitForTimeout(900)
  await shot(`42-data-explorer-search${sfx}`)
  if (scheme === 'dark') continue
  await page.getByLabel('Search all columns').fill('')
  await page.getByLabel('Search price').fill('> 5')
  await page.waitForTimeout(900)
  await shot('43-data-explorer-column-search')
  await page.getByRole('button', { name: 'products', exact: true }).click({ button: 'right' })
  await shot('44-table-context-menu')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Actions for products' }).click()
  await page.getByRole('menuitem', { name: /Modify table/ }).click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('dialog').getByRole('combobox', { name: 'Column type' }).first().click()
  await page.getByRole('option', { name: 'uuid', exact: true }).click()
  await shot('45-modify-table-uuid-key')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Actions for products' }).click()
  await page.getByRole('menuitem', { name: /Delete table/ }).click()
  await page.getByRole('alertdialog').waitFor()
  await shot('49-delete-table-confirm')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: /New table/ }).click()
  await page.getByRole('combobox', { name: 'Primary key' }).click()
  await shot('50-new-table-primary-key')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
}
await page.emulateMedia({ colorScheme: 'light' })
await page.goto(`${base}/`)
await page.keyboard.press('Control+k')
await page.getByRole('dialog').waitFor()
await shot('46-command-palette')
await page.keyboard.press('Escape')
await page.goto(`${base}/sdk`)
await shot('47-sdks-devices-js')
await page.getByRole('tab', { name: 'Statistics' }).click()
await page.getByRole('radio', { name: 'Python', exact: true }).click()
await shot('48-sdks-statistics-python')
const icon = await page.request.get(`${base}/icon.svg`)
console.log('favicon /icon.svg:', icon.status(), icon.headers()['content-type'])
await browser.close()
