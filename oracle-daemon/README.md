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

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `DASH_CORE_HOST` | Dash Core RPC host (default: 127.0.0.1) |
| `DASH_CORE_PORT` | Dash Core RPC port (default: 9998) |
| `DASH_CORE_USERNAME` | RPC username |
| `DASH_CORE_PASSWORD` | RPC password |
| `PLATFORM_NETWORK` | Network: mainnet or testnet |
| `PLATFORM_IDENTITY_ID` | Oracle's Platform identity ID |
| `PLATFORM_PRIVATE_KEY` | Private key for signing state transitions (WIF format) |
| `GOVERNANCE_CONTRACT_ID` | Deployed governance contract ID |

### Optional Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNC_PROPOSAL_INTERVAL_MS` | Proposal sync interval | 300000 (5 min) |
| `SYNC_VOTE_INTERVAL_MS` | Vote sync interval | 300000 (5 min) |
| `SYNC_MASTERNODE_INTERVAL_MS` | MN sync interval | 3600000 (1 hour) |
| `HEALTH_PORT` | Health check server port | 8080 |
| `LOG_LEVEL` | Logging level | info |

## Platform Identity Setup

The oracle requires a Dash Platform identity with credits to publish documents.

### Creating an Oracle Identity (Testnet)

1. **Get testnet Dash**: Use the [Dash Testnet Faucet](https://testnet-faucet.dash.org/)

2. **Create an identity**: Use the Platform SDK or a tool like `dashmate`:
   ```bash
   # Using dashmate (if available)
   dashmate wallet:create-identity
   ```

3. **Top up credits**: Convert Dash to Platform credits:
   ```bash
   dashmate identity:topup <identity-id> <amount-in-dash>
   ```

4. **Export the private key**: The private key should be in WIF (Wallet Import Format)

### Creating an Oracle Identity (Mainnet)

For mainnet, you'll need real Dash. The process is similar:

1. Fund a wallet with Dash
2. Create an identity using the Platform SDK
3. Top up the identity with credits
4. Use the private key that controls the identity

### Credit Requirements

Each sync operation uses credits for state transitions:
- **Proposal sync**: ~0.0001 credits per proposal created/updated
- **Vote sync**: ~0.0001 credits per vote recorded
- **Masternode sync**: ~0.0001 credits per MN record

Estimate your credit needs based on:
- Number of active proposals (typically 10-50)
- Number of votes per proposal (can be 100s)
- Number of masternodes (currently ~3500)

**Recommendation**: Start with 1 DASH worth of credits for testnet testing.

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

### Using Docker Compose (Recommended)

This method starts both the oracle daemon and a Dash Core full node:

1. Create a `.env` file with your configuration:
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

2. Build and start:
   ```bash
   docker-compose up -d
   ```

3. Monitor logs:
   ```bash
   docker-compose logs -f governance-oracle
   ```

4. Check health:
   ```bash
   curl http://localhost:8080/health
   ```

**Note**: The Dash Core node will need to sync before the oracle can function. This can take several hours for testnet, or days for mainnet.

### Using External Dash Core Node

If you already have a Dash Core node running:

1. Configure `.env` to point to your existing node:
   ```bash
   DASH_CORE_HOST=your-dashd-host
   DASH_CORE_PORT=9998  # or 19998 for testnet
   ```

2. Comment out or remove the `dashd` service in `docker-compose.yml`

3. Start only the oracle:
   ```bash
   docker-compose up -d governance-oracle
   ```

### Manual Deployment (Without Docker)

1. Build the TypeScript:
   ```bash
   npm run build
   ```

2. Run:
   ```bash
   NODE_ENV=production node dist/index.js
   ```

### Testnet vs Mainnet

| Setting | Testnet | Mainnet |
|---------|---------|---------|
| `PLATFORM_NETWORK` | testnet | mainnet |
| `DASH_CORE_PORT` | 19998 | 9998 |
| Contract ID | Test contract | Production contract |
| Credits | Test credits (free) | Real credits (costs Dash) |

**Recommendation**: Always test thoroughly on testnet before deploying to mainnet.

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

**Cannot connect to Dash Core:**
- Ensure Dash Core is running and RPC is enabled
- Verify RPC credentials are correct
- Check firewall rules allow connection from the oracle
- For Docker: ensure services are on the same network

**Platform connection errors:**
- Verify network setting (testnet vs mainnet)
- Check that the identity exists and has credits
- Ensure the contract ID is correct

### Sync Issues

**No proposals appearing:**
- Check if Dash Core has governance objects: `dash-cli gobject list all`
- Verify the oracle has credits for state transitions
- Check logs for specific error messages

**Votes not syncing:**
- Votes only sync for active proposals
- Check if proposals exist first
- Verify the proposal hash format matches

### Credit Issues

**Out of credits error:**
- Top up the oracle identity with more credits
- Consider reducing sync frequency to conserve credits
- Monitor credit usage via Platform explorer

### Debug Mode

Enable verbose logging:
```bash
LOG_LEVEL=debug npm run dev
```

## Monitoring

For production deployments, consider:

1. **Health check monitoring**: Configure your monitoring system to poll `/health`
2. **Log aggregation**: Ship logs to a centralized logging service
3. **Alerting**: Alert on:
   - Health check failures
   - Sync errors
   - Low credit balance
   - High error rates

## License

MIT
