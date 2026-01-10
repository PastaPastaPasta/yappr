/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  basePath: process.env.GITHUB_PAGES === 'true' ? '/yappr' : '',
  assetPrefix: process.env.GITHUB_PAGES === 'true' ? '/yappr/' : '',
  images: {
    unoptimized: true,
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

      // Browser fallbacks for Node.js built-in modules used by Helia/libp2p
      config.resolve.fallback = {
        ...config.resolve.fallback,
        stream: false,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        path: false,
        os: false,
        http: false,
        https: false,
        zlib: false,
      }

      // Alias node: prefixed imports to false (empty module)
      config.resolve.alias = {
        ...config.resolve.alias,
        'node:stream': false,
        'node:fs': false,
        'node:net': false,
        'node:tls': false,
        'node:crypto': false,
        'node:path': false,
        'node:os': false,
        'node:http': false,
        'node:https': false,
        'node:zlib': false,
        'node:buffer': false,
        'node:util': false,
        'node:url': false,
        'node:events': false,
      }
    }

    // Handle WASM files (required for @dashevo/evo-sdk)
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    }

    // Fix libp2p/helia compatibility issues with strict mode
    // These packages use "static name = 'ErrorName'" which conflicts with
    // the built-in read-only name property of classes
    config.module.rules.push({
      test: /[\\/]node_modules[\\/].*(@libp2p|@chainsafe|@helia|@multiformats|libp2p|helia|interface-store|abort-error|mortice|blockstore-|datastore-|it-queue|race-event|ipns)[\\/].*\.js$/,
      loader: 'string-replace-loader',
      options: {
        multiple: [
          {
            // Remove "static name = 'ErrorName'" declarations inside classes
            search: /static\s+name\s*=\s*['"][^'"]+['"];?/g,
            replace: '/* static name removed */',
          },
          {
            // Also handle the pattern: ClassName.name = 'ClassName'
            search: /(\w+Error)\.name\s*=\s*['"][^'"]+['"];?/g,
            replace: '/* $1.name removed */',
          },
        ],
      },
    })

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
              "img-src 'self' data: blob: https://api.dicebear.com",
              "font-src 'self'",
              "connect-src 'self' https: wss:",
              "worker-src 'self' blob:",
              "child-src 'self' blob:"
            ].join('; ')
          },
          // CRITICAL: These headers are required for WASM to work
          // Using 'credentialless' instead of 'require-corp' to allow cross-origin images (DiceBear avatars)
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