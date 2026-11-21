import { describe, expect, it, vi } from 'vitest'
import { Bridge, adjustRadians, modeFor, wrapPi, type Navigation, type Pilot, type PilotStatus } from '../src/bridge.js'
import { parseLogLine, type N2kMessage, type OutMessage } from '../src/n2k.js'
import { PGN, PgnErrorCode, PilotMode, decodeAngle, encodeAngle } from '../src/raymarine.js'
import { EV1 } from './fixtures.js'

const DEG = Math.PI / 180

function setup(status: PilotStatus | undefined, opts: { listenOnly?: boolean; variation?: number } = {}) {
  const sent: OutMessage[] = []
  const bus = { send: (m: OutMessage) => sent.push(m), address: () => 204 }
  const pilot: Pilot & { calls: string[] } = {
    calls: [],
    status: vi.fn(async () => status),
    setState: vi.fn(async (s: string) => void pilot.calls.push(`state ${s}`)),
    disengage: vi.fn(async () => void pilot.calls.push('disengage')),
    adjust: vi.fn(async (r: number) => void pilot.calls.push(`adjust ${Math.floor(r / DEG)}`)),
    tack: vi.fn(async (d: string) => void pilot.calls.push(`tack ${d}`))
  }
  const nav: Navigation = {
    headingTrue: () => 100 * DEG,
    headingMagnetic: () => undefined,
    variation: () => opts.variation,
    windAngleApparent: () => 40 * DEG
  }
  const bridge = new Bridge(bus, pilot, nav, {
    targetReference: 'true',
    sendSeatalkModeDatagram: true,
    listenOnly: opts.listenOnly ?? false,
    log: () => {},
    error: () => {}
  })
  return { bridge, sent, pilot }
}

function msg(line: string): N2kMessage {
  return parseLogLine(line)!.frame
}

