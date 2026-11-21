// Client for the Signal K Autopilot V2 API of the server the plugin runs in.
// It goes through the public REST API, not through any one autopilot plugin,
// so the bridge works with whatever V2 provider steers the boat. Writing
// needs a token when security is on: the bridge asks for one with a device
// access request, which the owner approves once in the admin UI.

import http from 'node:http'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import type { Pilot, PilotStatus } from './bridge.js'

export interface HttpResponse {
  status: number
  body: unknown
}

export type Requester = (method: string, url: string, body?: unknown, token?: string) => Promise<HttpResponse>

// Plain node:http(s), so a server with a self-signed certificate on
// localhost works without extra dependencies.
export const nodeRequest: Requester = (method, url, body, token) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = lib.request(
      u,
      {
        method,
        rejectUnauthorized: !['localhost', '127.0.0.1', '::1'].includes(u.hostname),
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        timeout: 5000
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          let parsed: unknown = text
          try {
            parsed = text ? JSON.parse(text) : undefined
          } catch {
            // keep the text
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })

const PILOT = '/signalk/v2/api/vessels/self/autopilots/_default'

function check(res: HttpResponse, what: string): void {
  if (res.status >= 200 && res.status < 300) return
  const b = res.body as { message?: string } | undefined
  throw new Error(`${what}: HTTP ${res.status}${b?.message ? ` ${b.message}` : ''}`)
}

export class V2Pilot implements Pilot {
  constructor(
    private readonly baseUrl: string,
    private readonly token: () => string | undefined,
    private readonly request: Requester = nodeRequest
  ) {}

  async status(): Promise<PilotStatus | undefined> {
    const res = await this.request('GET', this.baseUrl + PILOT, undefined, this.token())
    if (res.status === 404) return undefined
    check(res, 'GET autopilot')
    const b = res.body as { state?: unknown; engaged?: unknown; target?: unknown }
    return {
      state: typeof b.state === 'string' ? b.state : null,
      engaged: b.engaged === true,
      target: typeof b.target === 'number' ? b.target : null
    }
  }

  private async write(method: string, path: string, body?: unknown): Promise<void> {
    const res = await this.request(method, this.baseUrl + PILOT + path, body, this.token())
    check(res, `${method} ${path}`)
  }

  setState(state: string): Promise<void> {
    return this.write('PUT', '/state', { value: state })
  }

  disengage(): Promise<void> {
    return this.write('POST', '/disengage')
  }

  adjust(radians: number): Promise<void> {
    return this.write('PUT', '/target/adjust', { value: radians, units: 'rad' })
  }

  tack(direction: 'port' | 'starboard'): Promise<void> {
    return this.write('POST', `/tack/${direction}`)
  }
}

export interface TokenStore {
  load(): { clientId?: string; token?: string; href?: string }
  save(v: { clientId?: string; token?: string; href?: string }): void
}

// Device access request: POST once, then follow the returned href until the
// owner approves or denies it in the admin UI.
export class AccessRequest {
  private state: { clientId?: string; token?: string; href?: string }
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly baseUrl: string,
    private readonly store: TokenStore,
    private readonly status: (msg: string) => void,
    private readonly request: Requester = nodeRequest
  ) {
    this.state = store.load()
  }

  token(): string | undefined {
    return this.state.token
  }

  start(): void {
    if (this.state.token) return
    void this.step()
    this.timer = setInterval(() => void this.step(), 10000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  // forget a token the server no longer accepts
  reset(): void {
    this.state = { clientId: this.state.clientId }
    this.store.save(this.state)
  }

  async step(): Promise<void> {
    try {
      if (this.state.token) {
        this.stop()
        return
      }
      if (!this.state.href) {
        const clientId = this.state.clientId ?? randomUUID()
        const res = await this.request('POST', this.baseUrl + '/signalk/v1/access/requests', {
          clientId,
          description: 'Raymarine Pilot Bridge (p70s control)',
          permissions: 'readwrite'
        })
        const b = res.body as { href?: string; message?: string } | undefined
        if (res.status === 404 && /security is not enabled/i.test(b?.message ?? '')) {
          // nothing to ask for: an open server takes writes without a token
          this.status('security off, no token needed')
          this.stop()
          return
        }
        if (!b?.href) {
          this.status(`access request failed: HTTP ${res.status} ${b?.message ?? ''}`)
          return
        }
        this.state = { clientId, href: b.href }
        this.store.save(this.state)
        this.status('waiting for approval in Security → Access Requests')
        return
      }
      const res = await this.request('GET', this.baseUrl + this.state.href)
      const b = res.body as {
        state?: string
        accessRequest?: { permission?: string; token?: string }
      }
      if (res.status >= 400) {
        // The server keeps pending requests in memory: after a restart the
        // href answers 404 or 500. Ask again on the next step.
        this.state = { clientId: this.state.clientId }
        this.store.save(this.state)
        this.status('access request lost (server restarted?), asking again')
        return
      }
      if (b?.state === 'COMPLETED') {
        if (b.accessRequest?.permission === 'APPROVED' && b.accessRequest.token) {
          this.state = { clientId: this.state.clientId, token: b.accessRequest.token }
          this.store.save(this.state)
          this.status('access approved')
          this.stop()
        } else {
          this.state = { clientId: this.state.clientId }
          this.store.save(this.state)
          this.status('access request denied')
          this.stop()
        }
      }
    } catch (e) {
      this.status(`access request: ${String(e)}`)
    }
  }
}
