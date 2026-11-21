# signalk-raymarine-pilot-bridge

Control the Signal K Autopilot V2 pilot from a Raymarine p70s control head.

The plugin joins the NMEA 2000 bus as a second device that looks like a
Raymarine Evolution course computer (EV-1). It reports the pilot's mode,
heading and target to the control head, acknowledges the head's commands the
way an EV-1 does, and turns them into Autopilot V2 calls. Whatever V2 provider
steers the boat carries them out, for example
[signalk-autopilot](https://github.com/SignalK/signalk-autopilot) with a
B&G NAC-3.

**Status: experimental, stage 1.** Standby, Auto and ±1/±10 in Auto.
Wind mode is reported and can be selected; wind adjustments, No Drift, Track
and alarms are not done yet. Not yet tested with a real p70s.

## How it works

| Control head sends | Bridge does |
|---|---|
| 126208 Command → 65379 Standby | `POST …/autopilots/_default/disengage` |
| 126208 Command → 65379 Auto / Wind | `PUT …/state` `auto` / `wind` |
| 126208 Command → 65379 sub-mode 4 | `POST …/tack/{port,starboard}` (side from the apparent wind) |
| 126208 Command → 65360 new target | `PUT …/target/adjust` by the difference to the reported target |
| 126208 Request → 126720 Pilot Configuration | fixed answers as an EV-1 gives them |

It sends 65379 (pilot mode, 1 Hz), 65359 (heading) and 65360 (locked
heading, 5 Hz), 126720 device identification, and the claim and product
information of a Raymarine autopilot (manufacturer 1851, function 150,
class 40, "EV-1 Course Computer").

The control head sends a new target as an absolute magnetic heading. Many
V2 providers only take adjustments, so the bridge sends the difference to the
target it last reported. Heading and target go to the head as magnetic,
converted with `navigation.magneticVariation` when the provider reports a true
target.

## Requirements

- Signal K server on Linux with SocketCAN (`can0`); the bridge opens its own
  channel through the server's canboatjs and claims its own address.
- An Autopilot V2 provider.
- With security enabled the bridge needs write access: on first start it
  sends a device access request; approve it under *Security → Access Requests*.

## Settings

| Setting | Default | |
|---|---|---|
| Listen only | on | claim the address and log what the head sends, nothing else |
| CAN interface | `can0` | |
| Preferred address | 204 | as a real EV-1 |
| Unique number | 1851204 | keep it fixed |
| Heading target reported by the V2 pilot | true | a NAC-3 reports true |
| Send SeaTalk1 mode datagram | on | as the EV-1 does |
| Server URL | empty | this server on localhost |

## Credits

Approach for running a second NMEA 2000 device inside a Signal K plugin after
[htool/signalk-navico-autopilot-bridge](https://github.com/htool/signalk-navico-autopilot-bridge)
(MIT). Message layouts checked against canboat's EV-1 recording
(`samples/raymarine-ev1.raw`, Apache-2.0).

## License

MIT
