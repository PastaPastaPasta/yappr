import type { PostDTO, ProfileDTO, UserSummaryDTO } from '@engine/api';

import { filterBookmarks, stillBookmarked } from './bookmarks-filter';
import { filterUsers } from './connections-search';
import {
  avatarChoiceOf,
  avatarDtoOf,
  formFromProfile,
  isMediaUrl,
  patchOf,
  randomSeed,
  validateForm,
} from './edit-profile-form';
import {
  initialTab,
  joinedLabel,
  looksLikeIdentityId,
  looksLikeName,
  profileTabs,
  profileWebUrl,
  websiteLabel,
  websiteUrl,
} from './profile-format';

const ID = 'as7CNcWaqWqJND2pxfnKjc6da6AhWVpsXGR92yraATc';

const profile = (overrides: Partial<ProfileDTO> = {}): ProfileDTO => ({
  id: ID,
  username: 'jana',
  usernames: ['jana'],
  displayName: 'Jana Abara',
  avatar: { uri: null, dicebear: { style: 'thumbs', seed: ID } },
  hasProfile: true,
  stats: { posts: 3, followers: 3, following: 7 },
  ...overrides,
});

const DEV_LIMITS = { profileLimits: { displayName: 25, bio: 140 }, dashpayProfile: true };
const V2_LIMITS = { profileLimits: { displayName: 50, bio: 160 }, dashpayProfile: false };

describe('profile-format', () => {
  it('says when the user joined', () => {
    expect(joinedLabel(new Date(2026, 8, 14))).toBe('Joined Sep 2026');
    expect(joinedLabel(undefined)).toBeNull();
    expect(joinedLabel('not a date')).toBeNull();
  });

  it('links websites over http(s) only, and shows them without the scheme', () => {
    expect(websiteUrl('bob.dev')).toBe('https://bob.dev');
    expect(websiteUrl('http://bob.dev/a')).toBe('http://bob.dev/a');
    expect(websiteUrl('javascript:alert(1)')).toBeNull();
    expect(websiteUrl('  ')).toBeNull();
    expect(websiteLabel('https://www.bob.dev/')).toBe('bob.dev');
  });

  it('shares the yap.pr profile link for this variant', () => {
    expect(profileWebUrl(ID)).toBe(`https://yap.pr/devnet/user?id=${ID}`);
  });

  it('offers Top only where likes are ranked, and honours ?tab=', () => {
    expect(profileTabs({ rankings: false }).map((t) => t.label)).toEqual(['Posts', 'Replies', 'Mentions']);
    const tabs = profileTabs({ rankings: true });
    expect(tabs.map((t) => t.label)).toEqual(['Posts', 'Replies', 'Top', 'Mentions']);
    expect(initialTab('mentions', tabs)).toBe('mentions');
    expect(initialTab('top', profileTabs(null))).toBe('posts');
    expect(initialTab(undefined, tabs)).toBe('posts');
  });

  it('tells identity ids from names, and rejects anything else', () => {
    expect(looksLikeIdentityId(ID)).toBe(true);
    expect(looksLikeIdentityId('abc123')).toBe(false);
    expect(looksLikeName('@emil1987')).toBe(true);
    expect(looksLikeName('alice.dash')).toBe(true);
    expect(looksLikeName('a b')).toBe(false);
    expect(looksLikeName('../etc')).toBe(false);
  });
});

