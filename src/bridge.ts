// The bridge itself: tells a Raymarine control head what the pilot is doing,
// and turns the head's commands into Autopilot V2 calls. It knows nothing of
// the bus or of HTTP; both come in through the interfaces below, so the whole
// logic runs in tests against recorded frames.

import type { N2kMessage, OutMessage } from './n2k.js'
import {
  PGN,
  PilotMode,
  SUBMODE_TACK,
  FunctionCode,
  PgnErrorCode,
  acknowledgeMessage,
  decodeAngle,
  decodeGroupFunction,
  decodeKeystroke,
  deviceIdentificationMessage,
  windDatumMessage,
  isRaymarine,
  lockedHeadingMessage,
  pilotConfigurationReply,
  pilotHeadingMessage,
  pilotModeMessage,
  seatalkModeDatagram,
  u16,
  type GroupFunction
} from './raymarine.js'

export interface Bus {
  send(msg: OutMessage): void
  // our own address once the claim is done, else undefined
  address(): number | undefined
}

// What the V2 API reports for the default pilot.
export interface PilotStatus {
  state: string | null
  engaged: boolean
  // radians; for a heading, true or magnetic as the provider reports it
  target: number | null
}

export interface Pilot {
  status(): Promise<PilotStatus | undefined>
  setState(state: string): Promise<void>
  disengage(): Promise<void>
  adjust(radians: number): Promise<void>
  tack(direction: 'port' | 'starboard'): Promise<void>
}

// Live boat data, read from the Signal K data model.
export interface Navigation {
  headingTrue(): number | undefined
  headingMagnetic(): number | undefined
  variation(): number | undefined
  windAngleApparent(): number | undefined
}

export interface BridgeOptions {
  // how the V2 provider reports a heading target
  targetReference: 'true' | 'magnetic'
  sendSeatalkModeDatagram: boolean
  // SEATALK_PILOT_HULL_TYPE reported to the head; a sailing hull gets Wind
  hullType?: number
  // receive and log only, send nothing but the address claim
  listenOnly: boolean
  log: (msg: string) => void
  error: (msg: string) => void
}

const HEADING_STATES = new Set(['auto', 'noDrift', 'route'])

const DEG = Math.PI / 180

export function wrapPi(rad: number): number {
  const twoPi = 2 * Math.PI
  let r = ((rad % twoPi) + twoPi) % twoPi
  if (r > Math.PI) r -= twoPi
  return r
}

// V2 state → Raymarine pilot mode word.
export function modeFor(status: PilotStatus | undefined): number {
  if (!status || !status.engaged) return PilotMode.standby
  switch (status.state) {
    case 'wind':
      return PilotMode.wind
    case 'route':
      return PilotMode.trackEngaged
    case 'auto':
    case 'noDrift':
      return PilotMode.auto
    default:
      return status.engaged ? PilotMode.auto : PilotMode.standby
  }
}

// The plugin's adjustTarget floors the degrees it is given, so a whole
// number of degrees goes out as n + 0.5: +3 → 3.5 → 3, −3 → −2.5 → −3.
export function adjustRadians(wholeDegrees: number): number {
  return (wholeDegrees + 0.5) * DEG
}

export class Bridge {
  private status: PilotStatus | undefined
  private reportedTargetMagnetic: number | undefined
  private reportedTargetWind: number | undefined
  private commanded: { kind: 'heading' | 'wind'; value: number; until: number } | undefined
  private timers: NodeJS.Timeout[] = []
  private polling = false

  constructor(
    private readonly bus: Bus,
    private readonly pilot: Pilot,
    private readonly nav: Navigation,
    private readonly opts: BridgeOptions
  ) {}

  start(): void {
    this.timers.push(setInterval(() => void this.poll(), 1000))
    this.timers.push(setInterval(() => this.sendStatus(), 1000))
    this.timers.push(setInterval(() => this.sendHeading(), 200))
    this.timers.push(setInterval(() => this.send(deviceIdentificationMessage()), 10000))
    void this.poll()
  }

  stop(): void {
    this.timers.forEach((t) => clearInterval(t))
    this.timers = []
  }

