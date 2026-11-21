// Raymarine (SeaTalkNG) pilot messages, built and read byte for byte.
// Every layout here is checked against a recording of a real EV-1 course
// computer and its control head (canboat sample raymarine-ev1.raw) in the
// tests.

import type { OutMessage } from './n2k.js'

// Manufacturer 1851 (Raymarine), reserved bits set, industry 4 (marine).
export const RAYMARINE = [0x3b, 0x9f] as const

export const PGN = {
  groupFunction: 126208,
  seatalk: 126720,
  pilotMode: 65379,
  pilotHeading: 65359,
  lockedHeading: 65360,
  windDatum: 65345,
  alarm: 65288
} as const

// Pilot mode word of PGN 65379 (canboat SEATALK_PILOT_MODE_16).
export const PilotMode = {
  standby: 0x0000,
  auto: 0x0040,
  wind: 0x0100,
  track: 0x0180,
  trackEngaged: 0x0181,
  unchanged: 0xffff
} as const

export const SUBMODE_TACK = 4

const ANGLE_NA = 0xffff

// Unsigned angle in 0.0001 rad, 0xffff when unknown.
export function encodeAngle(rad: number | undefined | null): number {
  if (rad === undefined || rad === null || !Number.isFinite(rad)) return ANGLE_NA
  const twoPi = 2 * Math.PI
  const v = Math.round((((rad % twoPi) + twoPi) % twoPi) * 10000)
  return v >= 62832 ? 0 : v
}

export function decodeAngle(v: number): number | undefined {
  return v === ANGLE_NA ? undefined : v / 10000
}

const lo = (v: number): number => v & 0xff
const hi = (v: number): number => (v >> 8) & 0xff

export function pilotModeMessage(mode: number, subMode = 0, data = 2): OutMessage {
  return {
    pgn: PGN.pilotMode,
    dst: 255,
    prio: 7,
    data: [...RAYMARINE, lo(mode), hi(mode), lo(subMode), hi(subMode), data, 0xff]
  }
}

// The EV-1 fills only the magnetic field; true stays unknown.
export function pilotHeadingMessage(magnetic: number | undefined, trueHeading?: number): OutMessage {
  const t = encodeAngle(trueHeading)
  const m = encodeAngle(magnetic)
  return { pgn: PGN.pilotHeading, dst: 255, prio: 7, data: [...RAYMARINE, 0xff, lo(t), hi(t), lo(m), hi(m), 0xff] }
}

export function lockedHeadingMessage(magnetic: number | undefined, trueHeading?: number): OutMessage {
  const t = encodeAngle(trueHeading)
  const m = encodeAngle(magnetic)
  return { pgn: PGN.lockedHeading, dst: 255, prio: 7, data: [...RAYMARINE, 0xff, lo(t), hi(t), lo(m), hi(m), 0xff] }
}

// Locked wind angle and its rolling average, unsigned: a port angle goes out
// as its starboard equivalent, −30° as 330°.
export function windDatumMessage(datum: number | undefined, rollingAverage: number | undefined): OutMessage {
  const d = encodeAngle(datum)
  const r = encodeAngle(rollingAverage)
  return { pgn: PGN.windDatum, dst: 255, prio: 7, data: [...RAYMARINE, lo(d), hi(d), lo(r), hi(r), 0xff, 0xff] }
}

// SeaTalk1 keystroke (126720 f0 81 86): key code and its inverse.
export function decodeKeystroke(data: Uint8Array): number | undefined {
  if (data.length < 8) return undefined
  if (data[0] !== RAYMARINE[0] || data[2] !== 0xf0 || data[3] !== 0x81 || data[4] !== 0x86) return undefined
  const key = data[6]
  return (key ^ data[7]) === 0xff ? key : undefined
}

// SeaTalk1 "device identification", device 5 = course computer.
export function deviceIdentificationMessage(): OutMessage {
  return { pgn: PGN.seatalk, dst: 255, prio: 7, data: [...RAYMARINE, 0xf0, 0x81, 0x90, 0x10, 0x05] }
}

// SeaTalk1 datagram 0xAE as the EV-1 sends it next to 65379: the fourth byte
// is 01 while engaged and 00 in standby in the recording. Its meaning is
// otherwise unknown, so it is sent only when enabled.
export function seatalkModeDatagram(engaged: boolean): OutMessage {
  return {
    pgn: PGN.seatalk,
    dst: 255,
    prio: 7,
    data: [...RAYMARINE, 0xf0, 0x81, 0xae, 0x02, engaged ? 0x01 : 0x00, 0x0c, 0xa5]
  }
}