// A target command as the head would send it for a given magnetic heading.
function headingCommand(rad: number): N2kMessage {
  const v = encodeAngle(rad)
  return {
    pgn: PGN.groupFunction,
    src: 4,
    dst: 204,
    prio: 3,
    data: Uint8Array.from([0x01, 0x50, 0xff, 0x00, 0xf8, 0x03, 0x01, 0x3b, 0x07, 0x03, 0x04, 0x06, v & 0xff, v >> 8])
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('mode mapping', () => {
  it('maps V2 states to Raymarine pilot modes', () => {
    expect(modeFor(undefined)).toBe(PilotMode.standby)
    expect(modeFor({ state: 'standby', engaged: false, target: null })).toBe(PilotMode.standby)
    expect(modeFor({ state: 'auto', engaged: true, target: 1 })).toBe(PilotMode.auto)
    expect(modeFor({ state: 'noDrift', engaged: true, target: 1 })).toBe(PilotMode.auto)
    expect(modeFor({ state: 'wind', engaged: true, target: 1 })).toBe(PilotMode.wind)
    expect(modeFor({ state: 'route', engaged: true, target: 1 })).toBe(PilotMode.trackEngaged)
  })
})

describe('adjustments', () => {
  it('survive the provider flooring the degrees', () => {
    for (const d of [1, -1, 10, -10, 3, -3]) {
      expect(Math.floor(adjustRadians(d) / DEG)).toBe(d)
    }
  })
  it('wrap differences across north', () => {
    expect(wrapPi(359 * DEG - 1 * DEG) / DEG).toBeCloseTo(-2)
    expect(wrapPi(1 * DEG - 359 * DEG) / DEG).toBeCloseTo(2)
  })
})

describe('commands from the head', () => {
  it('auto: acknowledges like the EV-1 and engages over V2', async () => {
    const { bridge, sent, pilot } = setup({ state: 'standby', engaged: false, target: null })
    await bridge.poll()
    bridge.handle({ ...msg(EV1.cmdAuto), src: 4 })
    await flush()
    expect(sent).toEqual([{ pgn: 126208, dst: 4, prio: 3, data: [0x02, 0x63, 0xff, 0x00, 0x00, 0x04, 0x00, 0x00] }])
    expect(pilot.calls).toEqual(['state auto'])
  })

  it('standby disengages', async () => {
    const { bridge, pilot } = setup({ state: 'auto', engaged: true, target: 1 })
    await bridge.poll()
    bridge.handle(msg(EV1.cmdStandby))
    await flush()
    expect(pilot.calls).toEqual(['disengage'])
  })

  it('ignores commands for other addresses', async () => {
    const { bridge, sent, pilot } = setup({ state: 'auto', engaged: true, target: 1 })
    await bridge.poll()
    bridge.handle({ ...msg(EV1.cmdStandby), dst: 7 })
    await flush()
    expect(sent).toEqual([])
    expect(pilot.calls).toEqual([])
  })

  it('without a V2 pilot it answers "PGN not available"', async () => {
    const { bridge, sent } = setup(undefined)
    await bridge.poll()
    bridge.handle(msg(EV1.cmdAuto))
    expect(sent[0].data[4]).toBe(PgnErrorCode.pgnNotAvailable)
  })

  it('a new target becomes an adjustment against the reported target', async () => {
    // true target 120°, variation +5° → the head sees 115° magnetic
    const { bridge, sent, pilot } = setup({ state: 'auto', engaged: true, target: 120 * DEG }, { variation: 5 * DEG })
    await bridge.poll()
    bridge.sendHeading()
    const locked = sent.find((m) => m.pgn === PGN.lockedHeading)!
    expect(decodeAngle(locked.data[5] | (locked.data[6] << 8))! / DEG).toBeCloseTo(115, 1)
    sent.length = 0
    bridge.handle(headingCommand(116 * DEG))
    await flush()
    expect(pilot.calls).toEqual(['adjust 1'])
    // a second +10 right after counts from 116, not from the old 115
    bridge.handle(headingCommand(126 * DEG))
    await flush()
    expect(pilot.calls).toEqual(['adjust 1', 'adjust 10'])
    bridge.handle(headingCommand(116 * DEG))
    await flush()
    expect(pilot.calls).toEqual(['adjust 1', 'adjust 10', 'adjust -10'])
  })

  it('adjusts across north the short way', async () => {
    const { bridge, pilot } = setup({ state: 'auto', engaged: true, target: 359 * DEG })
    await bridge.poll()
    bridge.sendHeading()
    bridge.handle(headingCommand(9 * DEG))
    await flush()
    expect(pilot.calls).toEqual(['adjust 10'])
  })

  it('a target command in standby is refused', async () => {
    const { bridge, sent, pilot } = setup({ state: 'standby', engaged: false, target: null })
    await bridge.poll()
    bridge.sendHeading()
    sent.length = 0
    bridge.handle(headingCommand(10 * DEG))
    await flush()
    expect(pilot.calls).toEqual([])
    expect(sent[0].data[4]).toBe(PgnErrorCode.pgnNotAvailable)
  })

  it('answers pilot configuration requests', async () => {
    const { bridge, sent } = setup({ state: 'standby', engaged: false, target: null })
    bridge.handle(msg(EV1.reqMaxDeviation))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ pgn: 126720, dst: 0 })
    expect(sent[0].data.slice(0, 4)).toEqual([0x3b, 0x9f, 0x6c, 0x1a])
  })
})

describe('status to the head', () => {
  it('sends mode and mode datagram', async () => {
    const { bridge, sent } = setup({ state: 'auto', engaged: true, target: 1 })
    await bridge.poll()
    bridge.sendStatus()
    expect(sent.map((m) => m.pgn)).toEqual([65379, 126720])
    expect(sent[0].data.slice(2, 4)).toEqual([0x40, 0x00])
  })

  it('listen only sends nothing', async () => {
    const { bridge, sent } = setup({ state: 'auto', engaged: true, target: 1 }, { listenOnly: true })
    await bridge.poll()
    bridge.sendStatus()
    bridge.sendHeading()
    bridge.handle(msg(EV1.cmdAuto))
    expect(sent).toEqual([])
  })
})
