// The bridge's own place on the NMEA 2000 bus: a second SocketCAN channel
// with its own address claim, opened through the canboatjs that ships with
// the Signal K server. canboatjs pulls in native socketcan bindings, which a
// plugin cannot install itself (app-store installs skip install scripts), so
// the plugin borrows the server's copy. Approach and resolver after
// htool/signalk-navico-autopilot-bridge (MIT).

import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bus } from './bridge.js'
import { FastPacketAssembler, toActisense, type N2kMessage, type OutMessage, type RawFrame } from './n2k.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export function resolveCanboat(): any {
  // the plugin's own tree first, then the server's entry script
  const candidates = [import.meta.url, process.argv[1]].filter(Boolean) as string[]
  const errors: string[] = []
  for (const from of candidates) {
    try {
      return createRequire(from)('@canboat/canboatjs')
    } catch (e) {
      errors.push(`${from}: ${String(e)}`)
    }
  }
  throw new Error(`@canboat/canboatjs not found next to the plugin nor in the Signal K server (${errors.join('; ')})`)
}

export interface CanBusOptions {
  canInterface: string
  preferredAddress: number
  uniqueNumber: number
  modelId: string
  softwareVersion: string
  serial: string
  log: (msg: string) => void
  error: (msg: string) => void
}

// Address claim and product information as a Raymarine course computer.
export function identity(o: Pick<CanBusOptions, 'uniqueNumber' | 'modelId' | 'softwareVersion' | 'serial'>) {
  return {
    addressClaim: {
      pgn: 60928,
      dst: 255,
      prio: 6,
      fields: {
        uniqueNumber: o.uniqueNumber,
        manufacturerCode: 1851, // Raymarine
        deviceInstanceLower: 0,
        deviceInstanceUpper: 0,
        deviceFunction: 150, // Autopilot
        deviceClass: 40, // Steering and Control surfaces
        systemInstance: 0,
        industryGroup: 4, // Marine
        arbitraryAddressCapable: 1
      }
    },
    productInfo: {
      pgn: 126996,
      dst: 255,
      fields: {
        nmea2000Version: 2100,
        productCode: 1185,
        modelId: o.modelId,
        softwareVersionCode: o.softwareVersion,
        modelVersion: o.modelId,
        modelSerialCode: o.serial,
        certificationLevel: 1,
        loadEquivalency: 1
      }
    }
  }
}

export class CanBus implements Bus {
  private canbus: any
  private readonly emitter = new EventEmitter()
  private readonly assembler = new FastPacketAssembler()
  private parser: any
  private claimed = false

  constructor(
    private readonly opts: CanBusOptions,
    private readonly onMessage: (msg: N2kMessage) => void
  ) {}

  start(): void {
    const canboat = resolveCanboat()
    const Canbus = canboat.canbus
    this.parser = new canboat.FromPgn({})
    const app: any = this.emitter
    app.setProviderStatus = (_id: unknown, msg: string) => this.opts.log(`canbus: ${msg}`)
    app.setProviderError = (_id: unknown, msg: string) => this.opts.error(`canbus: ${msg}`)
    this.emitter.on('nmea2000OutAvailable', () => {
      this.claimed = true
      this.opts.log(`address claimed: ${this.address()}`)
    })
    const { addressClaim, productInfo } = identity(this.opts)
    this.canbus = new Canbus({
      canDevice: this.opts.canInterface,
      app,
      providerId: 'raymarine-pilot-bridge',
      addressClaim,
      productInfo,
      preferredAddress: this.opts.preferredAddress,
      uniqueNumber: this.opts.uniqueNumber,
      // canboatjs answers every group function with "not supported"
      // unless told not to; the bridge answers them itself.
      disableNAKs: true,
      transmitPGNs: [126208, 126720, 65288, 65345, 65359, 65360, 65379]
    })
    this.canbus.on('data', (raw: any) => this.frame(raw))
  }

  private frame(raw: any): void {
    const frame: RawFrame = {
      pgn: raw.pgn.pgn,
      src: raw.pgn.src,
      dst: raw.pgn.dst,
      prio: raw.pgn.prio,
      data: Uint8Array.from(raw.data)
    }
    // ISO requests and address claims go to canboatjs' device, which
    // answers them (claim, product info) and defends our address.
    if (frame.pgn === 59904 || frame.pgn === 60928) {
      try {
        const parsed = this.parser.parse({ pgn: raw.pgn, length: raw.length, data: raw.data })
        if (parsed) this.emitter.emit('N2KAnalyzerOut', parsed)
      } catch (e) {
        this.opts.error(`parse ${frame.pgn}: ${String(e)}`)
      }
      return
    }
    const msg = this.assembler.push(frame)
    if (msg) this.onMessage(msg)
  }

  address(): number | undefined {
    if (!this.claimed) return undefined
    return this.canbus?.candevice?.address
  }

  send(msg: OutMessage): void {
    this.canbus?.sendPGN(toActisense(msg))
  }

  stop(): void {
    try {
      this.canbus?.candevice?.stop?.()
      this.canbus?.channel?.stop?.()
      this.canbus?.end?.()
    } catch (e) {
      this.opts.error(`stop: ${String(e)}`)
    }
    this.canbus = undefined
    this.claimed = false
  }
}