// Answers to "Pilot Configuration" requests (126720, proprietary id 0x6c),
// as the EV-1 answered its control head in the recording.
const PILOT_CONFIGURATION: Record<number, number[]> = {
  // Max Compass Deviation
  0x1a: [0x1a, 0x50, 0xde, 0x01, 0xde, 0x01, 0xde, 0x01, 0xff, 0x7f],
  // Compass Linearisation Progress
  0x23: [0x23, 0x50, 0x64, 0x64, 0x64, 0x00]
}

export function pilotConfigurationReply(command: number, dst: number): OutMessage | undefined {
  const body = PILOT_CONFIGURATION[command]
  if (!body) return undefined
  return { pgn: PGN.seatalk, dst, prio: 7, data: [...RAYMARINE, 0x6c, ...body] }
}

// ---- Group function (PGN 126208) ----

export const FunctionCode = { request: 0, command: 1, acknowledge: 2 } as const

export const PgnErrorCode = {
  acknowledge: 0,
  pgnNotSupported: 1,
  pgnNotAvailable: 2,
  accessDenied: 3,
  notSupported: 4
} as const

// Size in bytes of each field of the target PGN, by canboat field order, as
// it is carried in a group function. Field 1 (manufacturer) takes two bytes,
// field 3 (industry) one.
const FIELD_SIZES: Record<number, Record<number, number>> = {
  [PGN.pilotMode]: { 1: 2, 3: 1, 4: 2, 5: 2, 6: 1 },
  [PGN.lockedHeading]: { 1: 2, 3: 1, 4: 1, 5: 2, 6: 2 },
  [PGN.windDatum]: { 1: 2, 3: 1, 4: 2, 5: 2 },
  [PGN.pilotHeading]: { 1: 2, 3: 1, 4: 1, 5: 2, 6: 2 },
  // proprietary id one byte; field 5 (command and data) takes the rest
  [PGN.seatalk]: { 1: 2, 3: 1, 4: 1 }
}

export interface GroupFunction {
  functionCode: number
  pgn: number
  params: Map<number, number[]>
  // a parameter with an unknown size ends parsing; the rest stays here
  rest: number[]
}

export function decodeGroupFunction(data: Uint8Array): GroupFunction | undefined {
  if (data.length < 4) return undefined
  const functionCode = data[0]
  const pgn = data[1] | (data[2] << 8) | (data[3] << 16)
  let i: number
  if (functionCode === FunctionCode.command) {
    i = 5
  } else if (functionCode === FunctionCode.request) {
    i = 10
  } else {
    return { functionCode, pgn, params: new Map(), rest: Array.from(data.subarray(4)) }
  }
  if (data.length <= i) return undefined
  const count = data[i++]
  const sizes = FIELD_SIZES[pgn] ?? {}
  const params = new Map<number, number[]>()
  for (let n = 0; n < count && i < data.length; n++) {
    const field = data[i++]
    const size = sizes[field]
    if (size === undefined) {
      params.set(field, Array.from(data.subarray(i)))
      return { functionCode, pgn, params, rest: [] }
    }
    params.set(field, Array.from(data.subarray(i, i + size)))
    i += size
  }
  return { functionCode, pgn, params, rest: Array.from(data.subarray(i)) }
}

export function u16(bytes: number[] | undefined): number | undefined {
  if (!bytes || bytes.length < 2) return undefined
  return bytes[0] | (bytes[1] << 8)
}

export function isRaymarine(gf: GroupFunction): boolean {
  const m = gf.params.get(1)
  return !!m && m[0] === RAYMARINE[0] && (m[1] & 0x07) === (RAYMARINE[1] & 0x07)
}

// Acknowledge as the EV-1 does: one nibble per parameter, all zero, the
// unused nibble of an odd count set to 0xf.
export function acknowledgeMessage(
  dst: number,
  pgn: number,
  parameterCount: number,
  pgnErrorCode: number = PgnErrorCode.acknowledge,
  parameterError = 0
): OutMessage {
  const nibbles: number[] = []
  for (let n = 0; n < parameterCount; n++) nibbles.push(parameterError & 0x0f)
  if (nibbles.length % 2 === 1) nibbles.push(0x0f)
  const params: number[] = []
  for (let n = 0; n < nibbles.length; n += 2) params.push(nibbles[n] | (nibbles[n + 1] << 4))
  return {
    pgn: PGN.groupFunction,
    dst,
    prio: 3,
    data: [FunctionCode.acknowledge, lo(pgn), hi(pgn), (pgn >> 16) & 0xff, pgnErrorCode & 0x0f, parameterCount, ...params]
  }
}
