# signalk-raymarine-pilot-bridge

> [!WARNING]
> **Experimental.** This plugin is being tried out on one boat (Raymarine p70s
> software 3.07, B&G NAC-3 through signalk-autopilot). It sends on your
> NMEA 2000 bus as an autopilot course computer and lets the control head
> engage and steer your pilot. Test it at anchor first, keep another way to put
> the pilot in standby within reach, and expect behaviour to change between
> versions. Not tested under way yet.

Control the Signal K Autopilot V2 pilot from a Raymarine p70s control head.

The plugin joins the NMEA 2000 bus as a second device that looks like a
Raymarine Evolution course computer (EV-1). It reports the pilot's mode,
heading and target to the control head, acknowledges the head's commands the
way an EV-1 does, and turns them into Autopilot V2 calls. Whatever V2 provider
steers the boat carries them out, for example
[signalk-autopilot](https://github.com/SignalK/signalk-autopilot) with a
B&G NAC-3.

## What works

Tried at anchor with a p70s and a B&G NAC-3:

| | |
|---|---|
| Standby, Auto | yes |
| ±1 / ±10 in Auto | yes, the head shows the pilot's target |
| Wind: select from the mode menu, ±1 / ±10 | yes; which way +1 turns the boat follows the head, still to be checked under way |
| Tack (−1 and +1 together) | built, not tried |
| No Drift, Track, alarms | not done |

## How it works

| Control head sends | Bridge does |
|---|---|
| 126208 Command → 65379 Standby | `POST …/autopilots/_default/disengage` |
| 126208 Command → 65379 Auto / Wind | `PUT …/state` `auto` / `wind` |
| 126208 Command → 65379 sub-mode 4 | `POST …/tack/{port,starboard}` (side from the apparent wind) |
| 126208 Command → 65360 new target | `PUT …/target/adjust` by the difference to the reported target |
| 126208 Command → 65345 new wind angle | `PUT …/target/adjust` so that the pilot holds the angle the head asked for |
| 126208 Request → 126720 Pilot Configuration | answers as an EV-1 gives them (compass, hull type) |

It sends 65379 (pilot mode, 1 Hz), 65359 (heading), 65360 (locked heading)
and in wind mode 65345 (wind angle, 5 Hz), 126720 device identification, and
the claim and product information of a Raymarine autopilot (manufacturer 1851,
function 150, class 40, "EV-1 Course Computer").

The control head sends a new target as an absolute magnetic heading or wind
angle. Many V2 providers only take adjustments, so the bridge sends the
difference to the target it last reported. Heading and target go to the head
as magnetic, converted with `navigation.magneticVariation` when the provider
reports a true target; the p70s shows them as true again.

## Requirements

- Signal K server on Linux with SocketCAN (`can0`); the bridge opens its own
  channel through the server's canboatjs and claims its own address.
- An Autopilot V2 provider.
- With security enabled the bridge needs write access: on first start it
  sends a device access request; approve it under *Security → Access Requests*.
  If the token is later refused (expired or removed), it asks again.

## Settings

| Setting | Default | |
|---|---|---|
| Listen only | on | claim the address and log what the head sends, nothing else |
| CAN interface | `can0` | |
| Preferred address | 204 | as a real EV-1 |
| Unique number | 1851204 | keep it fixed |
| Heading target reported by the V2 pilot | true | a NAC-3 reports true |
| Send SeaTalk1 mode datagram | on | as the EV-1 does |
| Hull type | sail | the head offers Wind only for a sailing hull |
| Server URL | empty | this server on localhost |

## Credits

Approach for running a second NMEA 2000 device inside a Signal K plugin after
[htool/signalk-navico-autopilot-bridge](https://github.com/htool/signalk-navico-autopilot-bridge)
(MIT). Message layouts checked against canboat's EV-1 recording
(`samples/raymarine-ev1.raw`, Apache-2.0).

## License

MIT
