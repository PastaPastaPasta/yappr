// Hands the wallet link on screen (maestro.copiedText) to the M3 test-wallet
// responder (mobile/tools/test-wallet-responder.mjs --serve), which answers it
// as a sakura pool persona: dash-key: publishes the login response, dash-st:
// signs and broadcasts the key registration. Nothing secret passes through here.
const uri = maestro.copiedText;
if (!/^dash-(key|st):/.test(uri || '')) throw new Error('No wallet link was copied from the screen');

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
    // KEY_INDEX (optional) rotates the derived login key, which makes the next login a first login again.
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
