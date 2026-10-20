import {
  canBookmark, canRepost, contentLimits, contractTakesReports, dashpayProfileExtension, deletesAreTombstones,
  followRankingsAvailable, hasFlatThreads, hashtagsAreInline, inlineTags, likesAreIndexOnly, mediaItemLimit, postsHaveLanguage,
  prefixRankingsAvailable, profilesAreReportable, reportShape, reportsAreResolved, repostsAreQuotes, windowedRankingsAvailable, yappIsLocked,
} from '@/lib/contract-topology'
import { dmIsV5, pollrHasEditableBallots, pollrIsConfigured, pollrIsV3 } from '@/lib/constants'
import { isAppConnectBuild } from '@/lib/app-connect/config'
import { reportFeeCredits } from '@/lib/reports'
import { avatarSeedMaxLength, profileTextLimits } from '@/lib/profile/v10-profile'
import { DICEBEAR_STYLES, DICEBEAR_STYLE_LABELS, DEFAULT_AVATAR_STYLE } from '@/lib/services/unified-profile-service'
import { IPFS_GATEWAYS } from '@/lib/utils/ipfs-gateway'
import type { CapabilitiesDTO } from '../api/dto'

/** The `engine.info()` fields RN renders from instead of evaluating lib (PRD additions to ENGINE §14). */
export interface PlatformInfoDTO {
  capabilities: CapabilitiesDTO
  /** Ordered fallbacks for ipfs:// media; `path`: `https://<domain>/ipfs/<cid>`, `subdomain`: `https://<cid>.ipfs.<domain>`. */
  ipfsGateways: { domain: string; format: 'path' | 'subdomain' }[]
  /** The DiceBear style picker: styles with labels, the default, and the seed's longest length. */
  avatarStyles: { styles: { id: string; label: string }[]; defaultStyle: string; seedMaxLength: number }
}

/** How polls take ballots (`CapabilitiesDTO.pollVoting`); v4's indexOnly ballots are read-only here. */
export function pollVoting(): CapabilitiesDTO['pollVoting'] {
  if (!pollrIsConfigured()) return null
  if (pollrHasEditableBallots()) return 'editable'
  return pollrIsV3() ? 'once' : null
}

export function platformInfo(): PlatformInfoDTO {
  const limits = contentLimits()
  const reportFee = reportFeeCredits()
  const tags = inlineTags()
  return {
    capabilities: {
      rankings: likesAreIndexOnly(),
      windowedRankings: windowedRankingsAvailable(),
      prefixRankings: prefixRankingsAvailable(),
      followRankings: followRankingsAvailable(),
      repostsAreQuotes: repostsAreQuotes(),
      repostable: { post: canRepost('post'), reply: canRepost('reply') },
      bookmarkable: { post: canBookmark('post'), reply: canBookmark('reply') },
      flatThreads: hasFlatThreads(),
      deletesAreTombstones: deletesAreTombstones(),
      reports: contractTakesReports(),
      reportsResolved: reportsAreResolved(),
      reportReasonMax: reportShape().maxReason,
      profileReports: profilesAreReportable(),
      reportFeeCredits: reportFee === null ? null : Number(reportFee),
      mediaItems: mediaItemLimit(),
      hashtagsInline: hashtagsAreInline(),
      tagsPerPost: tags?.isArray ? tags.max : null,
      postLanguage: postsHaveLanguage(),
      contentLimits: { chars: limits.maxLength, bytes: limits.maxBytes },
      profileLimits: { ...profileTextLimits() },
      dashpayProfile: dashpayProfileExtension() !== null,
      yappLocked: yappIsLocked(),
      dm: dmIsV5() ? 'v5' : 'legacy',
      walletSignIn: isAppConnectBuild() ? 'app-connect' : 'legacy',
      pollVoting: pollVoting(),
    },
    ipfsGateways: IPFS_GATEWAYS.map(({ domain, format }) => ({ domain, format })),
    avatarStyles: {
      styles: DICEBEAR_STYLES.map(id => ({ id, label: DICEBEAR_STYLE_LABELS[id] })),
      defaultStyle: DEFAULT_AVATAR_STYLE,
      seedMaxLength: avatarSeedMaxLength(),
    },
  }
}
