import { KeyRound } from 'lucide-react'
import apple from 'thesvg/apple'
import auth0 from 'thesvg/auth0'
import authelia from 'thesvg/authelia'
import authentik from 'thesvg/authentik'
import bitbucket from 'thesvg/bitbucket'
import clerk from 'thesvg/clerk'
import discord from 'thesvg/discord'
import facebook from 'thesvg/facebook'
import fusionauth from 'thesvg/fusionauth'
import github from 'thesvg/github'
import gitlab from 'thesvg/gitlab'
import google from 'thesvg/google'
import keycloak from 'thesvg/keycloak'
import linkedin from 'thesvg/linkedin'
import logto from 'thesvg/logto-badge'
import microsoft from 'thesvg/microsoft'
import okta from 'thesvg/okta'
import openid from 'thesvg/openid'
import ory from 'thesvg/ory'
import slack from 'thesvg/slack'
import twitch from 'thesvg/twitch'

type Icon = { svg: string; hex: string; variants: Record<string, string | undefined> }

// Brand icons from thesvg.org (CC0/MIT), keyed by preset id.
const ICONS: Record<string, Icon> = {
  apple, auth0, authelia, authentik, bitbucket, clerk, discord, facebook, fusionauth, github, gitlab, google, keycloak,
  linkedin, logto, microsoft, okta, oidc: openid, ory, slack, twitch,
}
// Brands thesvg does not carry under a free licence: a lettered tile in the brand colour.
const TILES: Record<string, [string, string]> = {
  cognito: ['C', 'DD344C'], zitadel: ['Z', 'E8505B'], casdoor: ['C', '4285F4'], dex: ['D', '449FD8'], kanidm: ['K', 'FF6F00'],
}

/** The icon's SVG sized to the box. The markup is static, from the pinned package, never user input. */
const Svg = ({ markup, size, className, color }: { markup: string; size: number; className?: string; color?: string }) => (
  <span aria-hidden className={`shrink-0 [&>svg]:h-full [&>svg]:w-full ${className ?? 'inline-flex'}`} style={{ width: size, height: size, color }} dangerouslySetInnerHTML={{ __html: markup }} />
)

const luminance = (hex: string) => {
  const h = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function ProviderIcon({ preset, size = 16 }: { preset: string | null | undefined; size?: number }) {
  const icon = preset ? ICONS[preset] : undefined
  if (icon) {
    // "light" is drawn for light backgrounds and "dark" for dark ones (Apple's default mark is white).
    // A very dark mark with no dark version (Okta) uses its one-colour version in the text colour.
    const onLight = icon.variants.light ?? icon.svg
    const mono = !icon.variants.dark && luminance(icon.hex) < 0.25 && icon.variants.mono
    const onDark = icon.variants.dark ?? (mono ? mono.replace('<svg ', '<svg fill="currentColor" ') : icon.svg)
    if (onLight === onDark) return <Svg markup={onLight} size={size} />
    return (
      <>
        <Svg markup={onLight} size={size} className="inline-flex dark:hidden" />
        <Svg markup={onDark} size={size} className="hidden dark:inline-flex" color={mono ? 'var(--gray-12)' : undefined} />
      </>
    )
  }
  const tile = preset ? TILES[preset] : undefined
  if (tile) {
    return (
      <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className="shrink-0">
        <rect width="24" height="24" rx="5" fill={`#${tile[1]}`} />
        <text x="12" y="16.5" textAnchor="middle" fontSize="14" fontWeight="700" fontFamily="system-ui, sans-serif" fill="#fff">{tile[0]}</text>
      </svg>
    )
  }
  return <KeyRound aria-hidden size={size} className="shrink-0" style={{ color: 'var(--gray-11)' }} />
}
