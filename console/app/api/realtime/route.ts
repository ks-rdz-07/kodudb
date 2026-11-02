// Streams realtime events to the inspector as Server-Sent Events, keeping the service key server-side.
import { API, currentProject } from '@/lib/project'

export async function GET(req: Request) {
  const table = new URL(req.url).searchParams.get('table') || '*'
  const project = await currentProject()
  const wsUrl = `${API.replace(/^http/, 'ws')}${project.path}/realtime/v1/websocket?apikey=${encodeURIComponent(project.secret_key)}`
  const enc = new TextEncoder()
  let ws: WebSocket | undefined

  const stream = new ReadableStream({
    start(ctrl) {
      const send = (data: string) => {
        try {
          ctrl.enqueue(enc.encode(`data: ${data}\n\n`))
        } catch {
          ws?.close()
        }
      }
      ws = new WebSocket(wsUrl)
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'subscribe', table }))
      ws.onmessage = (e) => send(String(e.data))
      ws.onerror = () => send(JSON.stringify({ type: 'error', error: 'realtime connection failed' }))
      ws.onclose = () => {
        try {
          ctrl.close()
        } catch {}
      }
      req.signal.addEventListener('abort', () => ws?.close())
    },
    cancel() {
      ws?.close()
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  })
}