  currentStatus(): PilotStatus | undefined {
    return this.status
  }

  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      this.status = await this.pilot.status()
    } catch (e) {
      this.status = undefined
      this.opts.error(`V2 status: ${String(e)}`)
    } finally {
      this.polling = false
    }
  }

  private send(msg: OutMessage): void {
    if (this.opts.listenOnly) return
    if (this.bus.address() === undefined) return
    this.bus.send(msg)
  }

  sendStatus(): void {
    const mode = modeFor(this.status)
    this.send(pilotModeMessage(mode))
    if (this.opts.sendSeatalkModeDatagram) {
      this.send(seatalkModeDatagram(mode !== PilotMode.standby))
    }
  }

  // Target as the head should see it: magnetic, like the EV-1 reports it.
  targetMagnetic(): number | undefined {
    const s = this.status
    if (!s || !s.engaged || s.target === null || !HEADING_STATES.has(s.state ?? '')) return undefined
    if (this.opts.targetReference === 'magnetic') return s.target
    return s.target - (this.nav.variation() ?? 0)
  }

  headingMagnetic(): number | undefined {
    const m = this.nav.headingMagnetic()
    if (m !== undefined) return m
    const t = this.nav.headingTrue()
    return t === undefined ? undefined : t - (this.nav.variation() ?? 0)
  }

  // Signed apparent wind angle the pilot holds, as the V2 API reports it.
  targetWind(): number | undefined {
    const s = this.status
    if (!s || !s.engaged || s.state !== 'wind' || s.target === null) return undefined
    return s.target
  }

  // Until the pilot reports the new target (V2 polls once a second, the
  // pilot takes a moment too), keep showing what the head asked for.
  private held(kind: 'heading' | 'wind', now: number): number | undefined {
    const c = this.commanded
    return c && c.kind === kind && now < c.until ? c.value : undefined
  }

  sendHeading(now = Date.now()): void {
    this.send(pilotHeadingMessage(this.headingMagnetic()))
    const target = this.held('heading', now) ?? this.targetMagnetic()
    if (target !== undefined) {
      this.reportedTargetMagnetic = target
      this.send(lockedHeadingMessage(target))
    }
    const wind = this.held('wind', now) ?? this.targetWind()
    if (wind !== undefined) {
      this.reportedTargetWind = wind
      this.send(windDatumMessage(wind, this.nav.windAngleApparent()))
    }
  }

  // Entry point for every reassembled message from the bus.
  handle(msg: N2kMessage): void {
    if (msg.pgn === PGN.seatalk) {
      // Older heads send key presses; the p70s sends group functions. Only
      // logged until a recording shows a head that needs them.
      const key = decodeKeystroke(msg.data)
      if (key !== undefined) this.opts.log(`keystroke 0x${key.toString(16)} from ${msg.src} to ${msg.dst} (ignored)`)
      return
    }
    if (msg.pgn !== PGN.groupFunction) return
    const own = this.bus.address()
    if (own === undefined || msg.dst !== own) return
    const gf = decodeGroupFunction(msg.data)
    if (!gf) return
    if (gf.functionCode === FunctionCode.command) {
      this.handleCommand(msg.src, gf)
    } else if (gf.functionCode === FunctionCode.request) {
      this.handleRequest(msg.src, gf)
    }
  }

  private ack(src: number, gf: GroupFunction, code: number = PgnErrorCode.acknowledge): void {
    this.send(acknowledgeMessage(src, gf.pgn, gf.params.size, code))
  }

  private handleRequest(src: number, gf: GroupFunction): void {
    if (gf.pgn === PGN.seatalk && isRaymarine(gf)) {
      const prop = gf.params.get(4)?.[0]
      const command = gf.params.get(5)?.[0]
      if (prop === 0x6c && command !== undefined) {
        const reply = pilotConfigurationReply(command, src, this.opts.hullType)
        if (reply) {
          this.send(reply)
          return
        }
      }
      this.opts.log(`unanswered request from ${src}: 126720 prop ${prop?.toString(16)} cmd ${command?.toString(16)}`)
      return
    }
    this.opts.log(`unanswered request from ${src} for PGN ${gf.pgn}`)
  }

  private handleCommand(src: number, gf: GroupFunction): void {
    if (!isRaymarine(gf)) {
      this.ack(src, gf, PgnErrorCode.pgnNotSupported)
      return
    }
    if (!this.status) {
      this.opts.log(`command from ${src} for ${gf.pgn}, but no V2 pilot`)
      this.ack(src, gf, PgnErrorCode.pgnNotAvailable)
      return
    }
    switch (gf.pgn) {
      case PGN.pilotMode:
        return this.modeCommand(src, gf)
      case PGN.lockedHeading:
        return this.headingCommand(src, gf)
      case PGN.windDatum:
        return this.windCommand(src, gf)
      default:
        this.opts.log(`unsupported command from ${src} for ${gf.pgn}`)
        this.ack(src, gf, PgnErrorCode.pgnNotSupported)
    }
  }

  private run(what: string, action: () => Promise<void>): void {
    this.opts.log(what)
    action()
      .then(() => this.poll())
      .catch((e) => this.opts.error(`${what}: ${String(e)}`))
  }

  private modeCommand(src: number, gf: GroupFunction): void {
    const mode = u16(gf.params.get(4))
    const sub = u16(gf.params.get(5))
    if (mode === PilotMode.unchanged && sub === SUBMODE_TACK) {
      const awa = this.nav.windAngleApparent()
      if (awa === undefined) {
        this.ack(src, gf, PgnErrorCode.pgnNotAvailable)
        return
      }
      // wind from starboard (positive AWA): tack onto port, and back
      const direction = awa > 0 ? 'port' : 'starboard'
      this.ack(src, gf)
      this.run(`tack ${direction} (from ${src})`, () => this.pilot.tack(direction))
      return
    }
    switch (mode) {
      case PilotMode.standby:
        this.ack(src, gf)
        this.run(`standby (from ${src})`, () => this.pilot.disengage())
        return
      case PilotMode.auto:
        this.ack(src, gf)
        this.run(`auto (from ${src})`, () => this.pilot.setState('auto'))
        return
      case PilotMode.wind:
        this.ack(src, gf)
        this.run(`wind (from ${src})`, () => this.pilot.setState('wind'))
        return
      default:
        this.opts.log(`unsupported pilot mode 0x${mode?.toString(16)} sub ${sub} from ${src}`)
        this.ack(src, gf, PgnErrorCode.notSupported)
    }
  }

  // The head sends the new target as an absolute magnetic heading. The pilot
  // behind the V2 API may only take adjustments (the Simrad driver does), so
  // the difference to the target we last reported goes out as one.
  private headingCommand(src: number, gf: GroupFunction): void {
    const raw = u16(gf.params.get(6)) ?? u16(gf.params.get(5))
    const wanted = raw === undefined ? undefined : decodeAngle(raw)
    const current = this.reportedTargetMagnetic
    if (wanted === undefined || current === undefined || !HEADING_STATES.has(this.status?.state ?? '')) {
      this.ack(src, gf, PgnErrorCode.pgnNotAvailable)
      return
    }
    const degrees = Math.round(wrapPi(wanted - current) / DEG)
    this.ack(src, gf)
    if (degrees === 0) return
    // Report the new target at once, so a quick second key press counts
    // from it and not from the old one.
    this.reportedTargetMagnetic = wanted
    this.commanded = { kind: 'heading', value: wanted, until: Date.now() + 3000 }
    this.send(lockedHeadingMessage(wanted))
    this.run(`adjust ${degrees}° (from ${src})`, () => this.pilot.adjust(adjustRadians(degrees)))
  }

  // In wind mode the head sends the new wind angle, unsigned. Its change is
  // the change of the signed apparent wind angle. A V2 adjustment is "+ turns
  // the boat to starboard", and turning to starboard makes the signed angle
  // smaller (wind moves towards port), so the adjustment is the negative of
  // the change.
  private windCommand(src: number, gf: GroupFunction): void {
    const raw = u16(gf.params.get(4))
    const wanted = raw === undefined ? undefined : decodeAngle(raw)
    const current = this.reportedTargetWind
    if (wanted === undefined || current === undefined || this.status?.state !== 'wind') {
      this.ack(src, gf, PgnErrorCode.pgnNotAvailable)
      return
    }
    const degrees = Math.round(wrapPi(wanted - current) / DEG)
    this.ack(src, gf)
    if (degrees === 0) return
    const signed = wrapPi(wanted)
    this.reportedTargetWind = signed
    this.commanded = { kind: 'wind', value: signed, until: Date.now() + 3000 }
    this.send(windDatumMessage(signed, this.nav.windAngleApparent()))
    this.run(`wind ${degrees > 0 ? '+' : ''}${degrees}° → adjust ${-degrees}° (from ${src})`, () =>
      this.pilot.adjust(adjustRadians(-degrees))
    )
  }
}
