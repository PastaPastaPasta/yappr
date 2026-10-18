const { execSync } = require('child_process')
const path = require('path')
const { PHASE_PRODUCTION_BUILD } = require('next/constants')
const { assertReleaseConfig, storageScope } = require('./scripts/release-config.cjs')
const { sdkWasmAsset } = require('./scripts/sdk-wasm-asset.cjs')
const wasmAsset = sdkWasmAsset(__dirname)

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
    NEXT_PUBLIC_SDK_WASM_URL: `${basePath}/_next/${wasmAsset.name}`,
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_GIT_COMMIT_HASH: gitInfo.commitHash,
    NEXT_PUBLIC_GIT_COMMIT_DATE: gitInfo.commitDate,
    NEXT_PUBLIC_GIT_BRANCH: gitInfo.branch,
    // Subpath deployments share the origin with the root deployment, so
    // client-side storage keys are namespaced by the base path (lib/storage-scope.ts).
    // STORAGE_EPOCH stays blank until the registered release cut-over (D21).
    NEXT_PUBLIC_STORAGE_SCOPE: storageScope(basePath, process.env.STORAGE_EPOCH),
  },
  reactStrictMode: true,
  output: 'export',
  images: {
    unoptimized: true,
  },
  webpack: (config, { isServer, webpack }) => {
    // Keep Next's chunk splitting: merging every @dashevo module into one
    // chunk pulls the async WASM initializer into the eager class imports.
    // @dashevo/evo-sdk's published entry is a webpack bundle that inlines its own
    // copy of @dashevo/wasm-sdk (glue + gzip/base64 wasm). Resolve the unbundled
    // ESM build instead so evo-sdk and our direct wasm-sdk imports share one copy.
    config.resolve.alias = {
      ...config.resolve.alias,
      // Class-only imports need the shared glue, never the uncompressed inline initializer.
      '@dashevo/wasm-sdk$': path.resolve(__dirname, 'node_modules/@dashevo/wasm-sdk/dist/raw/wasm_sdk.no_url.js'),
      '@dashevo/wasm-sdk/compressed$': path.resolve(__dirname, 'lib/web-wasm-sdk.ts'),
      '@dashevo/evo-sdk$': path.resolve(__dirname, 'node_modules/@dashevo/evo-sdk/dist/sdk.js'),
    }
    if (!isServer) {
      config.plugins.push({
        apply(compiler) {
          compiler.hooks.thisCompilation.tap('SdkWasmAsset', compilation => {
            compilation.hooks.processAssets.tap(
              { name: 'SdkWasmAsset', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
              () => compilation.emitAsset(wasmAsset.name, new webpack.sources.RawSource(wasmAsset.bytes))
            )
          })
        }
      })
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
          // CSP is set via <meta> tag in app/layout.tsx so it works in static exports.
          // CRITICAL: These headers are required for WASM to work
          // Using 'credentialless' instead of 'require-corp' to allow cross-origin images
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ]
      }
    ]
  }
}

module.exports = (phase) => {
  // Next has loaded env files before evaluating this config. Keep the check
  // out of application module scope and out of next dev / lint / unit tests.
  if (phase === PHASE_PRODUCTION_BUILD) assertReleaseConfig(process.env)
  return nextConfig
}
