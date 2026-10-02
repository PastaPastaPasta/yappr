// Hands the wallet link on screen to the M3 test-wallet responder
// (mobile/tools/test-wallet-responder.mjs --serve), which answers it as a sakura
// pool persona: dash-key: publishes the login response, dash-st: signs and
// broadcasts the key registration. Release builds show the link only as a QR
// code, so the QR bridge (mobile/e2e/host/qr-bridge.mjs, BRIDGE_URL) reads it off
// the device's screen.
//   KX         dash-key | dash-st: the request the flow is on
//   KEY_INDEX  optional: rotates the derived login key (the next login is a first one again)
// Nothing secret passes through here.
if (KX !== 'dash-key' && KX !== 'dash-st') throw new Error(`KX must be dash-key or dash-st, not ${KX}`);
const read = http.get(`${BRIDGE_URL}/qr?scheme=${KX}`);
if (read.status !== 200) throw new Error(`The QR bridge answered ${read.status}: ${read.body}`);
const uri = JSON.parse(read.body).uri;
if (uri.indexOf(`${KX}:`) !== 0) throw new Error(`The QR code on screen is not a ${KX}: link`);

// Sakura's quorum server lists only the newest quorums, so a read can fail with
// "Quorum not found in cache" for a few seconds: try again (no timers in Maestro JS).
const TRANSIENT = /Quorum not found|no available addresses|timed? ?out|unavailable|ECONNRESET/i;
const wait = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy wait
  }
};

let response;
for (let attempt = 1; attempt <= 5; attempt++) {
  response = http.post(`${RESPONDER_URL}/respond`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      typeof KEY_INDEX !== 'undefined' && KEY_INDEX !== ''
        ? { uri: uri, persona: Number(PERSONA), keyIndex: Number(KEY_INDEX) }
        : { uri: uri, persona: Number(PERSONA) },
    ),
  });
  if (response.status === 200 || !TRANSIENT.test(response.body || '')) break;
  wait(4000);
}
if (response.status !== 200) throw new Error(`Responder answered ${response.status}: ${response.body}`);
output.responded = JSON.parse(response.body).kind;
