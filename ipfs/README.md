# Yappr IPFS Deployment

Deploy Yappr on IPFS with a simple docker-compose setup. This allows anyone to run their own IPFS-hosted instance of Yappr.

## Quick Start

```bash
# Clone the repository
git clone https://github.com/PastaPastaPasta/yappr.git
cd yappr/ipfs

# Start the containers
docker compose up -d --build

# Watch the logs to see build progress
docker logs -f yappr-publisher
```

The publisher will:
1. Wait for the IPFS daemon to be ready
2. Clone the repository and build the Next.js app
3. Pin the build output to IPFS
4. Publish to IPNS for a stable address
5. Poll for new commits every 5 minutes

## Access Your Instance

Once you see the "Published!" message in the logs, you can access Yappr via:

**Local gateway:**
```
http://localhost:8080/ipfs/<CID>/
http://localhost:8080/ipns/<IPNS-KEY>/
```

**Public gateways:**
```
https://ipfs.io/ipfs/<CID>/
https://dweb.link/ipfs/<CID>/
```

## Configuration

Edit environment variables in `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `REPO_URL` | `https://github.com/PastaPastaPasta/yappr.git` | Git repository to build |
| `BRANCH` | `master` | Branch to track |
| `BUILD_DIR_REL` | `out` | Build output directory |
| `IPNS_KEY` | `yappr-latest` | IPNS key name |
| `POLL_SECONDS` | `300` | Polling interval for new commits |

### Deploy Your Own Fork

```yaml
environment:
  REPO_URL: "https://github.com/YOUR_USERNAME/yappr.git"
  BRANCH: "main"
```

## Setting Up a Custom Domain (DNSLink)

To access Yappr via a custom domain:

1. Get your IPNS key ID from the publisher logs
2. Add a DNS TXT record:
   ```
   _dnslink.yappr.yourdomain.com  TXT  "dnslink=/ipns/<IPNS-KEY-ID>"
   ```
3. Access via any IPFS gateway that supports DNSLink:
   ```
   https://yappr.yourdomain.com.ipns.dweb.link/
   ```

Or run your own gateway and configure your web server to proxy to it.

## Architecture

```
docker-compose.yml
├── ipfs (kubo)
│   ├── Stores pinned content
│   ├── Serves gateway on :8080
│   └── API on :5001
│
└── publisher
    ├── Polls GitHub for changes
    ├── Builds Next.js app
    ├── Pins to IPFS
    └── Updates IPNS
```

## Ports

| Port | Service | Description |
|------|---------|-------------|
| 4001 | IPFS Swarm | P2P connections |
| 5001 | IPFS API | Internal API |
| 8080 | IPFS Gateway | HTTP access to content |

## Persistent Data

Data is stored in Docker volumes:
- `ipfs_data` - IPFS repository and keys
- `publisher_work` - Cloned repo and build cache

To reset everything:
```bash
docker compose down -v
```

## Troubleshooting

**Build fails:**
Check the publisher logs for errors:
```bash
docker logs yappr-publisher
```

**IPFS not connecting:**
Ensure port 4001 is accessible for swarm connections.

**Slow gateway access:**
The first access may be slow while content propagates through the IPFS network. Local gateway access (`localhost:8080`) will always be fast.
