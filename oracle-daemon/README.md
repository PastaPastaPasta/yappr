# Yappr Governance Oracle Daemon

A Node.js service that bridges Dash Core and Dash Platform for the Yappr governance feature. It reads governance data (proposals, votes, masternode list) from a Dash Core full node and publishes it as documents on Dash Platform.

## Architecture

```
┌─────────────────┐
│   Dash Core     │ ← Full node with RPC enabled
└────────┬────────┘
         │ RPC: gobject list, masternode list, votes
         ▼
┌─────────────────┐
│  Oracle Daemon  │ ← This service
└────────┬────────┘
         │ State Transitions (creates/updates documents)
         ▼
┌─────────────────┐
│ Dash Platform   │ ← Documents store all governance data
└─────────────────┘
```

## Prerequisites

- Node.js 20+
- Access to a Dash Core full node with RPC enabled
- A Dash Platform identity with credits for state transitions
- The governance contract must be deployed on Platform

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required environment variables:

| Variable | Description |
|----------|-------------|
| `DASH_CORE_HOST` | Dash Core RPC host (default: 127.0.0.1) |
| `DASH_CORE_PORT` | Dash Core RPC port (default: 9998) |
| `DASH_CORE_USERNAME` | RPC username |
| `DASH_CORE_PASSWORD` | RPC password |
| `PLATFORM_NETWORK` | Network: mainnet or testnet |
| `PLATFORM_IDENTITY_ID` | Oracle's Platform identity ID |
| `PLATFORM_PRIVATE_KEY` | Private key for signing state transitions |
| `GOVERNANCE_CONTRACT_ID` | Deployed governance contract ID |

Optional configuration:

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNC_PROPOSAL_INTERVAL_MS` | Proposal sync interval | 300000 (5 min) |
| `SYNC_VOTE_INTERVAL_MS` | Vote sync interval | 300000 (5 min) |
| `SYNC_MASTERNODE_INTERVAL_MS` | MN sync interval | 3600000 (1 hour) |
| `HEALTH_PORT` | Health check server port | 8080 |
| `LOG_LEVEL` | Logging level | info |

## Development

```bash
# Run in development mode with ts-node
npm run dev

# Build TypeScript
npm run build

# Run built version
npm start

# Lint
npm run lint
```

## Production Deployment

### Using Docker Compose

1. Configure environment variables in a `.env` file or export them
2. Build and start:

```bash
docker-compose up -d
```

### Manual Deployment

1. Build the TypeScript:
```bash
npm run build
```

2. Run:
```bash
NODE_ENV=production node dist/index.js
```

## Health Check Endpoints

The daemon exposes health check endpoints:

- `GET /health` - Full health status (returns 200 if healthy/degraded, 503 if unhealthy)
- `GET /ready` - Readiness probe (returns 200 if ready, 503 if not)
- `GET /metrics` - Detailed metrics and task status

Example health response:
```json
{
  "status": "healthy",
  "timestamp": 1704067200000,
  "checks": {
    "dashCore": {
      "connected": true,
      "lastCheck": 1704067195000,
      "blockHeight": 1900000
    },
    "platform": {
      "connected": true,
      "lastCheck": 1704067195000
    },
    "lastSync": {
      "proposals": { "timestamp": 1704067190000, "success": true, "count": 15 },
      "votes": { "timestamp": 1704067190000, "success": true, "count": 230 },
      "masternodes": { "timestamp": 1704064800000, "success": true, "count": 3500 }
    }
  }
}
```

## Sync Behavior

### Proposal Sync
- Fetches all governance objects from Dash Core (`gobject list all`)
- Filters to type 1 (proposals)
- Calculates status (active/passed/failed/funded/expired)
- Creates/updates proposal documents on Platform
- Deletes proposals that no longer exist in Dash Core

### Vote Sync
- Only syncs votes for active proposals (optimization)
- Fetches votes via `gobject getcurrentvotes`
- Creates/updates vote documents on Platform

### Masternode Sync
- Fetches full masternode list (`masternode list json`)
- Creates/updates masternode records on Platform
- Tracks enabled/disabled status changes

## Document Types

The oracle manages these document types in the governance contract:

- `proposal` - Governance proposals from Dash Core
- `masternodeRecord` - Masternode registry
- `masternodeVote` - Official MN votes

User-created documents (`proposalClaim`) are managed by the frontend, not the oracle.

## Troubleshooting

### Connection Issues

- Ensure Dash Core is running and RPC is enabled
- Verify RPC credentials are correct
- Check firewall rules allow connection from the oracle

### Platform Issues

- Verify the identity has sufficient credits
- Check the contract ID is correct
- Ensure the private key matches the identity

### Sync Issues

- Check logs for specific error messages
- Verify the health endpoint shows connected status
- Increase log level to debug for more details

## License

MIT
