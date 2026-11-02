// Marketing images -> docs/images, and with --video a short product tour -> docs/media.
// Built from the console screenshots in docs/samples (demo data only).
//   cd marketing && npm ci && npx playwright install chromium
//   node images.mjs            images
//   node images.mjs --video    images + MP4/GIF tour (needs ffmpeg on PATH)
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const IMAGES = `${root}docs/images`
const MEDIA = `${root}docs/media`
const FRAMES = `${root}marketing/frames`

// Brand: Radix red on near-black, matching the console's accent.
const C = { ink: '#0d0d0f', panel: '#18181b', red: '#e5484d', redHi: '#ff6369', coral: '#ff977d', amber: '#ffc53d',
  green: '#30a46c', blue: '#3e63dd', white: '#f4f4f5', muted: '#a1a1aa' }
const PALETTE = [['Ink', C.ink], ['Panel', C.panel], ['Kodu Red', C.red], ['Ember', C.redHi], ['Coral', C.coral],
  ['Amber', C.amber], ['Green', C.green], ['Indigo', C.blue], ['Paper', C.white]]
const NAME = 'KoduDB'
const LINES = ['Open backend.', 'Live devices.']
const PITCH = 'Postgres, identity, a generated REST API and S3 files for your apps, with real-time data to and from ' +
  'ESP32, Raspberry Pi and industrial gateways, on infrastructure you control.'
const FEATURES = [
  ['Build', 'Model data in the explorer or with SQL. The REST API follows your schema.', C.red, '04-query-console'],
  ['Secure', 'Email, two-factor and sign-in providers, with row security on every request.', C.amber, '32-sign-in-providers'],
  ['Ship', 'Every schema change becomes a migration, synced to GitHub.', C.green, '13-migrations'],
  ['Observe', 'Request rate, latency, errors and logs for every project, live.', C.blue, '10-metrics'],
]

const shots = {}
const shot = (n) => (shots[n] ??= `data:image/png;base64,${readFileSync(`${root}docs/samples/${n}.png`).toString('base64')}`)

