const { execSync } = require('child_process')

// Get git info at build time
const getGitInfo = () => {
  try {
    const commitHash = execSync('git rev-parse --short HEAD').toString().trim()
    const commitDate = execSync('git log -1 --format=%ci').toString().trim()
    const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
    return { commitHash, commitDate, branch }
  } catch (e) {
    return { commitHash: 'unknown', commitDate: '', branch: 'unknown' }
  }
}

const gitInfo = getGitInfo()

// For deployments requiring a base path (e.g., username.github.io/repo)
// Set BASE_PATH=/yappr when needed, otherwise defaults to root
const basePath = process.env.BASE_PATH || ''

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath,
  assetPrefix: basePath,
  trailingSlash: true,
  generateBuildId: async () => gitInfo.commitHash,
  env: {
    NEXT_PUBLIC_GIT_COMMIT_HASH: gitInfo.commitHash,
    NEXT_PUBLIC_GIT_COMMIT_DATE: gitInfo.commitDate,
    NEXT_PUBLIC_GIT_BRANCH: gitInfo.branch,
  },
  reactStrictMode: true,
  output: 'export',
  images: {
    unoptimized: true,
    domains: ['images.unsplash.com'],
  },
  webpack: (config, { isServer }) => {
    // Note: The main evo-sdk is loaded from CDN using dynamic import with webpackIgnore.
    // This avoids bundling the large SDK while still allowing specialized WASM classes
    // (like IdentityPublicKeyInCreation) to be imported directly when needed.

    // Handle WASM files (required for @dashevo/wasm-sdk)
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    }

    return config
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://cdn.jsdelivr.net",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https: blob:",
              "font-src 'self'",
              "connect-src 'self' https: wss: https://44.240.98.102:1443",
              "worker-src 'self' blob:",
              "child-src 'self' blob:",
              "frame-src 'self' blob: https://www.youtube-nocookie.com"
            ].join('; ')
          },
          // CRITICAL: These headers are required for WASM to work
          // Using 'credentialless' instead of 'require-corp' to allow cross-origin images
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless'
          },
          {
            key: 'Cross-Origin-Opener-Policy', 
            value: 'same-origin'
          }
        ]
      }
    ]
  }
}

module.exports = nextConfig