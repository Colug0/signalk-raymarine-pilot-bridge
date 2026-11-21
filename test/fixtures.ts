// Frames from two recordings:
// - EV1: canboat's sample samples/raymarine-ev1.raw (Apache-2.0,
//   github.com/canboat/canboat): an EV-1 course computer at address 204 and
//   its control head at address 0.
// - P70S: a Raymarine p70s (software 3.07) at address 4 on a B&G bus with no
//   Raymarine pilot, recorded with candump on 22 Nov 2026; only the head's
//   own frames, no position or vessel data.

export const EV1 = {
  // pilot → bus
  modeAuto: '2024-02-17T05:15:49.768Z,7,65379,204,255,8,3b,9f,40,00,00,00,02,ff',
  modeStandby: '2024-02-17T05:15:49.768Z,7,65379,204,255,8,3b,9f,00,00,00,00,02,ff',
  lockedHeading: '2024-02-17T05:15:49.768Z,7,65360,204,255,8,3b,9f,ff,ff,ff,bf,e4,ff',
  pilotHeading: '2024-02-17T05:15:49.768Z,7,65359,204,255,8,3b,9f,ff,ff,ff,3e,eb,ff',
  deviceId: '2024-02-17T05:15:49.768Z,7,126720,204,255,7,3b,9f,f0,81,90,10,05',
  modeDatagramEngaged: '2024-02-17T05:15:49.768Z,7,126720,204,255,9,3b,9f,f0,81,ae,02,01,0c,a5',
  modeDatagramStandby: '2024-02-17T05:15:49.768Z,7,126720,204,255,9,3b,9f,f0,81,ae,02,00,0c,a5',
  replyMaxDeviation: '2024-02-17T05:15:49.768Z,7,126720,204,0,13,3b,9f,6c,1a,50,de,01,de,01,de,01,ff,7f',
  replyLinearisation: '2024-02-17T05:15:49.768Z,7,126720,204,0,9,3b,9f,6c,23,50,64,64,64,00',
  ackMode: '2024-02-17T05:15:49.781Z,3,126208,204,0,8,02,63,ff,00,00,04,00,00',
  ackHeading: '2024-02-17T05:15:49.791Z,3,126208,204,0,8,02,50,ff,00,00,03,00,f0',
  // head → pilot
  cmdStandby: '2024-02-17T05:15:49.781Z,3,126208,0,204,17,01,63,ff,00,f8,04,01,3b,07,03,04,04,00,00,05,ff,ff',
  cmdAuto: '2024-02-17T05:15:49.781Z,3,126208,0,204,17,01,63,ff,00,f8,04,01,3b,07,03,04,04,40,00,05,ff,ff',
  cmdHeading1: '2024-02-17T05:15:49.791Z,3,126208,0,204,14,01,50,ff,00,f8,03,01,3b,07,03,04,06,c1,f2',
  cmdHeading2: '2024-02-17T05:15:49.798Z,3,126208,0,204,14,01,50,ff,00,f8,03,01,3b,07,03,04,06,61,f2',
  reqMaxDeviation:
    '2024-02-17T05:15:49.770Z,3,126208,0,204,21,00,00,ef,01,ff,ff,ff,ff,ff,ff,04,01,3b,07,03,04,04,6c,05,1a,50'
}

// "About System" request from the p70s to address 7, four CAN frames.
export const P70S_SYSTEM_REQUEST = [
  '(1795294593.735629) can0 0DED0704#C0160000EF01FFFF',
  '(1795294593.736205) can0 0DED0704#C1FFFFFFFF04013B',
  '(1795294593.736766) can0 0DED0704#C2070304045C0500',
  '(1795294593.737356) can0 0DED0704#C30000FFFFFFFFFF'
]
