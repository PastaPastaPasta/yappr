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
    const sharedCSPDirectives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "img-src 'self' data: https: blob:",
      "connect-src 'self' https: wss: https://44.240.98.102:1443",
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
    ]

    // CRITICAL: These headers are required for WASM to work
    // Using 'credentialless' instead of 'require-corp' to allow cross-origin images
    const sharedSecurityHeaders = [
      { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ]

    return [
      {
        // Blog pages: permissive CSP for arbitrary embeds and theme fonts
        source: '/blog',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              ...sharedCSPDirectives,
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "media-src 'self' https: blob:",
              "frame-src 'self' blob: https:",
            ].join('; ')
          },
          ...sharedSecurityHeaders,
        ]
      },
      {
        // Everything else: restrictive CSP (excludes /blog which has its own)
        source: '/:path((?!blog$).*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              ...sharedCSPDirectives,
              "style-src 'self' 'unsafe-inline'",
              "font-src 'self'",
              "frame-src 'self' blob: https://www.youtube-nocookie.com",
            ].join('; ')
          },
          ...sharedSecurityHeaders,
        ]
      }
    ]
  }
}

module.exports = nextConfig