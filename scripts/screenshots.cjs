// Playwright snippet that captures docs/samples (run via the Playwright MCP, or `node` with playwright installed).
async (page) => {
  const root = 'E:/radaz/kodudb'
  const user = '__DASHBOARD_USERNAME__'
  const pw = '__DASHBOARD_PASSWORD__' // both substituted from .env into a temp copy before running
  const base = 'http://127.0.0.1:3100' // not localhost: a browser zoom saved for localhost would shrink the shots
  const out = []
  const shot = async (name) => {
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${root}/docs/samples/${name}.png` })
    out.push(name)
  }
  const visit = async (path) => {
    await page.goto(base + path)
    await page.waitForLoadState('networkidle').catch(() => {})
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await visit('/login'); await page.waitForTimeout(2000); await page.mouse.move(980, 420); await shot('27-sign-in-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await visit('/login'); await page.waitForTimeout(2000); await page.mouse.move(980, 420); await shot('27-sign-in-light')
  await visit('/login')
  await shot('00-sign-in')
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password').fill(pw)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(`${base}/`)
  await page.evaluate(() => fetch('/api/project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'demo-store' }) }))

  await visit('/'); await shot('01-overview')
  await visit('/projects'); await shot('02-projects-and-keys')
  await visit('/tables?t=orders'); await shot('03-data-explorer')

  // Query console: run a query, then show IntelliSense on a table prefix.
  await visit('/sql')
  const editor = page.locator('.cm-content').first()
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('select category, count(*) as products, round(avg(price), 2) as avg_price\nfrom public.products\ngroup by category\norder by products desc;')
  await page.getByRole('button', { name: 'Run' }).click()
  await page.waitForTimeout(800)
  await shot('04-query-console')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nselect * from pro')
  await page.keyboard.press('Control+Space')
  await page.waitForTimeout(700)
  await shot('05-sql-intellisense')

  await visit('/database')
  await page.getByRole('tab', { name: 'Row security' }).click()
  await shot('06-schema-row-security')
  await visit('/auth'); await shot('07-identity')
  await visit('/storage'); await shot('08-files')
  await visit('/realtime'); await shot('09-live-events')
  await visit('/metrics'); await page.waitForTimeout(800); await shot('10-metrics')
  await visit('/logs'); await shot('11-request-logs')
  await visit('/history'); await shot('12-change-log')
  await visit('/versions'); await shot('13-migrations')
  await visit('/connectors'); await shot('14-data-sources')
  await visit('/api-docs'); await page.waitForTimeout(3500); await shot('15-api-reference')

  // Command palette and a confirmation dialog.
  await visit('/')
  await page.keyboard.press('Control+K')
  await page.keyboard.type('ord')
  await shot('16-command-palette')
  await page.keyboard.press('Escape')
  await visit('/projects')
  await page.getByRole('button', { name: 'Rotate all keys' }).click()
  await shot('17-rotate-keys-dialog')
  await page.keyboard.press('Escape')

  // Email (identity): users awaiting confirmation, settings, template preview, delivery log, API docs.
  await visit('/auth'); await shot('21-identity-awaiting-confirmation')
  await page.getByRole('tab', { name: 'Email settings' }).click(); await shot('22-email-settings')
  await page.getByLabel('Send test email to').fill('ops@shop.example.com')
  await page.getByRole('button', { name: 'Send test' }).click(); await page.waitForTimeout(1200); await shot('23-email-test-sent')
  await page.getByRole('tab', { name: 'Email templates' }).click(); await shot('24-email-templates')
  await page.getByRole('tab', { name: 'Sent emails' }).click(); await shot('25-sent-emails')
  await visit('/api-docs'); await page.waitForTimeout(3000)
  await page.getByText('Email a password-reset link').first().click(); await page.waitForTimeout(1500); await shot('26-api-reference-recover')

  // Two-factor: users with an authenticator, the admin reset action, the API reference section.
  await visit('/auth'); await shot('29-identity-two-factor')
  await page.getByRole('button', { name: 'Actions for customer1@example.com' }).click(); await page.waitForTimeout(400); await shot('30-reset-two-factor-menu')
  await page.keyboard.press('Escape')
  await visit('/api-docs'); await page.waitForTimeout(3000)
  await page.getByText('Two-factor', { exact: true }).first().click(); await page.waitForTimeout(800)
  await page.getByText('Start setting up an authenticator app').first().click(); await page.waitForTimeout(1500); await shot('31-api-reference-two-factor')

  // Sign-in providers: the list, an OpenID Connect provider's settings, adding one, a linked user, the API reference.
  await visit('/auth'); await page.getByRole('tab', { name: 'Sign-in providers' }).click(); await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'Edit Staff SSO' }).click(); await shot('32-sign-in-providers')
  await page.getByText('Trust email addresses from this provider').first().scrollIntoViewIfNeeded(); await shot('35-provider-oidc-settings')
  await page.getByRole('button', { name: 'Add provider' }).first().click(); await page.waitForTimeout(400)
  await page.getByRole('option', { name: /Okta/ }).click(); await shot('36-add-provider-presets')
  await page.getByLabel('Search providers').fill('key'); await page.waitForTimeout(400); await shot('38-add-provider-search')
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
  await visit('/auth'); await shot('33-identity-linked-github')
  await page.emulateMedia({ colorScheme: 'dark' })
  await visit('/auth'); await page.getByRole('tab', { name: 'Sign-in providers' }).click(); await page.waitForTimeout(600); await shot('37-sign-in-providers-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await visit('/api-docs'); await page.waitForTimeout(3000)
  await page.getByText('Sign-in providers', { exact: true }).first().click(); await page.waitForTimeout(800)
  await page.getByText('Return from the provider').first().click(); await page.waitForTimeout(1500); await shot('34-api-reference-providers')

  // Backgrounds (React Bits): sign-in waves and the console dot field, light and dark.
  await page.mouse.move(120, 760)
  await visit('/'); await page.mouse.move(110, 780); await page.waitForTimeout(800); await shot('28-console-background-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await visit('/'); await page.mouse.move(110, 780); await page.waitForTimeout(800); await shot('28-console-background-dark')
  await page.emulateMedia({ colorScheme: 'light' })

  await page.emulateMedia({ colorScheme: 'dark' })
  await visit('/'); await shot('18-dark-overview')
  await visit('/metrics'); await shot('19-dark-metrics')
  await page.emulateMedia({ colorScheme: 'light' })

  await page.setViewportSize({ width: 390, height: 844 })
  await visit('/'); await shot('20-phone-overview')
  await page.setViewportSize({ width: 1440, height: 900 })
  return out
}
