import type { PostDTO, UserSummaryDTO } from '@engine/api';
import { useNetInfo } from '@react-native-community/netinfo';
import { Image } from 'expo-image';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { ExclamationTriangleIcon, PencilSquareIcon, XMarkIcon } from 'react-native-heroicons/outline';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { lastIdentity, useCapabilities, useSession } from '~/data/session';
import { cn } from '~/lib-allowlist';
import { showActionSheet } from '~/ui/action-sheet';
import { Button } from '~/ui/Button';
import { EmptyState } from '~/ui/EmptyState';
import { successFeedback } from '~/ui/haptics';
import { IconButton } from '~/ui/IconButton';
import { LinkText } from '~/ui/LinkText';
import { useMediaUrls } from '~/ui/media-url';
import { PostCard } from '~/ui/post/PostCard';
import { PostStub } from '~/ui/post/PostStub';
import { QuoteEmbed, QuoteSkeleton } from '~/ui/post/QuoteEmbed';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

import { ComposeAccessoryBar } from './ComposeAccessoryBar';
import { ComposePart } from './ComposePart';
import {
  contextKey,
  deleteDraft,
  deleteOwnDraft,
  loadDraft,
  saveDraft,
  type ComposeContext,
  type DraftPart,
} from './drafts';
import { FALLBACK_LIMITS, hasVisibleContent, isOverContentLimit } from './limits';
import { MentionSuggestions, useDebounced } from './MentionSuggestions';
import { discardPending, pendingDraft, publishPost, viewerAuthor } from './pending-posts';
import { insertMention, mentionAt, tagMaxLength } from './text';

/** `compose-modal.tsx` `canAddThread`: a thread holds at most 10 posts. */
const MAX_PARTS = 10;
/** Drafts save this long after the last change (PRD COMP-09). */
const SAVE_DELAY_MS = 500;
/** `posts.publish` accepts an image hosted elsewhere (no upload in 1.0). */
const HOSTED_URL = /^(https?|ipfs):\/\/\S+$/;

const EMPTY_PART: DraftPart = { text: '', postedId: null };
const PREVIEW_DELAY_MS = 400;

function contextOf(params: { replyTo?: string; quote?: string; pending?: string }): ComposeContext {
  const pending = params.pending ? { pendingId: params.pending } : {};
  if (params.replyTo) return { mode: 'reply', targetId: params.replyTo, ...pending };
  if (params.quote) return { mode: 'quote', targetId: params.quote, ...pending };
  return { mode: 'post', targetId: null, ...pending };
}

function placeholderFor(context: ComposeContext, index: number): string {
  if (context.mode === 'reply') return 'Post your reply';
  if (context.mode === 'quote') return 'Add a comment';
  return index === 0 ? "What's on your mind?" : 'Continue your thread...';
}

/** Header close: "Cancel" on iOS, × on Android (PRD COMP-01). */
function CloseButton({ onPress }: { onPress: () => void }) {
  return Platform.OS === 'ios' ? (
    <Button label="Cancel" variant="ghost" size="sm" onPress={onPress} testID="compose-close" />
  ) : (
    <IconButton icon={XMarkIcon} accessibilityLabel="Close composer" onPress={onPress} testID="compose-close" />
  );
}

/** The NSFW chip (UX_SPEC §4.11): outline when off, amber when on; a switch to screen readers. */
function NsfwToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel="Mark this post as NSFW"
      accessibilityState={{ checked: on }}
      onPress={onToggle}
      hitSlop={8}
      className={cn(
        'h-8 justify-center rounded-full border px-3',
        on ? 'border-amber-500 bg-amber-500' : cn(tw.borderStrong, 'bg-transparent'),
      )}
      testID="compose-nsfw"
    >
      <Text variant="chip" className={on ? 'text-black dark:text-black' : undefined} tone={on ? 'primary' : 'secondary'}>
        NSFW
      </Text>
    </Pressable>
  );
}

/** The post replied to or quoted could not be read (not the same as deleted): retry the read. */
function TargetUnread({ onRetry, inset = true }: { onRetry: () => void; inset?: boolean }) {
  const c = useColors();
  return (
    <View className={cn('flex-row flex-wrap items-center gap-1.5', inset && 'px-4')} testID="compose-target-unread">
      <ExclamationTriangleIcon size={16} color={c.textSecondary} />
      <Text variant="subhead" tone="secondary">
        Couldn&apos;t load the post
      </Text>
      <Text variant="subhead" tone="decorative">
        ·
      </Text>
      <LinkText label="Retry" onPress={onRetry} variant="subhead" role="button" />
    </View>
  );
}

function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

/**
 * Compose (PRD COMP-01 – COMP-12, UX_SPEC §4.11): a full-screen modal for
 * a post, a reply (`?replyTo=<id>`) or a quote (`?quote=<id>`); with
 * `&pending=<localId>`, a post that did not go through (Edit). Signed out
 * it asks for sign-in; the editor itself is `Composer`.
 */
