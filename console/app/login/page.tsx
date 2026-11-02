'use client'
import { useState } from 'react'
import { Button, Callout, Card, Flex, Heading, IconButton, Text, TextField, Tooltip } from '@radix-ui/themes'
import { Eye, EyeOff } from 'lucide-react'
import { Logo } from '@/components/logo'
import { SignInBackground } from '@/components/backgrounds'

export default function Login() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(e.currentTarget)
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
    }).catch(() => null)
    setBusy(false)
    if (!res) setError('The console is not reachable. Check that it is running and try again.')
    else if (res.ok) window.location.href = '/'
    else if (res.status === 429) setError('Too many attempts. Wait a minute and try again.')
    else if (res.status === 502) setError('The KoduDB API is not reachable. Check that it is running.')
    else setError('That username or password is not right.')
  }

  return (
    <main className="relative grid min-h-screen place-items-center p-4">
      <SignInBackground />
      <Card size="4" className="relative z-10 w-full max-w-[380px]">
        <form onSubmit={submit}>
          <Flex direction="column" gap="4">
            <Flex align="center" gap="2"><Logo size={26} /><Text size="4" weight="bold">KoduDB</Text></Flex>
            <div>
              <Heading as="h1" size="5" weight="medium">Sign in to the console</Heading>
              <Text as="p" size="2" color="gray" mt="1">Find them in your .env file, or in the API’s first start-up log.</Text>
            </div>
            <label className="flex flex-col gap-1.5">
              <Text size="2" weight="medium">Username</Text>
              <TextField.Root name="username" size="3" autoFocus required autoComplete="username" defaultValue="admin" />
            </label>
            <label className="flex flex-col gap-1.5">
              <Text size="2" weight="medium">Password</Text>
              <TextField.Root name="password" type={shown ? 'text' : 'password'} size="3" required autoComplete="current-password">
                <TextField.Slot side="right">
                  <Tooltip content={shown ? 'Hide password' : 'Show password'}>
                    <IconButton type="button" size="1" variant="ghost" color="gray" aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} onClick={() => setShown(!shown)}>
                      {shown ? <EyeOff size={15} /> : <Eye size={15} />}
                    </IconButton>
                  </Tooltip>
                </TextField.Slot>
              </TextField.Root>
            </label>
            {error && <Callout.Root color="red" size="1" role="alert"><Callout.Text>{error}</Callout.Text></Callout.Root>}
            <Button size="3" loading={busy}>Sign in</Button>
            <Flex justify="between" align="center" pt="3" className="border-t border-[var(--gray-a5)]">
              <Text size="1" color="gray">© {new Date().getFullYear()} KoduDB contributors</Text>
              <Text size="1" color="gray">v{process.env.NEXT_PUBLIC_KODUDB_VERSION}</Text>
            </Flex>
          </Flex>
        </form>
      </Card>
    </main>
  )
}
