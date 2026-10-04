import type { AvatarDTO, CapabilitiesDTO, ProfileDTO, ProfilePatchDTO, WriteTicket } from '@engine/api';

/**
 * The Edit profile form as plain data (PRD PROF-06 – PROF-08): its values
 * from a profile, its validation, and the patch `profiles.update` takes,
 * holding only what changed.
 */

/** The fields the engine does not bound by capability (web `app/user/page.tsx`). */
export const FIXED_LIMITS = { pronouns: 20, location: 50, website: 200, banner: 512 } as const;

export type AvatarChoice = { uri: string } | { dicebear: { style: string; seed: string } } | null;

export interface ProfileForm {
  displayName: string;
  bio: string;
  pronouns: string;
  location: string;
  website: string;
  bannerUri: string;
  nsfw: boolean;
  /** `null`: the identity's default avatar. */
  avatar: AvatarChoice;
}

export type FormLimits = Pick<CapabilitiesDTO, 'profileLimits' | 'dashpayProfile'>;

/** The stored avatar as a choice: the identity's own default counts as none. */
export function avatarChoiceOf(avatar: AvatarDTO, identityId: string, defaultStyle: string): AvatarChoice {
  if (avatar.uri) return { uri: avatar.uri };
  const recipe = avatar.dicebear;
  if (!recipe || (recipe.style === defaultStyle && recipe.seed === identityId)) return null;
  return { dicebear: { style: recipe.style, seed: recipe.seed } };
}

/** The choice as the engine's `AvatarDTO`, for the preview. */
export function avatarDtoOf(choice: AvatarChoice, identityId: string, defaultStyle: string): AvatarDTO {
  if (choice === null) return { uri: null, dicebear: { style: defaultStyle, seed: identityId } };
  if ('uri' in choice) return { uri: choice.uri, dicebear: null };
  return { uri: null, dicebear: choice.dicebear };
}

/**
 * The form's starting values. Without a profile document the name starts as
 * the DPNS label (what everyone sees today), and the first save creates the
 * profile (#605).
 */
export function formFromProfile(profile: ProfileDTO, defaultStyle: string): ProfileForm {
  return {
    displayName: profile.hasProfile ? profile.displayName : (profile.username ?? ''),
    bio: profile.bio ?? '',
    pronouns: profile.pronouns ?? '',
    location: profile.location ?? '',
    website: profile.website ?? '',
    bannerUri: profile.bannerUrl ?? '',
    nsfw: profile.nsfw === true,
    avatar: avatarChoiceOf(profile.avatar, profile.id, defaultStyle),
  };
}

/** Code points, as the engine and web count them (`characters` in the engine's handler kit). */
export function charCount(text: string): number {
  return Array.from(text).length;
}

