// Answers the wallet request on screen as a sakura pool persona (PERSONA): the QR
// bridge (mobile/e2e/host/qr-bridge.mjs, BRIDGE_URL) reads the QR code off the device
// (release builds show the link only as a QR code) and hands it to the test-wallet
// responder, which publishes the login response (dash-key:) or signs and broadcasts
// the key registration (dash-st:).
//   KX         dash-key | dash-st: the request the flow is on
//   KEY_INDEX  optional: rotates the derived login key (the next login is a first one again)
// Sakura's quorum server lists only the newest quorums, so the responder can fail with
// "Quorum not found in cache" (and then "no available addresses") for a minute or two:
// the bridge then pauses before it answers 503 {retry: true} (Maestro's JavaScript has no
// timers), and this asks again, for about three minutes. Nothing secret passes through here.
if (KX !== 'dash-key' && KX !== 'dash-st') throw new Error(`KX must be dash-key or dash-st, not ${KX}`);
const request = { scheme: KX, persona: Number(PERSONA) };
if (typeof KEY_INDEX !== 'undefined' && KEY_INDEX !== '') request.keyIndex = Number(KEY_INDEX);

let response;
for (let attempt = 1; attempt <= 10; attempt++) {
  response = http.post(`${BRIDGE_URL}/respond`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (response.status !== 503) break;
}
if (response.status !== 200) throw new Error(`The wallet bridge answered ${response.status}: ${response.body}`);
output.responded = JSON.parse(response.body).kind;
