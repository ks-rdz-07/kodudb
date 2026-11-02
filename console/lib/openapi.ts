// Builds an OpenAPI 3.1 document for one project from its live schema: identity, every table, functions, files.
type Column = { name: string; type: string; nullable: boolean; default: string | null; primary_key: boolean }
type Fn = { schema: string; name: string; args: string; returns: string }
export type SchemaInput = { tables: { name: string; rls_enabled: boolean; columns: Column[] }[]; functions: Fn[] }

const jsonType = (t: string): { type: string; format?: string; items?: object } => {
  if (/\[\]$/.test(t)) return { type: 'array', items: jsonType(t.slice(0, -2)) }
  if (/^(bigint|integer|smallint)/.test(t)) return { type: 'integer', format: t.startsWith('bigint') ? 'int64' : 'int32' }
  if (/^(numeric|double|real|decimal)/.test(t)) return { type: 'number' }
  if (t === 'boolean') return { type: 'boolean' }
  if (t === 'uuid') return { type: 'string', format: 'uuid' }
  if (/^timestamp/.test(t)) return { type: 'string', format: 'date-time' }
  if (t === 'date') return { type: 'string', format: 'date' }
  if (t === 'json' || t === 'jsonb') return { type: 'object' }
  return { type: 'string' }
}

const sample = (c: Column, i = 0): unknown => {
  const t = c.type
  if (/\[\]$/.test(t)) return ['first', 'second']
  if (/^(bigint|integer|smallint)/.test(t)) return c.primary_key ? 101 + i : 3 + i
  if (/^(numeric|double|real|decimal)/.test(t)) return 12.5 + i
  if (t === 'boolean') return i % 2 === 0
  if (t === 'uuid') return ['6f1c2e7a-3b4d-4c8e-9a1f-2d3e4f5a6b7c', '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'][i % 2]
  if (/^timestamp/.test(t)) return `2026-10-2${8 - i}T09:3${i}:00Z`
  if (t === 'date') return `2026-10-2${8 - i}`
  if (t === 'json' || t === 'jsonb') return { note: 'any JSON' }
  return `${c.name.replace(/_/g, ' ')} ${i + 1}`
}

const row = (cols: Column[], i = 0) => Object.fromEntries(cols.map((c) => [c.name, sample(c, i)]))
const writable = (cols: Column[]) => cols.filter((c) => !c.primary_key && !(c.default ?? '').includes('now()') && !(c.default ?? '').includes('auth.uid()'))

const err = (description: string, message: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { error: message } } },
})

