import { describe, expect, it } from 'vitest'
import { FastPacketAssembler, parseLogLine, toActisense, type N2kMessage } from '../src/n2k.js'
import {
  PGN,
  PilotMode,
  acknowledgeMessage,
  decodeAngle,
  decodeGroupFunction,
  deviceIdentificationMessage,
  encodeAngle,
  isRaymarine,
  lockedHeadingMessage,
  pilotConfigurationReply,
  pilotHeadingMessage,
  pilotModeMessage,
  seatalkModeDatagram,
  u16
} from '../src/raymarine.js'
import { EV1, P70S_SYSTEM_REQUEST } from './fixtures.js'

function msg(line: string): N2kMessage {
  const p = parseLogLine(line)
  if (!p) throw new Error(`bad line ${line}`)
  return p.frame
}

const bytes = (line: string): number[] => Array.from(msg(line).data)

describe('messages the EV-1 sends, byte for byte', () => {
  it('pilot mode', () => {
    expect(pilotModeMessage(PilotMode.auto).data).toEqual(bytes(EV1.modeAuto))
    expect(pilotModeMessage(PilotMode.standby).data).toEqual(bytes(EV1.modeStandby))
  })

  it('locked heading and pilot heading, magnetic only', () => {
    const locked = msg(EV1.lockedHeading).data
    const mag = decodeAngle(locked[5] | (locked[6] << 8))
    expect(lockedHeadingMessage(mag).data).toEqual(Array.from(locked))
    const heading = msg(EV1.pilotHeading).data
    expect(pilotHeadingMessage(decodeAngle(heading[5] | (heading[6] << 8))).data).toEqual(Array.from(heading))
  })

  it('SeaTalk1 device identification and mode datagram', () => {
    expect(deviceIdentificationMessage().data).toEqual(bytes(EV1.deviceId))
    expect(seatalkModeDatagram(true).data).toEqual(bytes(EV1.modeDatagramEngaged))
    expect(seatalkModeDatagram(false).data).toEqual(bytes(EV1.modeDatagramStandby))
  })

  it('pilot configuration replies', () => {
    expect(pilotConfigurationReply(0x1a, 0)?.data).toEqual(bytes(EV1.replyMaxDeviation))
    expect(pilotConfigurationReply(0x23, 0)?.data).toEqual(bytes(EV1.replyLinearisation))
    expect(pilotConfigurationReply(0x99, 0)).toBeUndefined()
  })

  it('acknowledgements for four and three parameters', () => {
    expect(acknowledgeMessage(0, PGN.pilotMode, 4).data).toEqual(bytes(EV1.ackMode))
    expect(acknowledgeMessage(0, PGN.lockedHeading, 3).data).toEqual(bytes(EV1.ackHeading))
  })
})

describe('angles', () => {
  it('wraps into 0…2π and keeps unknown as 0xffff', () => {
    expect(encodeAngle(-0.1)).toBe(Math.round((2 * Math.PI - 0.1) * 10000))
    expect(encodeAngle(undefined)).toBe(0xffff)
    expect(decodeAngle(0xffff)).toBeUndefined()
  })
})

describe('commands from the control head', () => {
  it('standby and auto', () => {
    const s = decodeGroupFunction(msg(EV1.cmdStandby).data)!
    expect(s.functionCode).toBe(1)
    expect(s.pgn).toBe(PGN.pilotMode)
    expect(isRaymarine(s)).toBe(true)
    expect(u16(s.params.get(4))).toBe(PilotMode.standby)
    expect(u16(s.params.get(5))).toBe(0xffff)
    expect(s.params.size).toBe(4)
    const a = decodeGroupFunction(msg(EV1.cmdAuto).data)!
    expect(u16(a.params.get(4))).toBe(PilotMode.auto)
  })

  it('a new target heading as an absolute magnetic angle', () => {
    const h = decodeGroupFunction(msg(EV1.cmdHeading1).data)!
    expect(h.pgn).toBe(PGN.lockedHeading)
    expect(h.params.size).toBe(3)
    expect(decodeAngle(u16(h.params.get(6))!)).toBeCloseTo(6.2145, 4)
  })

  it('pilot configuration request', () => {
    const r = decodeGroupFunction(msg(EV1.reqMaxDeviation).data)!
    expect(r.functionCode).toBe(0)
    expect(r.pgn).toBe(PGN.seatalk)
    expect(r.params.get(4)).toEqual([0x6c])
    expect(r.params.get(5)).toEqual([0x1a, 0x50])
  })

  it('reassembles the p70s "About System" request from candump frames', () => {
    const fp = new FastPacketAssembler()
    const out = P70S_SYSTEM_REQUEST.map((l) => fp.push(parseLogLine(l)!.frame)).filter(Boolean) as N2kMessage[]
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ pgn: 126208, src: 4, dst: 7, prio: 3 })
    expect(out[0].data.length).toBe(0x16)
    const r = decodeGroupFunction(out[0].data)!
    expect(r.functionCode).toBe(0)
    expect(r.pgn).toBe(PGN.seatalk)
    expect(r.params.get(4)).toEqual([0x5c])
  })
})

describe('Actisense text for canbus', () => {
  it('writes prio, pgn, dst, length and hex bytes', () => {
    const s = toActisense(pilotModeMessage(PilotMode.auto), new Date('2026-11-22T00:00:00Z'))
    expect(s).toBe('2026-11-22T00:00:00.000Z,7,65379,0,255,8,3b,9f,40,00,00,00,02,ff')
  })
})
