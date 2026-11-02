// Minimal SMTP server for tests (no TLS, no auth checks). GET :18998/__mail returns every message received.
import { createServer as createTcp } from 'node:net'
import { createServer as createHttp } from 'node:http'

const mail = []

/** Pulls the base64 text/plain and text/html parts out of a MIME message. */
function parts(raw) {
  const out = {}
  for (const type of ['text/plain', 'text/html']) {
    const m = raw.match(new RegExp(`Content-Type: ${type}[^]*?\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n(?:\\r\\n|--)`, 'i'))
    if (m) out[type === 'text/plain' ? 'text' : 'html'] = Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8')
  }
  return out
}

createTcp((sock) => {
  let buf = ''
  let data = false
  let msg = { from: '', to: [], raw: '' }
  const say = (line) => sock.write(`${line}\r\n`)
  say('220 smtp-mock ready')
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    while (true) {
      if (data) {
        const end = buf.indexOf('\r\n.\r\n')
        if (end < 0) return
        msg.raw = buf.slice(0, end)
        buf = buf.slice(end + 5)
        data = false
        const subject = (msg.raw.match(/^Subject: (.*)$/im) ?? [])[1] ?? ''
        mail.push({ from: msg.from, to: msg.to, subject: subject.trim(), ...parts(msg.raw), at: new Date().toISOString() })
        msg = { from: '', to: [], raw: '' }
        say('250 queued')
        continue
      }
      const nl = buf.indexOf('\r\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 2)
      const cmd = line.slice(0, 4).toUpperCase()
      if (cmd === 'EHLO') { say('250-smtp-mock'); say('250 AUTH PLAIN') }
      else if (cmd === 'HELO') say('250 smtp-mock')
      else if (cmd === 'AUTH') say('235 authenticated')
      else if (cmd === 'MAIL') { msg.from = line.slice(10).replace(/[<>]/g, ''); say('250 ok') }
      else if (cmd === 'RCPT') { msg.to.push(line.slice(8).replace(/[<>]/g, '')); say('250 ok') }
      else if (cmd === 'DATA') { data = true; say('354 end with <CRLF>.<CRLF>') }
      else if (cmd === 'QUIT') { say('221 bye'); sock.end() }
      else say('250 ok')
    }
  })
  sock.on('error', () => {})
}).listen(2525, '0.0.0.0')

createHttp((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(mail))
}).listen(18998, '0.0.0.0')
