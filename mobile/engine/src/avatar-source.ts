/**
 * Where the WebView engine gets the DiceBear styles: engine.avatars.js
 * (./sidecar.ts), handed to engine.js's stand-in for `@dicebear/collection`
 * (avatars/collection-shim.ts). boot() and profiles.avatarSvg wait for them.
 */
import { setAvatarStylesReady } from './avatar-styles'
import { installAvatarStyles } from './avatars/collection-shim'
import { loadSidecar } from './sidecar'

export const avatarStyles = loadSidecar('engine.avatars.js').then(installAvatarStyles)
setAvatarStylesReady(avatarStyles)
