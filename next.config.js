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

/** @type {import('next').NextConfig} */
const nextConfig = {
  trailingSlash: true,
  env: {
    NEXT_PUBLIC_GIT_COMMIT_HASH: gitInfo.commitHash,
    NEXT_PUBLIC_GIT_COMMIT_DATE: gitInfo.commitDate,
    NEXT_PUBLIC_GIT_BRANCH: gitInfo.branch,
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  reactStrictMode: true,
  output: 'export',
  images: {
    unoptimized: true,
    domains: ['images.unsplash.com'],
  },
  webpack: (config, { isServer }) => {
    // Optimize EvoSDK bundle size
    if (!isServer) {
      config.optimization = {
        ...config.optimization,
        splitChunks: {
          chunks: 'all',
          cacheGroups: {
            dashevo: {
              test: /[\\/]node_modules[\\/]@dashevo[\\/]/,
              name: 'evo-sdk',
              priority: 10,
              reuseExistingChunk: true,
            },
          },
        },
      }
    }

    // Handle WASM files (required for @dashevo/evo-sdk)
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
              "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https: blob:",
              "font-src 'self'",
              "connect-src 'self' https: wss: https://44.240.98.102:1443",
              "worker-src 'self' blob:",
              "child-src 'self' blob:"
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