const MEDIA_URL = /^(https:\/\/[^\s/?#]+\S*|ipfs:\/\/\S+)$/i;

/** An image link the engine accepts: https or ipfs (PRD PROF-08). */
export function isMediaUrl(value: string): boolean {
  return MEDIA_URL.test(value.trim());
}

export type FormErrors = Partial<Record<keyof ProfileForm, string>>;

/** Per-field errors; empty when the form can be saved. */
export function validateForm(form: ProfileForm, limits: FormLimits): FormErrors {
  const errors: FormErrors = {};
  const name = form.displayName.trim();
  // v2's profile requires a name (PRD PROF-06); a blank DashPay name keeps the stored one.
  if (!name && !limits.dashpayProfile) errors.displayName = 'Name is required';
  if (charCount(name) > limits.profileLimits.displayName) {
    errors.displayName = `At most ${limits.profileLimits.displayName} characters`;
  }
  if (charCount(form.bio.trim()) > limits.profileLimits.bio) errors.bio = `At most ${limits.profileLimits.bio} characters`;
  if (charCount(form.pronouns.trim()) > FIXED_LIMITS.pronouns) errors.pronouns = `At most ${FIXED_LIMITS.pronouns} characters`;
  if (charCount(form.location.trim()) > FIXED_LIMITS.location) errors.location = `At most ${FIXED_LIMITS.location} characters`;
  if (charCount(form.website.trim()) > FIXED_LIMITS.website) errors.website = `At most ${FIXED_LIMITS.website} characters`;
  const banner = form.bannerUri.trim();
  if (banner && !isMediaUrl(banner)) errors.bannerUri = 'Use an https:// or ipfs:// image link';
  else if (banner.length > FIXED_LIMITS.banner) errors.bannerUri = `At most ${FIXED_LIMITS.banner} characters`;
  return errors;
}

const TEXT_FIELDS = ['displayName', 'bio', 'pronouns', 'location', 'website'] as const;

const sameAvatar = (a: AvatarChoice, b: AvatarChoice) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The patch for `profiles.update`: only the fields that changed (all of the
 * filled ones when there is no profile yet, since the save creates it).
 * Empty when nothing would change.
 */
export function patchOf(initial: ProfileForm, form: ProfileForm, creating: boolean): ProfilePatchDTO {
  const patch: ProfilePatchDTO = {};
  for (const field of TEXT_FIELDS) {
    const next = form[field].trim();
    if (creating ? next !== '' : next !== initial[field].trim()) patch[field] = next;
  }
  const banner = form.bannerUri.trim();
  if (creating ? banner !== '' : banner !== initial.bannerUri.trim()) patch.bannerUri = banner || null;
  if (creating ? form.nsfw : form.nsfw !== initial.nsfw) patch.nsfw = form.nsfw;
  if (creating ? form.avatar !== null : !sameAvatar(form.avatar, initial.avatar)) patch.avatar = form.avatar;
  return patch;
}

export function isEmptyPatch(patch: ProfilePatchDTO): boolean {
  return Object.keys(patch).length === 0;
}

/** A random DiceBear seed ("Randomize"), within the seed's maximum length. */
export function randomSeed(maxLength: number, random: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const length = Math.max(1, Math.min(12, maxLength));
  let seed = '';
  for (let i = 0; i < length; i += 1) seed += alphabet[Math.floor(random() * alphabet.length)];
  return seed;
}

/**
 * The fields a dev save writes in its second document (the Yappr profile,
 * after the DashPay one), as the failure names them. Name, bio and an image
 * avatar go in the first; an avatar can land in either, so it is not named.
 */
const SECOND_DOCUMENT_FIELDS: readonly [keyof ProfilePatchDTO, string][] = [
  ['pronouns', 'pronouns'],
  ['location', 'location'],
  ['website', 'website'],
  ['bannerUri', 'banner'],
  ['nsfw', 'NSFW setting'],
];

/** Engine codes whose own copy says what to do (credits, YAPP): the partial-save wording never hides them. */
const OWN_COPY_CODES = new Set(['INSUFFICIENT_CREDITS', 'INSUFFICIENT_YAPP']);

/** "pronouns", "pronouns and website", "pronouns, location and website". */
function listOf(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A dev save that wrote the DashPay profile and then failed on the Yappr
 * profile (the ticket's progress says 1 of 2 were done): the failure names
 * what did not save, "Couldn't save pronouns, location and website. Try
 * again." (UX_SPEC edit.partialFailed). Null for any other failure, which
 * keeps the write's own sentence.
 */
export function partialSaveFailure(
  ticket: Pick<WriteTicket, 'progress' | 'error'>,
  patch: ProfilePatchDTO,
): string | null {
  const { progress } = ticket;
  if (!progress || progress.total < 2 || progress.done < 1) return null;
  if (ticket.error && OWN_COPY_CODES.has(ticket.error.code)) return null;
  const names = SECOND_DOCUMENT_FIELDS.filter(([field]) => patch[field] !== undefined).map(([, name]) => name);
  return names.length > 0
    ? `Couldn't save ${listOf(names)}. Try again.`
    : "Couldn't save all of your changes. Try again.";
}
