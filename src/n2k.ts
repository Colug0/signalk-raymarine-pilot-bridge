// Small, dependency-free NMEA 2000 helpers: the message shapes the bridge
// works with, fast-packet reassembly, and the Actisense text form that
// canboatjs' canbus sends verbatim. The bridge builds every Raymarine payload
// itself, byte for byte as a real EV-1 sends it, so it does not depend on how
// a given canboatjs version names or encodes these proprietary fields.

export interface N2kMessage {
  pgn: number
  src: number
  dst: number
  prio: number
  data: Uint8Array
}

export interface OutMessage {
  pgn: number
  dst: number
  prio: number
  data: number[]
}

export interface RawFrame {
  pgn: number
  src: number
  dst: number
  prio: number
  data: Uint8Array
}

// PGNs the bridge handles that span several CAN frames.
const FAST_PACKET = new Set([126208, 126720, 126996, 126464, 126998])

export function isFastPacket(pgn: number): boolean {
  return FAST_PACKET.has(pgn)
}

interface Pending {
  seq: number
  length: number
  next: number
  bytes: number[]
}

// Reassembles fast packets per source and PGN. Single-frame PGNs pass
// straight through. A frame out of order drops the packet in progress, as a
// real receiver does; the sender repeats whatever matters.
export class FastPacketAssembler {
  private pending = new Map<string, Pending>()

  push(frame: RawFrame): N2kMessage | undefined {
    if (!isFastPacket(frame.pgn)) {
      return { ...frame }
    }
    const d = frame.data
    if (d.length < 2) return undefined
    const key = `${frame.src}:${frame.pgn}:${frame.dst}`
    const seq = d[0] >> 5
    const index = d[0] & 0x1f
    if (index === 0) {
      const p: Pending = { seq, length: d[1], next: 1, bytes: Array.from(d.subarray(2)) }
      if (p.bytes.length >= p.length) {
        this.pending.delete(key)
        return this.done(frame, p)
      }
      this.pending.set(key, p)
      return undefined
    }
    const p = this.pending.get(key)
    if (!p || p.seq !== seq || p.next !== index) {
      this.pending.delete(key)
      return undefined
    }
    p.bytes.push(...d.subarray(1))
    p.next++
    if (p.bytes.length >= p.length) {
      this.pending.delete(key)
      return this.done(frame, p)
    }
    return undefined
  }

  private done(frame: RawFrame, p: Pending): N2kMessage {
    return {
      pgn: frame.pgn,
      src: frame.src,
      dst: frame.dst,
      prio: frame.prio,
      data: Uint8Array.from(p.bytes.slice(0, p.length))
    }
  }
}

const hex = (b: number): string => (b & 0xff).toString(16).padStart(2, '0')

// canboatjs' canbus replaces the source field with its own address.
export function toActisense(msg: OutMessage, now = new Date()): string {
  return [
    now.toISOString(),
    msg.prio,
    msg.pgn,
    0,
    msg.dst,
    msg.data.length,
    ...msg.data.map(hex)
  ].join(',')
}

// Parses one line of a candump -L log or of an Actisense text log into a raw
// frame (candump) or a whole message (Actisense). Used by tests and tools.
export function parseLogLine(line: string): { time: number; frame: RawFrame; whole: boolean } | undefined {
  const c = line.match(/^\((\d+\.\d+)\)\s+\S+\s+([0-9A-Fa-f]{8})#([0-9A-Fa-f]*)/)
  if (c) {
    const id = parseInt(c[2], 16)
    const prio = (id >> 26) & 0x7
    const dp = (id >> 24) & 0x1
    const pf = (id >> 16) & 0xff
    const ps = (id >> 8) & 0xff
    const src = id & 0xff
    let pgn: number
    let dst: number
    if (pf < 240) {
      pgn = (dp << 16) | (pf << 8)
      dst = ps
    } else {
      pgn = (dp << 16) | (pf << 8) | ps
      dst = 255
    }
    const bytes = c[3].match(/../g)?.map((h) => parseInt(h, 16)) ?? []
    return { time: Number(c[1]), frame: { pgn, src, dst, prio, data: Uint8Array.from(bytes) }, whole: false }
  }
  const f = line.split(',')
  if (f.length >= 6 && /^\d+$/.test(f[2])) {
    const bytes = f.slice(6).map((h) => parseInt(h, 16))
    return {
      time: Date.parse(f[0]) / 1000,
      frame: { prio: Number(f[1]), pgn: Number(f[2]), src: Number(f[3]), dst: Number(f[4]), data: Uint8Array.from(bytes) },
      whole: true
    }
  }
  return undefined
}
