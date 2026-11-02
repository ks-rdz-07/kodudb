# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

Do not open a public issue or pull request for a security problem.

Report it privately with **Report a vulnerability** on the Security tab of this repository
(GitHub private vulnerability reporting).

Please include:

- The KoduDB version (`api/Cargo.toml`) and how you deployed it (Compose, Podman, PM2, buildpack…).
- Steps to reproduce, and the impact you expect.
- The file, endpoint or code involved, if you know it.
- A proof of concept, kept to the minimum needed. Do not include real user data or keys.

We aim to acknowledge every report within 7 days.

## Security model

- **Keys.** Each project has a public key (browsers and apps; limited by row security policies) and a
  secret key (servers only; skips row security). Keys are JWTs signed with `JWT_SECRET`. Rotating a
  project's keys ends every session of that project at once.
- **Project isolation.** Every project database is owned by its own login role (`p_<project>_owner`, not a
  superuser), and only that role may connect to it. `COPY … PROGRAM`, `ALTER SYSTEM` and untrusted
  extensions are refused for project keys.
- **Secrets at rest.** Project keys, SMTP passwords, provider client secrets, GitHub tokens and data-source
  connection strings are encrypted with `ENCRYPTION_KEY`. Email links are single-use, expire after one hour
  and are stored hashed.
- **Console.** The console holds no secrets. It signs in through the API and uses a 12-hour token.
- **Sign-in.** Passwords are hashed. Failed sign-ins are rate-limited per email and per client address;
  two-factor codes are replay-proof and limited to 5 wrong attempts per 15 minutes. OpenID Connect uses
  PKCE, a nonce, a state cookie and full ID-token checks. Accounts link by verified email only.
- **Network.** KoduDB has no telemetry. It connects only to your Postgres, the SMTP server, sign-in
  providers, GitHub and data sources that you configure.
- **Proxies.** `X-Forwarded-For` is ignored unless `TRUST_PROXY=1` is set, which you should do only behind a
  reverse proxy you run.

See *Known limits* in the README for behaviour that is by design today (for example, stateless tokens stay
valid until they expire).
