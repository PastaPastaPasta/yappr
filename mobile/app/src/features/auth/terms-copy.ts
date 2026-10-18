/** The legal and community-rules summary on the consent gate. */
export const TERMS_SUMMARY = [
  'You must be 18 or older to use Yappr.',
  'No harassment, hate, threats or illegal content. There is zero tolerance for abuse.',
  'Yappr is open-source software for Dash Platform. Its authors cannot change, remove or recover your data on the network.',
  'Yappr has no centralized moderation. On-chain teams are elected by the community through masternode votes and are independent of Yappr.',
  "Reported content can be removed by the community's moderators, and abusive accounts can be banned.",
  'You can block anyone, and report posts that break these rules.',
  'What you post is public and permanent on Dash Platform.',
] as const;

/**
 * The full community rules, drafted from COMPLIANCE.md (UGC section) for
 * mobile 1.0. Shown in the gate under "Community rules".
 */
export const COMMUNITY_RULES: readonly { title: string; body: string }[] = [
  {
    title: 'Zero tolerance for abuse',
    body:
      'Harassment, hate speech, threats of violence, doxxing, and content that sexualises minors are not allowed. ' +
      'Neither is content that is illegal where you live or that promotes self-harm. Accounts that post it can be banned.',
  },
  {
    title: 'Sensitive content',
    body:
      'Mark posts with nudity, gore or other graphic content as sensitive. Yappr hides sensitive posts until each viewer chooses to see them.',
  },
  {
    title: 'Spam and impersonation',
    body:
      'Do not post spam, scams or misleading links, and do not pretend to be another person or organisation.',
  },
  {
    title: 'Reports and moderation',
    body:
      "Use Report where available to publish an on-chain report. Independent teams, elected by the community through masternode votes, can remove content and suspend or ban accounts under their charters. " +
      'Reports are public documents signed by the reporter. General questions: support@dash.org. Email does not file an on-chain report or guarantee moderator action. If a child is in danger, contact your local police.',
  },
  {
    title: 'Media in the app',
    body: 'The Yappr app may not display some media. Web and mobile builds include a media denylist maintained in the source repository. It does not remove media from Dash Platform, IPFS or other websites.',
  },
  {
    title: 'Blocking',
    body: 'You can block anyone. Their posts, replies, mentions and messages stop reaching you.',
  },
  {
    title: 'Your content is public and permanent',
    body:
      'Posts, replies, likes and follows are documents on Dash Platform. Anyone can read them, and deleting a post may leave a trace on the network.',
  },
];