const logo = (s, fill = C.red) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
  <rect width="24" height="24" rx="6" fill="${fill}"/>
  <ellipse cx="12" cy="7.6" rx="6.2" ry="2.3" stroke="#fff" stroke-width="1.7"/>
  <path d="M5.8 11.6c0 1.3 2.8 2.3 6.2 2.3s6.2-1 6.2-2.3" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>
  <path d="M5.8 15.6c0 1.3 2.8 2.3 6.2 2.3s6.2-1 6.2-2.3" stroke="#fff" stroke-width="1.7" stroke-linecap="round" opacity=".75"/></svg>`

const css = (u) => `
  * { box-sizing: border-box; margin: 0 }
  body { width: 100vw; height: 100vh; overflow: hidden; background: ${C.ink}; color: ${C.white};
    font-family: 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; position: relative }
  .bg { position: absolute; inset: 0; background:
    radial-gradient(60% 70% at 12% 18%, ${C.red}38, transparent 70%),
    radial-gradient(55% 65% at 92% 88%, ${C.coral}22, transparent 70%),
    radial-gradient(40% 40% at 78% 4%, ${C.amber}14, transparent 70%), ${C.ink} }
  .grid { position: absolute; inset: 0; background-image: radial-gradient(#ffffff14 ${1.2 * u}px, transparent ${1.4 * u}px);
    background-size: ${28 * u}px ${28 * u}px; mask-image: linear-gradient(180deg, #000, transparent 85%) }
  .display { font-family: 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif; font-weight: 700;
    letter-spacing: -0.02em; line-height: 1.04 }
  .hot { background: linear-gradient(100deg, ${C.redHi}, ${C.coral}); -webkit-background-clip: text; color: transparent }
  .muted { color: ${C.muted} }
  .mark { display: flex; align-items: center; gap: 0.32em; font-weight: 600 }
  .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 0.42em 0.95em; font-weight: 600;
    border: 1px solid; white-space: nowrap }
  .win { position: absolute; border-radius: ${14 * u}px; overflow: hidden; background: #fff;
    box-shadow: 0 ${30 * u}px ${80 * u}px #000a, 0 0 0 1px #ffffff22 }
  .win .bar { height: ${34 * u}px; background: #1c1c1f; display: flex; align-items: center; gap: ${7 * u}px; padding: 0 ${14 * u}px }
  .win .dot { width: ${11 * u}px; height: ${11 * u}px; border-radius: 50% }
  .win .url { margin-left: ${14 * u}px; flex: 1; height: ${20 * u}px; border-radius: ${6 * u}px; background: #ffffff10;
    color: ${C.muted}; font-size: ${12 * u}px; display: flex; align-items: center; padding: 0 ${10 * u}px }
  .win img { display: block; width: 100%; height: calc(100% - ${34 * u}px); object-fit: cover; object-position: top left }
  .card { position: absolute; border-radius: ${18 * u}px; background: #18181bd9; border: 1px solid #ffffff1c }
`
const pill = (s, c) => `<span class="pill" style="color:${c};border-color:${c}99;background:${c}1f">${s}</span>`
const win = (n, { x, y, w, h, u, url = 'localhost:3100' }) => `<div class="win" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>
  <span class="dot" style="background:#28c840"></span><span class="url">${url}</span></div><img src="${shot(n)}"></div>`
const mark = (size, sub) => `<div class="mark" style="font-size:${size}px">${logo(size * 1.15)}<span>${NAME}</span>
  ${sub ? `<span class="muted" style="font-weight:400;font-size:.42em;margin-left:.4em;margin-top:.5em">${sub}</span>` : ''}</div>`
const headline = (size) => `<div class="display" style="font-size:${size}px">${LINES[0]}<br><span class="hot">${LINES[1]}</span></div>`
const page = (w, h, body) => `<!doctype html><html><head><style>${css(w / 1920)}</style></head><body>
  <div class="bg"></div><div class="grid"></div>${body}</body></html>`
const ratio = 900 / 1440 // screenshot aspect

// A device card for the hero: chip icon, name, platform line and a live value.
const chip = (s, color) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6">
  <rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="${color}22"/>
  <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>`
function device(x, y, wd, u, { name, kind, value, label, color }) {
  return `<div class="card" style="left:${x}px;top:${y}px;width:${wd}px;padding:${18 * u}px ${20 * u}px;background:#141417f2;
      box-shadow:0 ${18 * u}px ${50 * u}px #0009;display:flex;gap:${14 * u}px;align-items:center">
    <div style="width:${52 * u}px;height:${52 * u}px;border-radius:${12 * u}px;background:${color}1f;display:grid;place-items:center;flex:none">${chip(30 * u, color)}</div>
    <div style="min-width:0;flex:1">
      <div style="font-size:${19 * u}px;font-weight:600;white-space:nowrap">${name}</div>
      <div class="muted" style="font-size:${14 * u}px;white-space:nowrap">${kind}</div>
    </div>
    <div style="text-align:right;flex:none">
      <div style="font-size:${22 * u}px;font-weight:700;color:${color}">${value}</div>
      <div class="muted" style="font-size:${12 * u}px;display:flex;gap:${6 * u}px;align-items:center;justify-content:flex-end">
        <span style="width:${8 * u}px;height:${8 * u}px;border-radius:50%;background:${C.green};box-shadow:0 0 ${8 * u}px ${C.green}"></span>${label}</div>
    </div></div>`
}
const event = (x, y, u, text, color) => `<div style="position:absolute;left:${x}px;top:${y}px;font:600 ${14 * u}px Consolas,monospace;
  color:${color};background:#0d0d0fe6;border:1px solid ${color}66;border-radius:${8 * u}px;padding:${6 * u}px ${10 * u}px;white-space:nowrap">${text}</div>`

function wide(w, h) {
  const u = h / 1080, ww = w * 0.37, wh = ww * ratio + 34 * u
  const wx = w * 0.385, wy = (h - wh) / 2
  const dx = w * 0.785, dw = w * 0.19, dh = 96 * u
  const ys = [h * 0.19, h * 0.5 - dh / 2, h * 0.81 - dh]
  const devices = [
    { name: 'sensor-17', kind: 'ESP32 · temperature', value: '21.5°C', label: 'live', color: C.coral },
    { name: 'line-3-pi', kind: 'Raspberry Pi · vibration', value: '0.42 g', label: 'live', color: C.amber },
    { name: 'plant-gw-01', kind: 'IIoT gateway · Modbus', value: '1,284/min', label: 'streaming', color: C.blue },
  ]
  // curved links from each device card to the console window
  const links = ys.map((y, i) => {
    const sx = dx, sy = y + dh / 2, ex = wx + ww - 8 * u, ey = wy + wh * (0.3 + i * 0.22)
    return `<path d="M${sx} ${sy} C ${sx - 60 * u} ${sy}, ${ex + 60 * u} ${ey}, ${ex} ${ey}" stroke="${devices[i].color}" stroke-width="${2.2 * u}"
      fill="none" stroke-dasharray="${7 * u} ${7 * u}" opacity=".85"/><circle cx="${ex}" cy="${ey}" r="${5 * u}" fill="${devices[i].color}"/>`
  }).join('')
  return page(w, h, `
    ${win('01-overview', { x: wx, y: wy, w: ww, h: wh, u })}
    <svg style="position:absolute;left:0;top:0" width="${w}" height="${h}">${links}</svg>
    ${devices.map((d, i) => device(dx, ys[i], dw, u, d)).join('')}
    ${event(wx + ww * 0.38, wy - 50 * u, u, 'INSERT readings · sensor-17 · 21.5', C.coral)}
    ${event(wx + ww * 0.06, wy + wh + 18 * u, u, 'UPDATE commands · relay-3 · on', C.green)}
    <div style="position:absolute;left:${w * 0.05}px;top:${h * 0.5}px;transform:translateY(-50%);width:${w * 0.31}px">
      ${mark(60 * u)}
      <div style="height:${56 * u}px"></div><div style="white-space:nowrap">${headline(80 * u)}</div>
      <p class="muted" style="font-size:${23 * u}px;line-height:1.45;margin-top:${26 * u}px">${PITCH}</p>
      <div style="display:flex;flex-wrap:wrap;gap:${12 * u}px;margin-top:${36 * u}px;font-size:${17 * u}px">
        ${pill('Self-hosted', C.red)}${pill('Realtime', C.coral)}${pill('IoT · IIoT · Embedded', C.amber)}${pill('Apache-2.0', C.blue)}</div>
    </div>`)
}

function billboard(w = 3840, h = 1280) {
  const u = h / 1280, ww = w * 0.48
  return page(w, h, `
    ${win('01-overview', { x: w * 0.5, y: h * 0.12, w: ww, h: ww * ratio + 34 * u * 2, u: u * 2 })}
    <div style="position:absolute;left:${w * 0.05}px;top:${h * 0.13}px">${mark(130 * u)}
      <div style="height:${90 * u}px"></div>${headline(200 * u)}
      <p class="muted" style="font-size:${52 * u}px;font-weight:600;margin-top:${50 * u}px">Open backend · Real-time devices · IoT · IIoT</p></div>`)
}

function square(s = 1080) {
  const u = s / 1080, ww = 1100 * u
  return page(s, s, `
    <div style="position:absolute;left:${70 * u}px;top:${70 * u}px">${mark(56 * u)}
      <div style="height:${60 * u}px"></div>${headline(88 * u)}
      <p class="muted" style="font-size:${28 * u}px;margin-top:${26 * u}px">Open backend with real-time device data</p></div>
    ${win('07-identity', { x: 70 * u, y: 560 * u, w: ww, h: ww * ratio + 34 * u, u })}`)
}

function feature([title, desc, color, n], w = 1200, h = 720) {
  const u = w / 1200, ww = w - 120 * u
  return page(w, h, `<div style="position:absolute;left:${60 * u}px;top:${52 * u}px;width:${ww}px;font-size:${18 * u}px">
      ${pill(title.toUpperCase(), color)}
      <div class="display" style="font-size:${40 * u}px;margin-top:${22 * u}px;line-height:1.2">${desc}</div></div>
    ${win(n, { x: 60 * u, y: 250 * u, w: ww, h: ww * ratio + 34 * u, u })}`)
}

function featureGrid(w = 1920, h = 1200) {
  const u = w / 1920, gap = 50 * u, cw = (w - 120 * u - gap) / 2, ch = (h - 200 * u - 60 * u - gap) / 2
  const cards = FEATURES.map(([title, desc, color, n], i) => {
    const x = 60 * u + (i % 2) * (cw + gap), y = 190 * u + Math.floor(i / 2) * (ch + gap)
    return `<div class="card" style="left:${x}px;top:${y}px;width:${cw}px;height:${ch}px;overflow:hidden">
      <div style="padding:${28 * u}px ${30 * u}px 0;font-size:${16 * u}px">${pill(title.toUpperCase(), color)}
        <p style="font-size:${24 * u}px;margin-top:${16 * u}px;line-height:1.35">${desc}</p></div>
      <img src="${shot(n)}" style="position:absolute;left:${30 * u}px;top:${150 * u}px;width:${cw - 60 * u}px;border-radius:${10 * u}px ${10 * u}px 0 0"></div>`
  }).join('')
  return page(w, h, `<div class="display" style="position:absolute;top:${70 * u}px;width:100%;text-align:center;font-size:${54 * u}px">
    Everything an app backend needs, <span class="hot">on Postgres</span></div>${cards}`)
}

function themes(w = 1920, h = 1080) {
  const u = w / 1920, rh = h - 200 * u, rw = (rh - 34 * u) / ratio, x = (w - rw) / 2, y = 160 * u
  const clip = 'polygon(62% 0, 100% 0, 100% 100%, 38% 100%)'
  return page(w, h, `<div class="display" style="position:absolute;top:${55 * u}px;width:100%;text-align:center;font-size:${54 * u}px">
      Light or dark. <span class="hot">Your call.</span></div>
    ${win('01-overview', { x, y, w: rw, h: rh, u })}
    <div style="position:absolute;left:0;top:0;width:100%;height:100%;clip-path:inset(0)">
      <div style="position:absolute;left:${x}px;top:${y}px;width:${rw}px;height:${rh}px;clip-path:${clip}">
        ${win('18-dark-overview', { x: 0, y: 0, w: rw, h: rh, u })}</div></div>
    <svg style="position:absolute;left:${x}px;top:${y}px" width="${rw}" height="${rh}">
      <line x1="${rw * 0.62}" y1="0" x2="${rw * 0.38}" y2="${rh}" stroke="${C.red}" stroke-width="${3 * u}"/></svg>`)
}

function brandSheet(w = 1920, h = 1080) {
  const u = w / 1920, m = 60 * u, gap = 30 * u, cw = (w - 2 * m - gap) / 2, top = 560 * u, bot = h - 2 * m - gap - top
  const card = (t, x, y, cw, ch, inner) => `<div class="card" style="left:${x}px;top:${y}px;width:${cw}px;height:${ch}px;padding:${36 * u}px">
    <div class="muted" style="font-size:${16 * u}px;font-weight:600;letter-spacing:${4 * u}px">${t}</div>${inner}</div>`
  const tiles = ['#ffffff', C.ink, C.red].map((bg) => `<div style="width:${150 * u}px;height:${150 * u}px;border-radius:${16 * u}px;
    background:${bg};border:1px solid #ffffff33;display:grid;place-items:center">${logo(78 * u, bg === C.red ? '#0d0d0f' : C.red)}</div>`).join('')
  const swatches = PALETTE.map(([n, hex]) => `<div style="display:flex;gap:${16 * u}px;align-items:center">
    <div style="width:${96 * u}px;height:${96 * u}px;border-radius:${14 * u}px;background:${hex};border:1.5px solid #ffffff46"></div>
    <div><div style="font-size:${22 * u}px;font-weight:600">${n}</div>
    <div class="muted" style="font-size:${18 * u}px;font-family:Consolas,monospace">${hex.toUpperCase()}</div></div></div>`).join('')
  const voice = ['Plain and precise: say what it does, in short sentences.', 'Confident, never boastful: let the features speak.',
    'Open: explain limits as clearly as features.', 'Secure by default: keys, row security and isolation come first.',
    'Respectful of your stack: runs where you already run things.']
    .map((s) => `<li style="margin:${10 * u}px 0">${s}</li>`).join('')
  return page(w, h, `
    ${card('BRAND', m, m, cw, top, `<div style="margin-top:${34 * u}px">${mark(64 * u)}</div>
      <p class="muted" style="font-size:${22 * u}px;margin:${14 * u}px 0 ${30 * u}px">${LINES.join(' ')}</p>
      <div style="display:flex;gap:${20 * u}px">${tiles}</div>
      <p class="muted" style="font-size:${19 * u}px;margin-top:${22 * u}px">Clear space: half the mark's height. Never recolour the rings, stretch the mark or add effects.</p>`)}
    ${card('COLOUR', m + cw + gap, m, cw, top, `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:${30 * u}px ${10 * u}px;margin-top:${36 * u}px">${swatches}</div>`)}
    ${card('TYPE', m, m + top + gap, cw, bot, `<div class="display" style="font-size:${50 * u}px;margin-top:${26 * u}px">Aa Segoe UI Variable</div>
      <p class="muted" style="font-size:${20 * u}px;margin:${6 * u}px 0 ${20 * u}px">Display · headlines · Semibold or Bold</p>
      <div style="font-size:${34 * u}px">Aa Segoe UI</div>
      <p class="muted" style="font-size:${20 * u}px;margin-top:${6 * u}px">Body copy, UI labels and captions</p>`)}
    ${card('VOICE', m + cw + gap, m + top + gap, cw, bot, `<ul style="font-size:${22 * u}px;margin-top:${20 * u}px;padding-left:${24 * u}px">${voice}</ul>`)}`)
}

// Video slides: one product screen per slide with a caption.
function slide(title, desc, color, n, w = 1920, h = 1080) {
  const u = w / 1920, rh = h - 300 * u, rw = (rh - 34 * u) / ratio
  return page(w, h, `<div style="position:absolute;left:0;top:${60 * u}px;width:100%;text-align:center;font-size:${20 * u}px">
      ${pill(title.toUpperCase(), color)}<div class="display" style="font-size:${46 * u}px;margin-top:${18 * u}px">${desc}</div></div>
    ${win(n, { x: (w - rw) / 2, y: 250 * u, w: rw, h: rh, u })}`)
}
function endCard(w = 1920, h = 1080) {
  const u = w / 1920
  return page(w, h, `<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center">
    <div>${`<div style="display:flex;justify-content:center">${mark(80 * u)}</div>`}<div style="height:${50 * u}px"></div>${headline(120 * u)}
    <p class="muted" style="font-size:${30 * u}px;margin-top:${40 * u}px">Free and open source · Apache-2.0</p></div></div>`)
}

const browser = await chromium.launch()
const tab = await browser.newPage()
async function render(html, w, h, file) {
  await tab.setViewportSize({ width: w, height: h })
  await tab.setContent(html, { waitUntil: 'load' })
  await tab.screenshot({ path: file, type: file.endsWith('.png') ? 'png' : 'jpeg', ...(file.endsWith('.png') ? {} : { quality: 90 }) })
  console.log('wrote', file.slice(root.length))
}

mkdirSync(IMAGES, { recursive: true })
await render(wide(1920, 1080), 1920, 1080, `${IMAGES}/hero.jpg`)
await render(wide(1280, 640), 1280, 640, `${IMAGES}/social-preview.jpg`) // GitHub social preview size
await render(wide(1200, 630), 1200, 630, `${IMAGES}/og-image.jpg`) // Open Graph card size
await render(billboard(), 3840, 1280, `${IMAGES}/billboard.jpg`)
await render(square(), 1080, 1080, `${IMAGES}/social-square.jpg`)
for (const f of FEATURES) await render(feature(f), 1200, 720, `${IMAGES}/feature-${f[0].toLowerCase()}.jpg`)
await render(featureGrid(), 1920, 1200, `${IMAGES}/features.jpg`)
await render(themes(), 1920, 1080, `${IMAGES}/themes.jpg`)
await render(brandSheet(), 1920, 1080, `${IMAGES}/brand-sheet.jpg`)

if (process.argv.includes('--video')) {
  rmSync(FRAMES, { recursive: true, force: true })
  mkdirSync(FRAMES, { recursive: true })
  mkdirSync(MEDIA, { recursive: true })
  const slides = [wide(1920, 1080),
    slide('Projects', 'Every project is its own Postgres database, with its own keys.', C.red, '02-projects-and-keys'),
    ...FEATURES.map(([t, d, c, n]) => slide(t, d, c, n)),
    slide('Identity', 'Users, two-factor and sign-in activity in one place.', C.amber, '07-identity'),
    slide('API reference', 'An OpenAPI document generated from your live schema.', C.blue, '15-api-reference'),
    endCard()]
  for (const [i, html] of slides.entries()) await render(html, 1920, 1080, `${FRAMES}/${String(i).padStart(2, '0')}.png`)
  const hold = 3.2, fade = 0.6, n = slides.length
  const inputs = slides.flatMap((_, i) => ['-loop', '1', '-t', String(hold + fade), '-i', `${FRAMES}/${String(i).padStart(2, '0')}.png`])
  let chain = '', prev = '0:v'
  for (let i = 1; i < n; i++) {
    const out = `x${i}`
    chain += `[${prev}][${i}:v]xfade=transition=fade:duration=${fade}:offset=${(i * hold).toFixed(2)}[${out}];`
    prev = out
  }
  const mp4 = `${MEDIA}/kodudb-tour.mp4`
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', chain + `[${prev}]format=yuv420p[v]`, '-map', '[v]',
    '-r', '30', '-c:v', 'libx264', '-crf', '22', '-movflags', '+faststart', mp4])
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', mp4, '-vf',
    'fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer', `${MEDIA}/preview.gif`])
  writeFileSync(`${MEDIA}/poster.jpg`, readFileSync(`${IMAGES}/hero.jpg`))
  console.log('wrote /docs/media/kodudb-tour.mp4, preview.gif, poster.jpg')
}
await browser.close()
