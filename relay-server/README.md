# Yappr Relay Server

A libp2p relay node for Yappr presence/typing features.

## Docker + Cloudflare Tunnel (Recommended)

### 1. Create a Cloudflare Tunnel

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com)
2. Networks -> Tunnels -> Create a tunnel
3. Name it `yappr-relay`
4. Copy the tunnel token

### 2. Configure the tunnel route

In the tunnel config, add a public hostname:
- Subdomain: `relay` (or whatever you want)
- Domain: `yourdomain.com`
- Service: `http://relay:8080`

### 3. Start the services

```bash
cd relay-server
cp .env.example .env
# Edit .env and paste your TUNNEL_TOKEN

docker compose up -d
```

### 4. Get the Peer ID

```bash
docker logs yappr-relay 2>&1 | grep "Peer ID"
```

### 5. Update your app

Add to `lib/services/pubsub-service.ts`:
```typescript
const bootstrapNodes = [
  '/dns4/relay.yourdomain.com/tcp/443/wss/p2p/YOUR_PEER_ID',
  // ... existing nodes
]
```

---

## Quick Start (without Docker)

```bash
cd relay-server
npm install
npm start
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | 8080 | WebSocket port (browsers connect here) |
| `TCP_PORT` | 9000 | TCP port (server-to-server) |
| `KEY_PATH` | ./relay-key.bin | Path to persistent identity key |

## Deploy Behind Cloudflare

1. Point DNS to your server (proxied through CF)
2. Run relay on port 8080
3. CF terminates TLS, forwards to ws://localhost:8080

Cloudflare settings:
- SSL: Full (or Flexible)
- WebSockets: Enabled (default)

## Systemd Service

```ini
# /etc/systemd/system/yappr-relay.service
[Unit]
Description=Yappr Relay Server
After=network.target

[Service]
Type=simple
User=yappr
WorkingDirectory=/opt/yappr-relay
ExecStart=/usr/bin/node relay.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable yappr-relay
sudo systemctl start yappr-relay
```

## Update App to Use Relay

In `lib/services/pubsub-service.ts`, add your relay to bootstrap nodes:

```typescript
const bootstrapNodes = [
  '/dns4/relay.yourdomain.com/tcp/443/wss/p2p/YOUR_PEER_ID',
  // ... existing nodes
]
```

The peer ID is printed when the relay starts.
