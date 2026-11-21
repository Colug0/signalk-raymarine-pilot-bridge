import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Type, type Static } from 'typebox'
import { Bridge, type Navigation } from './bridge.js'
import { CanBus } from './canbus.js'
import { AccessRequest, V2Pilot, type TokenStore } from './v2.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export const ConfigSchema = Type.Object({
  listenOnly: Type.Boolean({
    title: 'Listen only',
    description: 'Claim an address and log what the control head sends, but send nothing else.',
    default: true
  }),
  canInterface: Type.String({ title: 'CAN interface', default: 'can0' }),
  preferredAddress: Type.Number({
    title: 'Preferred NMEA 2000 address',
    description: 'Address the bridge claims as a Raymarine course computer (a real EV-1 uses 204).',
    default: 204,
    minimum: 0,
    maximum: 251
  }),
  uniqueNumber: Type.Number({
    title: 'Unique number (NAME)',
    description: 'Keep it fixed: control heads remember the pilot by its NAME.',
    default: 1851204,
    minimum: 0,
    maximum: 2097151
  }),
  targetReference: Type.Union([Type.Literal('true'), Type.Literal('magnetic')], {
    title: 'Heading target reported by the V2 pilot',
    description: 'A B&G NAC-3 reports a true target.',
    default: 'true'
  }),
  sendSeatalkModeDatagram: Type.Boolean({
    title: 'Send SeaTalk1 mode datagram (0xAE)',
    description: 'As a real EV-1 does next to the pilot mode.',
    default: true
  }),
  serverUrl: Type.String({
    title: 'Signal K server URL for the V2 API',
    description: 'Empty: this server on localhost.',
    default: ''
  })
})
export type Config = Static<typeof ConfigSchema>

function serverUrl(app: any, config: Config): string {
  if (config.serverUrl) return config.serverUrl.replace(/\/$/, '')
  const s = app.config?.settings ?? {}
  if (s.ssl) return `https://127.0.0.1:${s.sslport ?? 3443}`
  return `http://127.0.0.1:${s.port ?? process.env.PORT ?? 3000}`
}

function tokenStore(app: any): TokenStore {
  const file = join(app.getDataDirPath(), 'access.json')
  return {
    load() {
      try {
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return {}
      }
    },
    save(v) {
      try {
        writeFileSync(file, JSON.stringify(v))
      } catch (e) {
        app.error(`cannot save ${file}: ${String(e)}`)
      }
    }
  }
}

function navigation(app: any): Navigation {
  const num = (path: string): number | undefined => {
    const v = app.getSelfPath(path)
    return typeof v === 'number' ? v : undefined
  }
  return {
    headingTrue: () => num('navigation.headingTrue.value'),
    headingMagnetic: () => num('navigation.headingMagnetic.value'),
    variation: () => num('navigation.magneticVariation.value'),
    windAngleApparent: () => num('environment.wind.angleApparent.value')
  }
}

export default function plugin(app: any) {
  let bus: CanBus | undefined
  let bridge: Bridge | undefined
  let access: AccessRequest | undefined
  let statusTimer: NodeJS.Timeout | undefined
  let accessStatus = ''

  return {
    id: 'signalk-raymarine-pilot-bridge',
    name: 'Raymarine Pilot Bridge',
    description: 'Control the Signal K Autopilot V2 pilot from a Raymarine p70s',
    schema: () => ConfigSchema,

    start(config: Partial<Config>) {
      const c: Config = {
        listenOnly: true,
        canInterface: 'can0',
        preferredAddress: 204,
        uniqueNumber: 1851204,
        targetReference: 'true',
        sendSeatalkModeDatagram: true,
        serverUrl: '',
        ...config
      }
      const url = serverUrl(app, c)
      access = new AccessRequest(url, tokenStore(app), (m) => {
        accessStatus = m
        app.debug(m)
      })
      const pilot = new V2Pilot(url, () => access?.token())
      const log = (m: string) => app.debug(m)
      const error = (m: string) => app.error(m)
      bus = new CanBus(
        {
          canInterface: c.canInterface,
          preferredAddress: c.preferredAddress,
          uniqueNumber: c.uniqueNumber,
          modelId: 'EV-1 Course Computer',
          softwareVersion: '1.0',
          serial: String(c.uniqueNumber),
          log,
          error
        },
        (msg) => {
          if (c.listenOnly && msg.pgn === 126208) {
            app.debug(`rx ${msg.src}→${msg.dst} 126208 ${Buffer.from(msg.data).toString('hex')}`)
          }
          bridge?.handle(msg)
        }
      )
      bridge = new Bridge(bus, pilot, navigation(app), {
        targetReference: c.targetReference,
        sendSeatalkModeDatagram: c.sendSeatalkModeDatagram,
        listenOnly: c.listenOnly,
        log,
        error
      })
      try {
        bus.start()
      } catch (e) {
        app.setPluginError(String(e))
        return
      }
      access.start()
      bridge.start()
      statusTimer = setInterval(() => {
        const addr = bus?.address()
        const s = bridge?.currentStatus()
        const parts = [
          addr === undefined ? 'claiming address' : `address ${addr}`,
          c.listenOnly ? 'listen only' : 'active',
          s ? `pilot ${s.state ?? '?'}${s.engaged ? ' engaged' : ''}` : 'no V2 pilot',
          access?.token() ? 'token ok' : accessStatus || 'no token'
        ].filter(Boolean)
        app.setPluginStatus(parts.join(', '))
      }, 2000)
    },

    stop() {
      if (statusTimer) clearInterval(statusTimer)
      statusTimer = undefined
      bridge?.stop()
      access?.stop()
      bus?.stop()
      bridge = undefined
      access = undefined
      bus = undefined
    }
  }
}
