import { X509Certificate } from 'node:crypto'
import tls from 'node:tls'
import { PUBLIC_URL } from '@/lib/project'

type Cert = tls.DetailedPeerCertificate

/** The root certificate that signs the public API address, as PEM, for devices that pin a CA (ESP32 setCACert). */
export async function GET() {
  const url = new URL(PUBLIC_URL)
  if (url.protocol !== 'https:') return Response.json({ error: 'The API is served over plain HTTP, so devices need no CA certificate.' }, { status: 404 })
  try {
    const leaf = await new Promise<Cert>((resolve, reject) => {
      const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, timeout: 8000 }, () => {
        resolve(socket.getPeerCertificate(true))
        socket.end()
      })
      socket.on('error', reject)
      socket.on('timeout', () => socket.destroy(new Error('timed out')))
    })
    let top = leaf
    while (top.issuerCertificate && top.issuerCertificate.fingerprint256 !== top.fingerprint256) top = top.issuerCertificate
    const pem = trustedRoot(new X509Certificate(top.raw)).toString()
    return new Response(pem, { headers: { 'content-type': 'application/x-pem-file', 'content-disposition': 'attachment; filename="root_ca.pem"' } })
  } catch (e) {
    return Response.json({ error: `Could not read the certificate of ${url.host}: ${(e as Error).message}` }, { status: 502 })
  }
}

/** Servers often stop at a cross-signed certificate; prefer the self-signed root from the trust store. */
function trustedRoot(top: X509Certificate) {
  if (top.subject === top.issuer) return top
  const store = tls.rootCertificates.map((p) => new X509Certificate(p))
  return store.find((c) => c.subject === top.issuer) ?? store.find((c) => c.subject === top.subject && c.publicKey.equals(top.publicKey)) ?? top
}
