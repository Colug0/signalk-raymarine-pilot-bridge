import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { AccessRequest, V2Pilot, type Requester } from '../src/v2.js'
import { identity } from '../src/canbus.js'

function fake(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: { method: string; url: string; body?: unknown; token?: string }[] = []
  const request: Requester = async (method, url, body, token) => {
    calls.push({ method, url, body, token })
    const r = responses[`${method} ${new URL(url).pathname}`]
    return r ? { status: r.status, body: r.body } : { status: 404, body: { message: 'not found' } }
  }
  return { calls, request }
}

const BASE = 'http://127.0.0.1:3000'
const AP = '/signalk/v2/api/vessels/self/autopilots/_default'

describe('V2 pilot', () => {
  it('reads the default pilot', async () => {
    const { request } = fake({ [`GET ${AP}`]: { status: 200, body: { state: 'auto', engaged: true, target: 1.2, mode: null } } })
    const p = new V2Pilot(BASE, () => undefined, request)
    expect(await p.status()).toEqual({ state: 'auto', engaged: true, target: 1.2 })
  })

  it('no provider is no pilot, not an error', async () => {
    const { request } = fake({})
    expect(await new V2Pilot(BASE, () => undefined, request).status()).toBeUndefined()
  })

  it('writes with the token', async () => {
    const { request, calls } = fake({
      [`PUT ${AP}/state`]: { status: 200 },
      [`POST ${AP}/disengage`]: { status: 200 },
      [`PUT ${AP}/target/adjust`]: { status: 200 },
      [`POST ${AP}/tack/port`]: { status: 200 }
    })
    const p = new V2Pilot(BASE, () => 'tok', request)
    await p.setState('auto')
    await p.disengage()
    await p.adjust(0.5)
    await p.tack('port')
    expect(calls.map((c) => [c.method, new URL(c.url).pathname, c.body, c.token])).toEqual([
      ['PUT', `${AP}/state`, { value: 'auto' }, 'tok'],
      ['POST', `${AP}/disengage`, undefined, 'tok'],
      ['PUT', `${AP}/target/adjust`, { value: 0.5, units: 'rad' }, 'tok'],
      ['POST', `${AP}/tack/port`, undefined, 'tok']
    ])
  })

  it('reports a refused write with the server message', async () => {
    const { request } = fake({ [`PUT ${AP}/state`]: { status: 401, body: { message: 'Unauthorized' } } })
    await expect(new V2Pilot(BASE, () => undefined, request).setState('auto')).rejects.toThrow('HTTP 401 Unauthorized')
  })
})

describe('access request', () => {
  it('asks once, waits, and keeps the approved token', async () => {
    let saved: Record<string, unknown> = {}
    const store = { load: () => ({}), save: (v: Record<string, unknown>) => (saved = v) }
    const status: string[] = []
    const { request, calls } = fake({
      'POST /signalk/v1/access/requests': { status: 202, body: { state: 'PENDING', href: '/signalk/v1/requests/abc' } },
      'GET /signalk/v1/requests/abc': {
        status: 200,
        body: { state: 'COMPLETED', accessRequest: { permission: 'APPROVED', token: 'secret' } }
      }
    })
    const a = new AccessRequest(BASE, store, (m) => status.push(m), request)
    await a.step()
    expect(saved.href).toBe('/signalk/v1/requests/abc')
    expect((calls[0].body as { permissions: string }).permissions).toBe('readwrite')
    await a.step()
    expect(a.token()).toBe('secret')
    expect(saved.token).toBe('secret')
    expect(status).toContain('access approved')
  })
})

describe('access request on an open server', () => {
  it('stops asking when security is off', async () => {
    const status: string[] = []
    const { request, calls } = fake({
      'POST /signalk/v1/access/requests': {
        status: 404,
        body: { message: 'Access requests not available. Server security is not enabled.' }
      }
    })
    const a = new AccessRequest(BASE, { load: () => ({}), save: () => {} }, (m) => status.push(m), request)
    await a.step()
    expect(status).toEqual(['security off, no token needed'])
    expect(calls).toHaveLength(1)
  })
})

describe('identity on the bus', () => {
  it('claims as a Raymarine autopilot with the EV-1 product name', () => {
    const require = createRequire(import.meta.url)
    const { toPgn, FromPgn } = require('@canboat/canboatjs')
    const { addressClaim, productInfo } = identity({ uniqueNumber: 1851204, modelId: 'EV-1 Course Computer', softwareVersion: '1.0', serial: '1851204' })
    const parser = new FromPgn({})
    const claim = parser.parsePgnData({ pgn: 60928, src: 204, dst: 255, prio: 6 }, 8, Buffer.from(toPgn(addressClaim)), false)
    expect(claim.fields).toMatchObject({
      uniqueNumber: 1851204,
      manufacturerCode: 'Raymarine',
      deviceFunction: 150,
      deviceClass: 'Steering and Control surfaces',
      industryGroup: 'Marine Industry'
    })
    const pi = Buffer.from(toPgn(productInfo))
    const info = parser.parsePgnData({ pgn: 126996, src: 204, dst: 255, prio: 6 }, pi.length, pi, true)
    expect(info.fields.modelId).toBe('EV-1 Course Computer')
  })
})