export function buildSpec({ server, project, input }: { server: string; project: string; input: SchemaInput }) {
  const paths: Record<string, object> = {}
  const schemas: Record<string, object> = {
    Error: { type: 'object', properties: { error: { type: 'string', description: 'What went wrong, in words.' } }, required: ['error'] },
    Session: {
      type: 'object',
      description: 'Returned by sign-up, sign-in and refresh. Send access_token as `Authorization: Bearer …` on later requests.',
      properties: {
        access_token: { type: 'string', description: 'JWT, valid for 1 hour.' },
        token_type: { type: 'string', example: 'bearer' },
        expires_in: { type: 'integer', example: 3600 },
        refresh_token: { type: 'string', description: 'JWT, valid for 30 days. Exchange it for a new session.' },
        user: { $ref: '#/components/schemas/User' },
      },
    },
    User: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' }, role: { type: 'string', example: 'authenticated' },
        user_metadata: { type: 'object' }, banned: { type: 'boolean' }, last_sign_in_at: { type: ['string', 'null'], format: 'date-time' }, created_at: { type: 'string', format: 'date-time' },
      },
    },
  }

  const user = { id: '6f1c2e7a-3b4d-4c8e-9a1f-2d3e4f5a6b7c', email: 'customer@example.com', role: 'authenticated', user_metadata: { plan: 'free' }, banned: false, last_sign_in_at: '2026-10-28T09:30:00Z', created_at: '2026-10-01T08:00:00Z' }
  const session = { access_token: 'eyJhbGciOiJIUzI1NiJ9.…', token_type: 'bearer', expires_in: 3600, refresh_token: 'eyJhbGciOiJIUzI1NiJ9.…', user }

  // ---------- identity ----------
  paths['/auth/v1/signup'] = {
    post: {
      tags: ['Identity'], summary: 'Sign up with email and password', operationId: 'signUp',
      description: 'Creates a user and returns a session right away. `data` is stored as the user’s metadata and appears in their token.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8, maxLength: 72 }, data: { type: 'object', description: 'Optional profile fields, up to 16 KB.' } } }, example: { email: 'customer@example.com', password: 'a-long-passphrase', data: { plan: 'free' } } } } },
      responses: { 200: { description: 'Signed up and signed in.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' }, example: session } } }, 400: err('Invalid email or a password outside 8–72 characters.', 'password must be 8-72 characters'), 409: err('The email is already registered.', 'user already registered') },
    },
  }
  paths['/auth/v1/token'] = {
    post: {
      tags: ['Identity'], summary: 'Sign in, or refresh a session', operationId: 'token',
      description: 'With `grant_type=password` send email and password. With `grant_type=refresh_token` send the refresh token from an earlier session to get a new one.',
      parameters: [{ name: 'grant_type', in: 'query', required: true, schema: { type: 'string', enum: ['password', 'refresh_token'] } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, refresh_token: { type: 'string' } } }, examples: { password: { summary: 'Sign in', value: { email: 'customer@example.com', password: 'a-long-passphrase' } }, refresh: { summary: 'Refresh', value: { refresh_token: 'eyJhbGciOiJIUzI1NiJ9.…' } } } } } },
      responses: { 200: { description: 'A new session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' }, example: session } } }, 400: err('Wrong email or password.', 'invalid login credentials'), 403: err('The user is banned.', 'user is banned') },
    },
  }
  paths['/auth/v1/user'] = {
    get: { tags: ['Identity'], summary: 'Get the signed-in user', operationId: 'getUser', security: [{ publicKey: [], userToken: [] }], responses: { 200: { description: 'The user behind the access token.', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' }, example: user } } }, 401: err('Missing or expired user token.', 'user token required') } },
    put: {
      tags: ['Identity'], summary: 'Update password or profile', operationId: 'updateUser', security: [{ publicKey: [], userToken: [] }],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { password: { type: 'string', minLength: 8 }, data: { type: 'object' } } }, example: { data: { plan: 'pro' } } } } },
      responses: { 200: { description: 'The updated user.', content: { 'application/json': { example: { ...user, user_metadata: { plan: 'pro' } } } } } },
    },
  }
  paths['/auth/v1/logout'] = { post: { tags: ['Identity'], summary: 'Sign out', operationId: 'signOut', security: [{ publicKey: [], userToken: [] }], description: 'Tokens are stateless: discard them on the client. Rotate the project’s keys to end every session at once.', responses: { 204: { description: 'Signed out.' } } } }

  paths['/auth/v1/recover'] = {
    post: {
      tags: ['Identity'], summary: 'Email a password-reset link', operationId: 'recover',
      description: 'Sends a single-use link (valid 1 hour) when the email has an account. The answer is the same either way, so it cannot reveal who has an account. 3 requests per email per 15 minutes.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, redirect_to: { type: 'string', description: 'Page on your site to land on; other sites are refused.' } } }, example: { email: 'customer@example.com', redirect_to: 'https://app.example.com/reset' } } } },
      responses: { 200: { description: 'Accepted.', content: { 'application/json': { example: { message: 'If that email has an account, a reset link is on its way.' } } } }, 429: err('Too many requests for this email.', 'too many emails requested; try again in 840 s') },
    },
  }
  paths['/auth/v1/resend'] = {
    post: {
      tags: ['Identity'], summary: 'Resend the confirmation email', operationId: 'resend',
      description: 'For a user who signed up while email confirmation is on and has not opened the link yet.',
      requestBody: { required: true, content: { 'application/json': { example: { email: 'customer@example.com' } } } },
      responses: { 200: { description: 'Accepted.', content: { 'application/json': { example: { message: 'If that email is waiting for confirmation, a new link is on its way.' } } } } },
    },
  }
  paths['/auth/v1/verify'] = {
    get: {
      tags: ['Identity'], summary: 'Open an emailed link', operationId: 'verifyLink', security: [],
      description: 'The link inside confirmation and reset emails. It redirects to your site URL with the session in the fragment: `#access_token=…&refresh_token=…&type=signup|recovery`, or `#error=…` when the link is used or expired. On `type=recovery`, call `PUT /auth/v1/user` with the new password.',
      parameters: [
        { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'type', in: 'query', required: true, schema: { type: 'string', enum: ['confirm', 'recovery'] } },
        { name: 'redirect_to', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 303: { description: 'Redirect to the site with the session in the URL fragment.' } },
    },
    post: {
      tags: ['Identity'], summary: 'Exchange a link token for a session', operationId: 'verify',
      description: 'The same as opening the link, for apps that read the token themselves (for example a mobile deep link).',
      requestBody: { required: true, content: { 'application/json': { example: { token: '3f9c…', type: 'recovery' } } } },
      responses: { 200: { description: 'A session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' }, example: session } } }, 400: err('The link is invalid, used or expired.', 'link is invalid, used or expired') },
    },
  }
  const providerRow = {
    provider: 'okta-staff', preset: 'okta', name: 'Staff SSO', display_name: 'Staff SSO', enabled: true, ready: true, protocol: 'oidc',
    client_id: '0oa8x2k1…', client_secret_set: true, enterprise_url: null, issuer: 'https://your-org.okta.com/oauth2/default', scopes: null,
    default_scopes: 'openid email profile', trust_email: false, callback_url: 'https://api.example.com/p/demo-store/auth/v1/callback', updated_at: '2026-10-29T09:00:00Z',
  }
  paths['/auth/v1/providers'] = {
    get: {
      tags: ['Sign-in providers'], summary: 'List the sign-in providers that are on', operationId: 'listProviders',
      description: 'For drawing “Continue with …” buttons. Only providers that are enabled and fully set up are listed.',
      responses: { 200: { description: 'Providers.', content: { 'application/json': { example: [{ provider: 'google', name: 'Google' }, { provider: 'okta-staff', name: 'Staff SSO' }] } } } },
    },
  }
  paths['/auth/v1/authorize'] = {
    get: {
      tags: ['Sign-in providers'], summary: 'Start sign-in with a provider', operationId: 'authorize', security: [],
      description: 'Open this in the browser (a link or `window.location`), no key needed. It sets a short-lived HttpOnly state cookie and redirects to the provider’s consent page. OpenID Connect providers get a nonce and a PKCE (S256) challenge.',
      parameters: [
        { name: 'provider', in: 'query', required: true, schema: { type: 'string' }, description: 'The provider id from Identity → Sign-in providers.', example: 'google' },
        { name: 'redirect_to', in: 'query', schema: { type: 'string' }, description: 'Where to land afterwards; must be on the site URL, otherwise the site URL is used.', example: 'https://app.example.com/welcome' },
      ],
      responses: { 303: { description: 'Redirect to the provider.' }, 400: err('The provider is off or not set up.', 'google sign-in is not enabled for this project') },
    },
  }
  paths['/auth/v1/callback'] = {
    get: {
      tags: ['Sign-in providers'], summary: 'Return from the provider', operationId: 'oauthCallback', security: [],
      description: 'The provider sends the browser here; register this URL as the redirect URL in every provider. OpenID Connect ID tokens are checked (signature against the provider’s keys, issuer, audience, expiry, nonce). The account is matched by provider id, then by verified email; otherwise a new user is created. It redirects to the site with `#access_token=…&refresh_token=…&type=oauth`, with `#mfa_required=true&mfa_token=…` when the user has an authenticator, or with `#error=…`.',
      parameters: [{ name: 'code', in: 'query', schema: { type: 'string' } }, { name: 'state', in: 'query', schema: { type: 'string' } }],
      responses: { 303: { description: 'Redirect to the site with the session (or error) in the URL fragment.' } },
    },
    post: {
      tags: ['Sign-in providers'], summary: 'Return from the provider (form post)', operationId: 'oauthCallbackPost', security: [],
      description: 'The same, for providers that answer with `response_mode=form_post` (Apple). Needs an https API so the state cookie can be sent.',
      requestBody: { content: { 'application/x-www-form-urlencoded': { example: { code: 'c1f…', state: 'eyJ…' } } } },
      responses: { 303: { description: 'Redirect to the site.' } },
    },
  }
  paths['/auth/v1/admin/providers'] = {
    get: { tags: ['Sign-in providers'], summary: 'List configured providers (secret key)', operationId: 'adminListProviders', security: [{ publicKey: [], secretKey: [] }], responses: { 200: { description: 'Providers, without secrets.', content: { 'application/json': { example: [providerRow] } } } } },
  }
  paths['/auth/v1/admin/providers/presets'] = {
    get: {
      tags: ['Sign-in providers'], summary: 'List provider presets (secret key)', operationId: 'listPresets', security: [{ publicKey: [], secretKey: [] }],
      description: 'Google, Apple, Microsoft, GitHub, GitLab, Discord, Facebook, LinkedIn, Slack, Twitch, Bitbucket, Okta, Auth0, Clerk, Amazon Cognito, Keycloak, authentik, ZITADEL, Authelia, Logto, Casdoor, Ory, Dex, Kanidm, FusionAuth and “Other OpenID Connect”.',
      responses: { 200: { description: 'Presets.', content: { 'application/json': { example: [{ id: 'keycloak', name: 'Keycloak', group: 'Open source', protocol: 'oidc', issuer: null, issuer_hint: 'https://sso.example.com/realms/<realm>', scopes: 'openid email profile', enterprise_url: false }] } } } },
    },
  }
  paths['/auth/v1/admin/providers/{provider}'] = {
    put: {
      tags: ['Sign-in providers'], summary: 'Add or change a provider (secret key)', operationId: 'putProvider', security: [{ publicKey: [], secretKey: [] }],
      description: 'The path segment is your id for the provider (2-32 lowercase letters, digits, dashes). When adding, `preset` picks the provider type; it defaults to the id, so `PUT …/providers/google` needs no preset. Fields left out keep their value; the client secret is write-only and stored encrypted. `trust_email` accepts addresses the provider does not mark as verified; use it only for a directory you control.',
      parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' }, example: 'okta-staff' }],
      requestBody: { required: true, content: { 'application/json': { example: { preset: 'okta', display_name: 'Staff SSO', enabled: true, client_id: '0oa8x2k1…', client_secret: '…', issuer: 'https://your-org.okta.com/oauth2/default' } } } },
      responses: { 200: { description: 'All providers, without secrets.', content: { 'application/json': { example: [providerRow] } } }, 400: err('Bad id, unknown preset or a non-http URL.', 'unknown preset my-idp; see GET /auth/v1/admin/providers/presets'), 403: err('Needs the secret key.', 'secret key required') },
    },
    delete: {
      tags: ['Sign-in providers'], summary: 'Remove a provider (secret key)', operationId: 'deleteProvider', security: [{ publicKey: [], secretKey: [] }],
      description: 'Linked accounts stay, so adding the provider again under the same id signs people into the same users.',
      parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 204: { description: 'Removed.' }, 404: err('No such provider.', 'provider not found') },
    },
  }
  const factor = { id: '0d6a…', type: 'totp', friendly_name: 'Phone', status: 'verified', created_at: '2026-10-29T09:00:00Z', verified_at: '2026-10-29T09:01:00Z' }
  paths['/auth/v1/factors'] = {
    get: { tags: ['Two-factor'], summary: 'List my authenticators', operationId: 'listFactors', security: [{ publicKey: [], userToken: [] }], responses: { 200: { description: 'Factors of the signed-in user (no secrets).', content: { 'application/json': { example: [factor] } } } } },
    post: {
      tags: ['Two-factor'], summary: 'Start setting up an authenticator app', operationId: 'enrollFactor', security: [{ publicKey: [], userToken: [] }],
      description: 'Returns a TOTP secret, an `otpauth://` URI and a QR code (SVG data URI) to show the user. The factor is inactive until confirmed with `/factors/{id}/verify`. One active authenticator per user.',
      requestBody: { content: { 'application/json': { example: { friendly_name: 'Phone' } } } },
      responses: {
        200: { description: 'Show the QR code; ask for the first code.', content: { 'application/json': { example: { id: '0d6a…', type: 'totp', friendly_name: 'Phone', totp: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: 'otpauth://totp/KoduDB%20demo-store:customer%40example.com?secret=…&issuer=KoduDB%20demo-store&algorithm=SHA1&digits=6&period=30', qr_code: 'data:image/svg+xml;base64,PHN2Zy…' } } } } },
        409: err('An authenticator is already active.', 'an authenticator is already set up; remove it first'),
      },
    },
  }
  paths['/auth/v1/factors/{id}/verify'] = {
    post: {
      tags: ['Two-factor'], summary: 'Confirm an authenticator with its first code', operationId: 'verifyFactor', security: [{ publicKey: [], userToken: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { example: { code: '492039' } } } },
      responses: { 200: { description: 'Active; returns a session with `aal: aal2`.', content: { 'application/json': { example: session } } }, 400: err('Wrong code.', 'invalid code'), 429: err('Five wrong codes in 15 minutes.', 'too many wrong codes; try again in 840 s') },
    },
  }
  paths['/auth/v1/factors/{id}'] = {
    delete: {
      tags: ['Two-factor'], summary: 'Remove an authenticator', operationId: 'unenrollFactor', security: [{ publicKey: [], userToken: [] }],
      description: 'Needs a two-factor (`aal2`) session for an active factor, so a stolen password cannot switch two-factor off.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: { 204: { description: 'Removed.' }, 403: err('Session is password-only.', 'sign in with your authenticator code first') },
    },
  }
  const tokenPost = (paths['/auth/v1/token'] as { post: { description: string; parameters: { schema: { enum: string[] } }[]; requestBody: { content: { 'application/json': { examples: Record<string, unknown> } } }; responses: Record<string, unknown> } }).post
  tokenPost.description += ' Users with an authenticator get `{ mfa_required: true, mfa_token, factors }` from the password grant instead of a session; send `grant_type=mfa_totp` with `{ mfa_token, code }` within 5 minutes to finish. Sessions carry `aal` (aal1 or aal2) for policies such as `auth.jwt() ->> \'aal\' = \'aal2\'`.'
  tokenPost.parameters[0].schema.enum = ['password', 'refresh_token', 'mfa_totp']
  tokenPost.requestBody.content['application/json'].examples.mfa = { summary: 'Second step (mfa_totp)', value: { mfa_token: 'eyJhbGciOiJIUzI1NiJ9.…', code: '492039' } }
  tokenPost.responses[200] = {
    description: 'A session, or a two-factor challenge.',
    content: { 'application/json': { examples: { session: { summary: 'Session', value: session }, challenge: { summary: 'Authenticator code needed', value: { mfa_required: true, mfa_token: 'eyJhbGciOiJIUzI1NiJ9.…', expires_in: 300, factors: [{ id: '0d6a…', type: 'totp', friendly_name: 'Phone' }] } } } } },
  }

  const signupPost = (paths['/auth/v1/signup'] as { post: { responses: Record<string, unknown>; description: string } }).post
  signupPost.description += ' When email confirmation is on, no session is returned: the user gets a link by email and cannot sign in until they open it.'
  signupPost.responses[200] = {
    description: 'Signed up. With confirmation on, `{ user, confirmation_sent: true }` instead of a session.',
    content: { 'application/json': { examples: { session: { summary: 'Confirmation off', value: session }, pending: { summary: 'Confirmation on', value: { user: { ...user, email_confirmed_at: null }, confirmation_sent: true } } } } },
  }

  // ---------- tables ----------
  for (const t of input.tables) {
    const name = t.name
    const ref = `#/components/schemas/${name}`
    schemas[name] = {
      type: 'object',
      description: `A row of \`${name}\`.`,
      properties: Object.fromEntries(t.columns.map((c) => [c.name, { ...jsonType(c.type), ...(c.nullable ? { nullable: true } : {}), description: `${c.type}${c.primary_key ? ', primary key' : ''}${c.default ? `, default ${c.default}` : ''}` }])),
      required: t.columns.filter((c) => !c.nullable && !c.default).map((c) => c.name),
    }
    const w = writable(t.columns)
    const sec = t.rls_enabled
      ? `Row security is on: each caller sees and changes only the rows its policies allow. Send a user’s access token as Bearer to act as that user.`
      : `**Row security is off**: anyone with the public key can read and change every row. Turn it on under Schema.`
    const filters = t.columns.map((c) => ({
      name: c.name, in: 'query', required: false, schema: { type: 'string' },
      description: `Filter on ${c.name} (${c.type}): \`eq.\`, \`neq.\`, \`gt.\`, \`gte.\`, \`lt.\`, \`lte.\`, \`like.\`, \`ilike.\` (use * as wildcard), \`is.null\`, \`in.(a,b)\`; prefix with \`not.\` to negate.`,
    }))
    const rows = [row(t.columns, 0), row(t.columns, 1)]
    const pk = t.columns.find((c) => c.primary_key)
    const byPk = pk ? `${pk.name}=eq.${sample(pk)}` : ''
    paths[`/rest/v1/${name}`] = {
      get: {
        tags: [`Table: ${name}`], summary: `List ${name}`, operationId: `list_${name}`,
        description: `Reads rows of \`${name}\`. ${sec}\n\nExample: \`GET /rest/v1/${name}?select=${t.columns.slice(0, 3).map((c) => c.name).join(',')}&order=${pk?.name ?? t.columns[0]?.name}.desc&limit=20\``,
        parameters: [
          { name: 'select', in: 'query', schema: { type: 'string', default: '*' }, description: 'Comma-separated columns to return.' },
          { name: 'order', in: 'query', schema: { type: 'string' }, description: 'column.asc or column.desc, optionally .nullsfirst / .nullslast; comma-separated.' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 1000, maximum: 10000 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'Prefer', in: 'header', schema: { type: 'string', enum: ['count=exact'] }, description: 'Send count=exact to get the total in the X-Total-Count header.' },
          ...filters,
        ],
        responses: {
          200: { description: 'Matching rows.', headers: { 'X-Total-Count': { schema: { type: 'integer' }, description: 'Total matching rows, with Prefer: count=exact.' } }, content: { 'application/json': { schema: { type: 'array', items: { $ref: ref } }, example: rows } } },
          400: err('Unknown column, operator or a value of the wrong type.', 'unknown column: colour'),
        },
      },
      post: {
        tags: [`Table: ${name}`], summary: `Insert into ${name}`, operationId: `insert_${name}`,
        description: `Inserts one row (an object) or many (an array). Omitted columns take their defaults. For an upsert send \`Prefer: resolution=merge-duplicates\` with \`?on_conflict=${pk?.name ?? 'column'}\`.`,
        parameters: [
          { name: 'on_conflict', in: 'query', schema: { type: 'string' }, description: 'Columns of a unique constraint, for upserts.' },
          { name: 'Prefer', in: 'header', schema: { type: 'string', enum: ['resolution=merge-duplicates', 'resolution=ignore-duplicates'] } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { oneOf: [{ $ref: ref }, { type: 'array', items: { $ref: ref } }] }, examples: { one: { summary: 'One row', value: Object.fromEntries(w.map((c) => [c.name, sample(c)])) }, many: { summary: 'Several rows', value: [0, 1].map((i) => Object.fromEntries(w.map((c) => [c.name, sample(c, i)]))) } } } } },
        responses: { 201: { description: 'The inserted rows, with their defaults filled in.', content: { 'application/json': { schema: { type: 'array', items: { $ref: ref } }, example: [rows[0]] } } }, 400: err('A required column is missing or a value has the wrong type.', 'null value in column violates not-null constraint'), 403: err('Row security rejected the row.', 'new row violates row-level security policy'), 409: err('A unique value already exists.', 'duplicate key value violates unique constraint') },
      },
      patch: {
        tags: [`Table: ${name}`], summary: `Update ${name}`, operationId: `update_${name}`,
        description: `Updates the rows matching the filters with the fields in the body. At least one filter is required, so a missing filter can never update the whole table.${byPk ? ` Example: \`PATCH /rest/v1/${name}?${byPk}\`.` : ''}`,
        parameters: filters,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: ref }, example: Object.fromEntries(w.slice(0, 2).map((c) => [c.name, sample(c, 1)])) } } },
        responses: { 200: { description: 'The updated rows (empty when none matched or row security hid them).', content: { 'application/json': { schema: { type: 'array', items: { $ref: ref } }, example: [rows[1]] } } }, 400: err('No filter was given.', 'update requires at least one filter') },
      },
      delete: {
        tags: [`Table: ${name}`], summary: `Delete from ${name}`, operationId: `delete_${name}`,
        description: `Deletes the rows matching the filters. At least one filter is required.${byPk ? ` Example: \`DELETE /rest/v1/${name}?${byPk}\`.` : ''}`,
        parameters: filters,
        responses: { 200: { description: 'The deleted rows.', content: { 'application/json': { schema: { type: 'array', items: { $ref: ref } }, example: [rows[0]] } } }, 400: err('No filter was given.', 'delete requires at least one filter') },
      },
    }
  }

  // ---------- functions ----------
  for (const f of input.functions.filter((x) => x.schema === 'public')) {
    const args = f.args ? f.args.split(',').map((a) => a.trim().split(/\s+/)) : []
    paths[`/rest/v1/rpc/${f.name}`] = {
      post: {
        tags: ['Functions'], summary: `Call ${f.name}(${f.args})`, operationId: `rpc_${f.name}`,
        description: `Runs the database function \`public.${f.name}\` with named arguments and returns \`${f.returns}\`. It runs with the caller’s role, so row security applies inside it.`,
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(args.map(([n, ty]) => [n, { ...jsonType(ty ?? 'text'), description: ty }])) }, example: Object.fromEntries(args.map(([n, ty]) => [n, sample({ name: n, type: ty ?? 'text', nullable: true, default: null, primary_key: false })])) } } },
        responses: { 200: { description: `The function’s result (${f.returns}).`, content: { 'application/json': {} } }, 404: err('No function with these argument names.', `function not found for these arguments: ${f.name}`) },
      },
    }
  }

  // ---------- files ----------
  const bucket = { id: 'product-images', public: true, created_at: '2026-10-01T08:00:00Z', objects: 6, bytes: 1824 }
  const obj = { id: '0b1d…', name: 'catalog/sku-1000.svg', owner: user.id, size: 304, mimetype: 'image/svg+xml', created_at: '2026-10-28T09:30:00Z' }
  paths['/storage/v1/bucket'] = {
    get: { tags: ['Files'], summary: 'List buckets', operationId: 'listBuckets', responses: { 200: { description: 'Buckets with file counts and total bytes.', content: { 'application/json': { example: [bucket] } } } } },
    post: { tags: ['Files'], summary: 'Create a bucket (secret key)', operationId: 'createBucket', security: [{ publicKey: [], secretKey: [] }], requestBody: { content: { 'application/json': { example: { id: 'invoices', public: false } } } }, responses: { 200: { description: 'The bucket.', content: { 'application/json': { example: { id: 'invoices', public: false, created_at: '2026-10-28T09:30:00Z' } } } }, 403: err('Needs the secret key.', 'secret key required') } },
  }
  paths['/storage/v1/object/{bucket}/{path}'] = {
    parameters: [{ name: 'bucket', in: 'path', required: true, schema: { type: 'string' }, example: 'product-images' }, { name: 'path', in: 'path', required: true, schema: { type: 'string' }, example: 'catalog/sku-1000.svg' }],
    post: { tags: ['Files'], summary: 'Upload a file', operationId: 'upload', description: 'Send the raw bytes as the body with their Content-Type. Add `x-upsert: true` to replace an existing file. Up to 50 MB. A signed-in user becomes the owner.', parameters: [{ name: 'x-upsert', in: 'header', schema: { type: 'string', enum: ['true'] } }], requestBody: { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { 200: { description: 'The stored file’s record.', content: { 'application/json': { example: obj } } }, 409: err('A file already exists at this path.', 'object already exists (use x-upsert: true)') } },
    get: { tags: ['Files'], summary: 'Download a file', operationId: 'download', responses: { 200: { description: 'The file bytes with their content type.' }, 404: err('Not found, or hidden by row security.', 'object not found') } },
    delete: { tags: ['Files'], summary: 'Delete a file', operationId: 'deleteFile', responses: { 204: { description: 'Deleted.' }, 404: err('Not found, or not yours.', 'object not found') } },
  }
  paths['/storage/v1/object/list/{bucket}'] = {
    post: { tags: ['Files'], summary: 'List files', operationId: 'listFiles', parameters: [{ name: 'bucket', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { example: { prefix: 'catalog/', limit: 100, offset: 0 } } } }, responses: { 200: { description: 'Files under the prefix, by name.', content: { 'application/json': { example: [obj] } } } } },
  }
  paths['/storage/v1/object/public/{bucket}/{path}'] = {
    get: { tags: ['Files'], summary: 'Public file link', operationId: 'publicFile', security: [], description: 'Files in public buckets need no key. Use this URL directly in an <img> or a link.', parameters: [{ name: 'bucket', in: 'path', required: true, schema: { type: 'string' } }, { name: 'path', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The file bytes.' }, 404: err('Not found, or the bucket is private.', 'object not found') } },
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${project} API`,
      version: '1.0.0',
      description: [
        `REST API of the **${project}** project, generated from its live schema.`,
        '',
        '**Keys.** Every request sends a project key in the `apikey` header. The **public key** is safe in browsers and apps: row security policies decide what it can reach. The **secret key** skips row security and belongs on servers only.',
        '',
        '**Users.** Sign a user in with `POST /auth/v1/token?grant_type=password`, then send `Authorization: Bearer <access_token>` with the public key to act as that user (their id is `auth.uid()` in policies).',
        '',
        `**Live events.** Open \`${server.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=<public key>&token=<access token>\` and send \`{"type":"subscribe","table":"orders"}\`. Each insert, update and delete arrives as \`{"type","table","record","old_record"}\`, filtered by row security.`,
      ].join('\n'),
    },
    servers: [{ url: server, description: project }],
    security: [{ publicKey: [] }],
    tags: [
      { name: 'Identity', description: 'Sign-up, sign-in, sessions and the current user.' },
      { name: 'Sign-in providers', description: 'Sign in with Google, Apple, Microsoft, GitHub, Okta, Auth0, Clerk, Keycloak, authentik, ZITADEL or any OpenID Connect provider; linked to users by verified email.' },
      { name: 'Two-factor', description: 'Authenticator apps (TOTP): set up, confirm, remove; sign-in asks for a code once set up.' },
      ...input.tables.map((t) => ({ name: `Table: ${t.name}`, description: `Rows of \`${t.name}\`.${t.rls_enabled ? '' : ' Row security is off.'}` })),
      { name: 'Functions', description: 'Database functions callable over HTTP.' },
      { name: 'Files', description: 'Buckets and files.' },
    ],
    paths,
    components: {
      securitySchemes: {
        publicKey: { type: 'apiKey', in: 'header', name: 'apikey', description: 'The project’s public key (or the secret key on servers).' },
        userToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A signed-in user’s access token.' },
        secretKey: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'The project’s secret key, for admin operations.' },
      },
      schemas,
    },
  }
}