export function ComposeScreen() {
  const params = useLocalSearchParams<{ replyTo?: string; quote?: string; pending?: string }>();
  const context = contextOf(params);
  const { status, session } = useSession();
  // While the engine restores the session, whoever was signed in last counts (PRD G-2).
  const identityId = session?.identityId ?? (status === 'unknown' ? lastIdentity() : null);
  const insets = useSafeAreaInsets();

  if (!identityId) {
    return (
      <View className="flex-1 bg-white dark:bg-neutral-900" style={{ paddingTop: insets.top }}>
        <View className="h-14 flex-row items-center px-2">
          <CloseButton onPress={() => router.back()} />
        </View>
        <EmptyState
          icon={PencilSquareIcon}
          title="Sign in to post"
          description="Sign in to post, reply and quote. You can keep browsing without an account."
          action={{ label: 'Sign in', onPress: () => router.replace('/sign-in') }}
          testID="compose-signed-out"
        />
      </View>
    );
  }
  return (
    <Composer
      key={`${identityId}:${contextKey(context)}`}
      identityId={identityId}
      username={session?.username ?? null}
      context={context}
    />
  );
}

interface ComposerProps {
  identityId: string;
  username: string | null;
  context: ComposeContext;
}

function Composer({ identityId, username, context }: ComposerProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const keyboardShown = useKeyboardShown();
  const net = useNetInfo();
  const offline = net.isConnected === false;
  const capabilities = useCapabilities();
  const limits = capabilities?.contentLimits ?? FALLBACK_LIMITS;
  const inlineHints = capabilities?.hashtagsInline === true;
  const tagMax = tagMaxLength(inlineHints);
  const { media } = useMediaUrls();

  // Editing a post that did not go through opens its own slot, else the post's text.
  const [initial] = useState(
    () => loadDraft(identityId, context) ?? (context.pendingId ? pendingDraft(context.pendingId) : null),
  );
  const [parts, setParts] = useState<DraftPart[]>(() => (initial?.parts.length ? initial.parts : [EMPTY_PART]));
  const [sensitive, setSensitive] = useState(initial?.sensitive ?? false);
  const [mediaUrl, setMediaUrl] = useState(initial?.mediaUrl ?? '');
  const [mediaOpen, setMediaOpen] = useState((initial?.mediaUrl ?? '') !== '');
  const firstOpen = Math.max(0, parts.findIndex((p) => !p.postedId));
  const [active, setActive] = useState(firstOpen);
  const [caret, setCaret] = useState(() => parts[firstOpen]?.text.length ?? 0);
  /** The part to focus once the parts have re-rendered (after add or remove). */
  const focusNext = useRef<number | null>(null);
  const inputs = useRef<(TextInput | null)[]>([]);

  const targetId = context.targetId ?? '';
  const target = useEngineQuery(queryKeys.post.detail(targetId), (api) => api.posts.get(targetId), {
    enabled: context.mode !== 'post',
    persist: true,
  });
  const targetPost: PostDTO | null = target.data ?? null;
  // Only a tombstone is gone: `posts.get` also answers null when the read failed.
  const targetGone = context.mode !== 'post' && targetPost?.deleted === true;
  const targetUnread = context.mode !== 'post' && !target.isFetching && targetPost === null && (target.isSuccess || target.isError);
  const profile = useEngineQuery(queryKeys.profile.detail(identityId), (api) => api.profiles.get(identityId), {
    persist: true,
  });
  const author = viewerAuthor(identityId, username, profile.data);

  // What there is to post: open parts with visible text.
  const open = parts.filter((p) => !p.postedId);
  const contentful = parts.filter((p) => p.postedId || hasVisibleContent(p.text));
  const hasContent = open.some((p) => hasVisibleContent(p.text)) || mediaUrl.trim() !== '';
  const overLimit = open.some((p) => isOverContentLimit(p.text.trim(), limits));
  const mediaValid = mediaUrl.trim() === '' || HOSTED_URL.test(mediaUrl.trim());
  const targetReady = context.mode === 'post' || (targetPost !== null && !targetGone);
  const canPost = open.some((p) => hasVisibleContent(p.text)) && !overLimit && !offline && mediaValid && targetReady;
  const postLabel = context.mode === 'reply' ? 'Reply' : contentful.length > 1 ? `Post all (${contentful.length})` : 'Post';
  const canAddPart = context.mode === 'post' && parts.length < MAX_PARTS;

  // Drafts: saved 500 ms after a change and when the app goes to the background (PRD COMP-09).
  const posted = useRef(false);
  const latest = useRef({ parts, sensitive, mediaUrl, hasContent });
  useEffect(() => {
    latest.current = { parts, sensitive, mediaUrl, hasContent };
  }, [parts, sensitive, mediaUrl, hasContent]);
  const persist = useCallback(() => {
    if (posted.current) return;
    const now = latest.current;
    if (now.hasContent) {
      const draft = {
        context,
        parts: now.parts,
        sensitive: now.sensitive,
        mediaUrl: now.mediaUrl.trim(),
      };
      // A draft back from a failed post keeps that link until it is edited (drafts.ts `fromPending`).
      const unedited =
        initial?.fromPending !== undefined &&
        JSON.stringify(draft) ===
          JSON.stringify({ context, parts: initial.parts, sensitive: initial.sensitive, mediaUrl: initial.mediaUrl });
      saveDraft(identityId, {
        ...draft,
        updatedAt: Date.now(),
        ...(unedited ? { fromPending: initial.fromPending } : {}),
      });
    } else if (!now.parts.some((p) => p.postedId)) {
      deleteOwnDraft(identityId, context, initial?.fromPending);
    }
  }, [identityId, context, initial]);

  useEffect(() => {
    const timer = setTimeout(persist, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [parts, sensitive, mediaUrl, persist]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') persist();
    });
    return () => sub.remove();
  }, [persist]);

  // Closing: with content, "Save draft / Delete draft / Cancel" (PRD COMP-09); the
  // swipe and Android back go through the same choice.
  const leaving = useRef(false);
  const askToLeave = useCallback(
    (leave: () => void) => {
      if (!latest.current.hasContent) {
        Keyboard.dismiss();
        persist();
        leaving.current = true;
        leave();
        return;
      }
      Keyboard.dismiss();
      showActionSheet({
        actions: [
          {
            label: 'Save draft',
            onPress: () => {
              persist();
              leaving.current = true;
              leave();
            },
          },
          {
            label: 'Delete draft',
            destructive: true,
            onPress: () => {
              posted.current = true;
              deleteDraft(identityId, context);
              // Deleting the text of a post that did not go through drops its card too.
              if (context.pendingId) discardPending(context.pendingId);
              leaving.current = true;
              leave();
            },
          },
          ...(Platform.OS === 'android' ? [{ label: 'Cancel', onPress: () => undefined }] : []),
        ],
      });
    },
    [identityId, context, persist],
  );

  // The native stack's own dismissal (a swipe, Android back) is held too, not just the JS one.
  usePreventRemove(true, ({ data }) => {
    if (leaving.current) navigation.dispatch(data.action);
    else askToLeave(() => navigation.dispatch(data.action));
  });

  const close = () => askToLeave(() => router.back());

  const post = () => {
    if (!canPost) return;
    Keyboard.dismiss();
    posted.current = true;
    leaving.current = true;
    // This draft came back from a failed post: posting it again replaces that card, never doubles it.
    const replaced = context.pendingId ?? initial?.fromPending;
    if (replaced) discardPending(replaced);
    publishPost(
      {
        identityId,
        context,
        parts,
        sensitive,
        mediaUrl: mediaUrl.trim() || null,
        target: targetPost,
        author,
      },
      hasVisibleContent,
    );
    successFeedback();
    router.back();
  };

  // Editing.
  const setPartText = (index: number, text: string) =>
    setParts((current) => current.map((p, i) => (i === index ? { ...p, text } : p)));
  const onSelection = (index: number, at: number) => {
    if (index === active) setCaret(at);
  };
  const onFocus = (index: number) => {
    setActive(index);
    setCaret(parts[index]?.text.length ?? 0);
  };
  const addPart = () => {
    focusNext.current = parts.length;
    setParts((current) => [...current, EMPTY_PART]);
  };
  const removePart = (index: number) => {
    const next = Math.max(firstOpen, index - 1);
    focusNext.current = next;
    // The suggestions and the counter follow the part that takes the focus.
    setActive(next);
    setCaret(parts[next]?.text.length ?? 0);
    setParts((current) => current.filter((_, i) => i !== index));
  };
  useEffect(() => {
    if (focusNext.current === null) return;
    const input = inputs.current[focusNext.current];
    focusNext.current = null;
    requestAnimationFrame(() => input?.focus());
  }, [parts.length]);

  const activeText = parts[active]?.text ?? '';
  const mention = mentionAt(activeText, caret);
  const selectMention = (user: UserSummaryDTO) => {
    if (!mention || !user.username) return;
    const next = insertMention(activeText, mention, user.username);
    setPartText(active, next.text);
    setCaret(next.caret);
    const input = inputs.current[active];
    requestAnimationFrame(() => input?.setSelection(next.caret, next.caret));
  };

  const toggleMedia = () => {
    if (mediaOpen) setMediaUrl('');
    setMediaOpen(!mediaOpen);
  };
  // The preview follows the URL once typing pauses, not on every keystroke.
  const previewUrl = useDebounced(mediaValid ? mediaUrl.trim() : '', PREVIEW_DELAY_MS);
  const previewUri = previewUrl ? media(previewUrl) : undefined;
  const replyHandle = targetPost?.author.username ?? targetPost?.author.displayName;

  return (
    <View className="flex-1 bg-white dark:bg-neutral-900" style={{ paddingTop: insets.top }} testID="compose-screen">
      <View className={cn('h-14 flex-row items-center gap-2 px-2', tw.border)}>
        <CloseButton onPress={close} />
        <View className="flex-1" />
        <NsfwToggle on={sensitive} onToggle={() => setSensitive(!sensitive)} />
        <Button
          label={postLabel}
          size="sm"
          disabled={!canPost}
          onPress={post}
          accessibilityHint={offline ? "You're offline" : undefined}
          className="mr-2"
          testID="compose-post"
        />
      </View>
      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <ScrollView className="flex-1" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: 8 }}>
          {context.mode === 'reply' ? (
            <View className="mb-2" testID="compose-reply-context">
              {targetPost && !targetGone ? (
                <>
                  <PostCard post={targetPost} variant="compact" />
                  <Text variant="subhead" tone="secondary" className="px-4 pb-2 pl-[60px]">
                    Replying to{' '}
                    <Text variant="subhead" tone="link">
                      @{replyHandle}
                    </Text>
                  </Text>
                </>
              ) : targetGone ? (
                <View className="px-4">
                  <PostStub state="deleted" variant="embed" />
                  <Text variant="caption" tone="error" className="mt-1">
                    This post was deleted, so it can&apos;t be replied to.
                  </Text>
                </View>
              ) : targetUnread ? (
                <TargetUnread onRetry={() => target.refetch()} />
              ) : (
                <View className="px-4">
                  <QuoteSkeleton />
                </View>
              )}
            </View>
          ) : null}
          {parts.map((part, index) => (
            <ComposePart
              key={index}
              ref={(input) => {
                inputs.current[index] = input;
              }}
              index={index}
              part={part}
              author={author}
              placeholder={placeholderFor(context, index)}
              limits={limits}
              tagMax={tagMax}
              inlineHints={inlineHints}
              joined={index < parts.length - 1}
              removable={parts.length > 1 && !part.postedId}
              autoFocus={index === firstOpen}
              onChangeText={setPartText}
              onFocus={onFocus}
              onSelection={onSelection}
              onRemove={removePart}
            />
          ))}
          {mediaOpen ? (
            <View className="mb-3 pl-[60px] pr-4" testID="compose-media">
              <TextInput
                value={mediaUrl}
                onChangeText={setMediaUrl}
                placeholder="Image URL (https:// or ipfs://)"
                placeholderTextColor={c.textPlaceholder}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                accessibilityLabel="Image URL"
                className={cn(
                  'min-h-11 rounded-lg border px-3 text-base',
                  mediaValid ? tw.borderStrong : 'border-red-600 dark:border-red-400',
                )}
                style={{ color: c.textPrimary }}
                testID="compose-media-url"
              />
              {!mediaValid ? (
                <Text variant="caption" tone="error" className="mt-1">
                  Use an https:// or ipfs:// link to an image.
                </Text>
              ) : null}
              {previewUri ? (
                <View
                  className={cn('mt-2 overflow-hidden rounded-xl border', tw.border)}
                  style={{ aspectRatio: 16 / 9 }}
                  testID="compose-media-preview"
                >
                  <Image
                    source={{ uri: previewUri }}
                    style={{ flex: 1 }}
                    contentFit="cover"
                    recyclingKey={previewUri}
                    accessibilityLabel="Image preview"
                  />
                </View>
              ) : null}
            </View>
          ) : null}
          {context.mode === 'quote' ? (
            <View className="mb-4 pl-[60px] pr-4" testID="compose-quote">
              {targetPost && !targetGone ? (
                <QuoteEmbed post={targetPost} nsfwGated={targetPost.sensitive} />
              ) : targetGone ? (
                <PostStub state="deleted" variant="embed" />
              ) : targetUnread ? (
                <TargetUnread onRetry={() => target.refetch()} inset={false} />
              ) : (
                <QuoteSkeleton />
              )}
            </View>
          ) : null}
        </ScrollView>
        <MentionSuggestions query={mention?.query ?? ''} onSelect={selectMention} />
        <ComposeAccessoryBar
          text={activeText}
          limits={limits}
          offline={offline}
          canAddPart={canAddPart}
          onAddPart={addPart}
          mediaOpen={mediaOpen}
          onToggleMedia={toggleMedia}
          bottomInset={keyboardShown ? 0 : insets.bottom}
        />
      </KeyboardAvoidingView>
    </View>
  );
}
