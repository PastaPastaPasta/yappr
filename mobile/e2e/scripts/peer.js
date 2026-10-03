// Calls the second persona (mobile/engine/harness/e2e-peer.ts, which run.sh
// starts on PEER_URL): the engine in Node, signed in as the peer persona.
//   PEER_OP=post    PEER_TEXT=<text>                     -> output.peerPostId
//   PEER_OP=delete  PEER_POST_ID=<id>
//   PEER_OP=answer  PEER_FROM=<identity> PEER_EXPECT=<text> PEER_REPLY=<text>
//                   (answers at once; the peer replies once `expect` arrives)
// Nothing secret passes through here.
const routes = {
  post: () => ['/post', { text: PEER_TEXT }],
  delete: () => ['/delete', { id: PEER_POST_ID }],
  answer: () => ['/dm/answer', { from: PEER_FROM, expect: PEER_EXPECT, reply: PEER_REPLY }],
};
const route = routes[PEER_OP];
if (!route) throw new Error(`Unknown PEER_OP ${PEER_OP}`);
const [path, body] = route();
const response = http.post(`${PEER_URL}${path}`, {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
if (response.status !== 200 && response.status !== 202) {
  throw new Error(`The peer answered ${response.status} to ${path}: ${response.body}`);
}
if (PEER_OP === 'post') output.peerPostId = JSON.parse(response.body).id;