describe('edit-profile-form', () => {
  it('starts from the profile; without one, the name is the DPNS label', () => {
    expect(formFromProfile(profile({ bio: 'Hi', pronouns: 'she/her' }), 'thumbs')).toMatchObject({
      displayName: 'Jana Abara',
      bio: 'Hi',
      pronouns: 'she/her',
      avatar: null,
    });
    expect(formFromProfile(profile({ hasProfile: false, displayName: 'jana' }), 'thumbs').displayName).toBe('jana');
  });

  it('reads the default avatar as none, and anything else as a choice', () => {
    expect(avatarChoiceOf({ uri: null, dicebear: { style: 'thumbs', seed: ID } }, ID, 'thumbs')).toBeNull();
    expect(avatarChoiceOf({ uri: null, dicebear: { style: 'bottts', seed: 'x' } }, ID, 'thumbs')).toEqual({
      dicebear: { style: 'bottts', seed: 'x' },
    });
    expect(avatarChoiceOf({ uri: 'https://a/b.png', dicebear: null }, ID, 'thumbs')).toEqual({ uri: 'https://a/b.png' });
    expect(avatarDtoOf(null, ID, 'thumbs')).toEqual({ uri: null, dicebear: { style: 'thumbs', seed: ID } });
  });

  it('validates against the build’s limits', () => {
    const form = formFromProfile(profile(), 'thumbs');
    expect(validateForm(form, DEV_LIMITS)).toEqual({});
    expect(validateForm({ ...form, displayName: 'x'.repeat(26) }, DEV_LIMITS).displayName).toBe('At most 25 characters');
    expect(validateForm({ ...form, displayName: 'x'.repeat(26) }, V2_LIMITS)).toEqual({});
    // v2 requires a name; a blank DashPay name keeps the stored one.
    expect(validateForm({ ...form, displayName: ' ' }, V2_LIMITS).displayName).toBe('Name is required');
    expect(validateForm({ ...form, displayName: ' ' }, DEV_LIMITS)).toEqual({});
    expect(validateForm({ ...form, bannerUri: 'http://x/y.png' }, DEV_LIMITS).bannerUri).toBeDefined();
    expect(validateForm({ ...form, bannerUri: 'ipfs://bafy' }, DEV_LIMITS)).toEqual({});
    // Code points, not UTF-16 units: 25 emoji fit a 25-character name.
    expect(validateForm({ ...form, displayName: '😀'.repeat(25) }, DEV_LIMITS)).toEqual({});
  });

  it('patches only what changed; a first save sends what is filled', () => {
    const initial = formFromProfile(profile({ bio: 'Hi' }), 'thumbs');
    expect(patchOf(initial, initial, false)).toEqual({});
    expect(patchOf(initial, { ...initial, pronouns: ' she/her ', bio: '' }, false)).toEqual({ pronouns: 'she/her', bio: '' });
    expect(patchOf(initial, { ...initial, bannerUri: 'https://x/b.png', nsfw: true }, false)).toEqual({
      bannerUri: 'https://x/b.png',
      nsfw: true,
    });
    expect(patchOf({ ...initial, bannerUri: 'https://x/b.png' }, initial, false)).toEqual({ bannerUri: null });
    const avatar = { dicebear: { style: 'bottts', seed: 'x' } };
    expect(patchOf(initial, { ...initial, avatar }, false)).toEqual({ avatar });
    expect(patchOf(initial, initial, true)).toEqual({ displayName: 'Jana Abara', bio: 'Hi' });
  });

  it('accepts https and ipfs image links', () => {
    expect(isMediaUrl('https://example.com/a.png')).toBe(true);
    expect(isMediaUrl('ipfs://bafy123')).toBe(true);
    expect(isMediaUrl('http://example.com/a.png')).toBe(false);
    expect(isMediaUrl('data:image/png;base64,AA')).toBe(false);
  });

  it('randomizes seeds within the maximum length', () => {
    expect(randomSeed(100, () => 0)).toBe('aaaaaaaaaaaa');
    expect(randomSeed(5)).toMatch(/^[a-z0-9]{5}$/);
  });
});

describe('list filters', () => {
  const user = (id: string, username: string | null, displayName: string): UserSummaryDTO => ({
    id,
    username,
    displayName,
    avatar: { uri: null, dicebear: null },
    resolved: true,
  });
  const users = [user('1', 'emil1987', 'Emil Dubois'), user('2', 'carol9', 'Carol'), user('3', null, 'User abcdef')];

  it('filters followers by username prefix or name, from three characters', () => {
    expect(filterUsers(users, 'em')).toHaveLength(3);
    expect(filterUsers(users, '@emi').map((u) => u.id)).toEqual(['1']);
    expect(filterUsers(users, 'dubois').map((u) => u.id)).toEqual(['1']);
    expect(filterUsers(users, 'abcdef').map((u) => u.id)).toEqual(['3']);
    expect(filterUsers(users, 'zzz')).toEqual([]);
  });

  it('drops un-bookmarked posts and searches the rest', () => {
    const post = (id: string, content: string, bookmarked?: boolean) =>
      ({
        id,
        content,
        author: users[0],
        viewer: bookmarked === undefined ? undefined : { bookmarked },
      }) as unknown as PostDTO;
    const posts = [post('a', 'Film grain', true), post('b', 'Salt', false), post('c', 'Ceramics')];
    expect(posts.filter(stillBookmarked).map((p) => p.id)).toEqual(['a', 'c']);
    expect(filterBookmarks(posts, 'grain').map((p) => p.id)).toEqual(['a']);
    expect(filterBookmarks(posts, '@emil').map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(filterBookmarks(posts, '')).toHaveLength(3);
  });
});
