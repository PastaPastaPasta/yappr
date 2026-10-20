import type { BlogDTO, BlogInfoDTO, BlogPostDTO, BlogPostInput } from '@engine/api';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { BookOpenIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { engineQueryOptions, useEngineQuery } from '~/data/queries';
import { useViewerId } from '~/data/session';
import { checkWrite, useWrite, type WriteResult } from '~/data/writes';
import { cn } from '~/lib-allowlist';
import { queryClient } from '~/state/query-client';
import { syncStorage } from '~/state/storage';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { KeyboardAvoider } from '~/ui/KeyboardAvoider';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { SwitchRow } from '~/ui/Switch';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';
import { MIN_TARGET, tw } from '~/ui/tokens';

import { BlockEditor } from './BlockEditor';
import {
  blocksOf,
  fromEditorBlocks,
  hasContent,
  LOCKED_BLOCK_NAMES,
  newEditorBlock,
  toEditorBlocks,
  type EditorBlock,
  type RawBlock,
} from './blocks';
import { openBlogPost } from './blog-navigation';
import { createdId, draftKey, editPostWrite, holdPublish, publishHeld, publishPostWrite, releasePublish, resolveHeldPublish } from './blog-writes';

const HOSTED = /^(https|ipfs):\/\/\S+$/;

/** Labels as typed ("travel, food") → a clean list. */
export function parseLabels(text: string): string[] {
  return [...new Set(text.split(',').map((label) => label.trim()).filter(Boolean))];
}

interface Form {
  title: string;
  summary: string;
  showSummary: boolean;
  cover: string;
  labels: string;
  comments: boolean;
  blocks: EditorBlock[];
}

/** A new post's unsaved work, kept on this device per account and blog (web's `yappr:blog-draft:…:new`). */
interface Draft extends Omit<Form, 'blocks'> {
  content: RawBlock[];
}

function readDraft(key: string): Draft | null {
  try {
    const raw = syncStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<Draft>;
    return typeof draft.title === 'string' && Array.isArray(draft.content) ? (draft as Draft) : null;
  } catch {
    return null;
  }
}

function formOf(post: BlogPostDTO | null, blog: BlogDTO, draft: Draft | null): Form {
  if (post) {
    return {
      title: post.title,
      summary: post.summaryText,
      showSummary: !post.summaryHidden,
      cover: post.coverImage ?? '',
      labels: post.labels.join(', '),
      comments: post.commentsEnabled,
      blocks: toEditorBlocks(blocksOf(post.content)),
    };
  }
  if (draft) return { ...draft, blocks: toEditorBlocks(blocksOf(draft.content)) };
  return { title: '', summary: '', showSummary: true, cover: '', labels: '', comments: blog.commentsEnabledDefault, blocks: [newEditorBlock('paragraph')] };
}

/** What the form would save, as the engine takes it. */
function inputOf(form: Form): BlogPostInput {
  return {
    title: form.title.trim(),
    summary: form.summary.trim(),
    summaryHidden: !form.showSummary,
    content: fromEditorBlocks(form.blocks),
    coverImage: form.cover.trim(),
    labels: parseLabels(form.labels),
    commentsEnabled: form.comments,
  };
}

/** Only the fields an edit changed (an unchanged field is never rewritten). */
function changes(post: BlogPostDTO, next: BlogPostInput): Partial<BlogPostInput> {
  const patch: Partial<BlogPostInput> = {};
  if (next.title !== post.title) patch.title = next.title;
  if (next.summary !== post.summaryText || next.summaryHidden !== post.summaryHidden) {
    patch.summary = next.summary;
    patch.summaryHidden = next.summaryHidden;
  }
  if (JSON.stringify(next.content) !== JSON.stringify(post.content)) patch.content = next.content;
  if (next.coverImage !== (post.coverImage ?? '')) patch.coverImage = next.coverImage;
  if (JSON.stringify(next.labels) !== JSON.stringify(post.labels)) patch.labels = next.labels;
  if (next.commentsEnabled !== post.commentsEnabled) patch.commentsEnabled = next.commentsEnabled;
  return patch;
}

function problems(form: Form, info: BlogInfoDTO | undefined): string | null {
  const limits = info?.limits;
  if (!form.title.trim()) return 'Add a title.';
  if (limits && Array.from(form.title.trim()).length > limits.title) return `Keep the title under ${limits.title} characters.`;
  if (limits && Array.from(form.summary.trim()).length > limits.summary) return `Keep the summary under ${limits.summary} characters.`;
  if (form.cover.trim() && !HOSTED.test(form.cover.trim())) return 'Use a cover image link that starts with https:// or ipfs://.';
  if (form.blocks.some((b) => b.kind === 'image' && b.url?.trim() && !HOSTED.test(b.url.trim()))) return 'Use image links that start with https:// or ipfs://.';
  const labels = parseLabels(form.labels);
  if (limits && labels.length > limits.postLabels) return `Use at most ${limits.postLabels} labels.`;
  if (limits && labels.some((label) => label.length > limits.labelLength)) return `Keep each label under ${limits.labelLength} characters.`;
  if (!hasContent(form.blocks)) return 'Write something first.';
  return null;
}

function Editor({ blog, post, info }: { blog: BlogDTO; post: BlogPostDTO | null; info: BlogInfoDTO | undefined }) {
  const viewerId = useViewerId();
  const key = viewerId ? draftKey(viewerId, blog.id) : null;
  const [form, setForm] = useState<Form>(() => formOf(post, blog, post || !key ? null : readDraft(key)));
  const [touched, setTouched] = useState(false);
  const publish = useWrite(publishPostWrite);
  const edit = useWrite(editPostWrite);
  const write = post ? edit : publish;
  /**
   * A publish of this draft may still land with no ticket this screen follows: the engine restarted
   * or timed out under the call, or the editor was reopened after one went out.
   */
  const [lostAnswer, setLostAnswer] = useState(() => !post && viewerId !== null && publishHeld(viewerId, blog.id));
  /** The held publish's ticket, once the engine lists it ("Check again"). */
  const [heldTicket, setHeldTicket] = useState<string | null>(null);

  // Reopened while held: what became of it decides whether the draft comes back.
  const resolveHeld = useCallback(() => {
    if (post || !viewerId) return;
    resolveHeldPublish(viewerId, blog.id)
      .then((outcome) => {
        if (outcome.state === 'held') {
          setHeldTicket(outcome.ticketId);
          return;
        }
        setLostAnswer(false);
        setHeldTicket(null);
        if (outcome.state === 'published') {
          // It went out: this draft is that post, so the editor starts afresh.
          toast.success('Your post was published');
          setForm(formOf(null, blog, null));
          setTouched(false);
        }
      })
      .catch(() => undefined);
  }, [post, viewerId, blog]);
  const resolvedOnOpen = useRef(false);
  useEffect(() => {
    if (resolvedOnOpen.current || !lostAnswer || write.status !== 'idle') return;
    resolvedOnOpen.current = true;
    resolveHeld();
  }, [lostAnswer, write.status, resolveHeld]);
  // A save that may still land holds the form: sending it again could publish the post twice.
  const [starting, setStarting] = useState(false);
  const busy = starting || lostAnswer || write.status === 'pending' || (write.status === 'unconfirmed' && write.ticket?.retryable !== true);
  const left = useRef(false);
  const sending = useRef(false);

  const saveDraft = (current: Form) => {
    if (post || !key) return;
    const { blocks, ...rest } = current;
    syncStorage.setItem(key, JSON.stringify({ ...rest, content: fromEditorBlocks(blocks) } satisfies Draft));
  };

  const set = (patch: Partial<Form>) => {
    setTouched(true);
    setForm((current) => ({ ...current, ...patch }));
  };

  // A new post's work is kept on the device as the writer goes (web autosaves its draft).
  useEffect(() => {
    // Not while a publish may land, nor once it has (confirmed, the draft is removed). A refused one is editable again.
    if (post || !key || !touched || busy || write.status === 'confirmed') return;
    const timer = setTimeout(() => saveDraft(form), 600);
    return () => clearTimeout(timer);
  });

  // Confirmed: the new post opens; an edit goes back to it.
  useEffect(() => {
    if (write.status !== 'confirmed' || left.current) return;
    left.current = true;
    if (post) {
      toast.success('Post saved');
      router.back();
      return;
    }
    if (key) syncStorage.removeItem(key);
    toast.success('Post published');
    const id = createdId(write.ticket);
    if (!id) {
      router.back();
      return;
    }
    queryClient
      .fetchQuery(engineQueryOptions(queryKeys.blog.post(id), (api) => api.blogs.post(id)))
      .then((created) => {
        router.back();
        if (created) openBlogPost(created.blogId, created.slug);
      })
      .catch(() => router.back());
  }, [write.status, write.ticket, post, key]);

  const problem = problems(form, info);
  const locked = useMemo(
    () => [...new Set(form.blocks.filter((b) => b.kind === 'locked').map((b) => LOCKED_BLOCK_NAMES[b.original?.type ?? ''] ?? 'Other'))],
    [form.blocks],
  );

  const save = () => {
    if (busy || sending.current) return;
    if (problem) {
      toast.error(problem);
      return;
    }
    const input = inputOf(form);
    // Kept first, so a publish refused before the autosave ran loses nothing.
    saveDraft(form);
    const done = (result?: WriteResult) => {
      sending.current = false;
      setStarting(false);
      if (result?.status === 'unknown') setLostAnswer(true);
    };
    // From the tap until the engine answers with a ticket the form is locked too: edits made then would not be in the write.
    setStarting(true);
    if (post) {
      const patch = changes(post, input);
      if (Object.keys(patch).length === 0) {
        setStarting(false);
        router.back();
        return;
      }
      sending.current = true;
      edit.send({ postId: post.id, blogId: blog.id, input: patch }).then(done, () => done());
    } else if (viewerId) {
      sending.current = true;
      // Held from the tap: closing and reopening the editor must not offer this draft again while it may land.
      holdPublish(viewerId, blog.id, input.title);
      publish.send({ viewerId, blogId: blog.id, input }).then((result) => {
        // Refused before a ticket (nothing sent): editable again at once.
        if (result.status === 'refused') releasePublish(viewerId, blog.id, false);
        done(result);
      }, () => done());
    }
  };

  const discardDraft = () => {
    if (key) syncStorage.removeItem(key);
    setTouched(false);
    setForm(formOf(null, blog, null));
  };

  // A held draft whose publish can't be traced: dropping it (never sending it again) is always safe.
  const discardHeld = () => {
    if (viewerId) releasePublish(viewerId, blog.id, true);
    setLostAnswer(false);
    setHeldTicket(null);
    discardDraft();
  };

  const action = post ? 'Save' : 'Publish';
  return (
    <>
      <Stack.Screen
        options={{
          title: post ? 'Edit post' : 'New post',
          headerRight: () => (
            <Pressable
              onPress={save}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy, busy }}
              hitSlop={8}
              style={{ minHeight: MIN_TARGET, justifyContent: 'center', opacity: busy ? 0.5 : 1 }}
              testID="blog-editor-save"
            >
              {busy ? <Spinner size="sm" /> : <Text tone="link" variant="bodyStrong">{action}</Text>}
            </Pressable>
          ),
        }}
      />
      <KeyboardAvoider>
        <ScrollView className="flex-1" contentContainerClassName="gap-4 p-4 pb-16" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          <Text variant="subhead" tone="secondary">{`In ${blog.name}`}</Text>
          {write.status === 'unconfirmed' || lostAnswer ? (
            <View className={cn('gap-2 rounded-xl border p-3', tw.border)}>
              <Text variant="bodyStrong">{post ? 'Your changes were sent' : 'Your post was sent'}</Text>
              <Text variant="subhead" tone="secondary">{"It isn't confirmed yet. It usually shows up within a minute or two."}</Text>
              {write.ticket ? (
                <Button label="Check again" variant="outline" size="sm" onPress={() => { write.check().catch(() => undefined); }} testID="blog-editor-check" />
              ) : lostAnswer && !post ? (
                <View className="flex-row gap-2">
                  <Button
                    label="Check again"
                    variant="outline"
                    size="sm"
                    onPress={() => {
                      (heldTicket ? checkWrite(heldTicket) : Promise.resolve(null)).then(resolveHeld, resolveHeld);
                    }}
                    testID="blog-editor-check"
                  />
                  <Button label="Discard draft" variant="ghost" size="sm" onPress={discardHeld} testID="blog-editor-discard-held" />
                </View>
              ) : null}
            </View>
          ) : null}
          <TextField label="Title" value={form.title} onChangeText={(title) => set({ title })} maxLength={info?.limits.title} editable={!busy} testID="blog-editor-title" />
          <TextField
            label="Summary (optional)"
            value={form.summary}
            onChangeText={(summary) => set({ summary })}
            maxLength={info?.limits.summary}
            multiline
            editable={!busy}
            testID="blog-editor-summary"
          />
          <SwitchRow label="Show the summary on the post" description="It always shows on post cards." value={form.showSummary} onValueChange={(showSummary) => set({ showSummary })} disabled={busy} />
          <View className="gap-1">
            <Text variant="subheadStrong">Story</Text>
            {locked.length > 0 ? (
              <Text variant="caption" tone="secondary">
                {`Some parts of this post can only be changed on yap.pr (${locked.join(', ')}). They stay as they are.`}
              </Text>
            ) : null}
          </View>
          <BlockEditor blocks={form.blocks} onChange={(blocks) => set({ blocks })} editable={!busy} />
          <TextField
            label="Cover image link (optional)"
            value={form.cover}
            onChangeText={(cover) => set({ cover })}
            placeholder="https://"
            autoCapitalize="none"
            keyboardType="url"
            editable={!busy}
            error={form.cover.trim() && !HOSTED.test(form.cover.trim()) ? 'Use a link that starts with https:// or ipfs://' : undefined}
            testID="blog-editor-cover"
          />
          <TextField
            label="Labels (optional)"
            value={form.labels}
            onChangeText={(labels) => set({ labels })}
            placeholder="Separate labels with commas"
            editable={!busy}
            autoCorrect={false}
            testID="blog-editor-labels"
          />
          <SwitchRow label="Allow comments" value={form.comments} onValueChange={(comments) => set({ comments })} disabled={busy} testID="blog-editor-comments" />
          <Button label={action} size="block" onPress={save} loading={busy} disabled={busy} testID="blog-editor-submit" />
          {!post && touched && !busy ? (
            <Button label="Discard draft" variant="ghost" onPress={discardDraft} testID="blog-editor-discard" />
          ) : null}
        </ScrollView>
      </KeyboardAvoider>
    </>
  );
}

function useEditorData(blogId: string, slug: string | null) {
  const info = useEngineQuery(queryKeys.blog.info, (api) => api.blogs.info(), { staleTime: Infinity });
  const blog = useEngineQuery(queryKeys.blog.detail(blogId), (api) => api.blogs.get(blogId));
  const post = useEngineQuery(queryKeys.blog.postBySlug(blogId, slug ?? ''), (api) => api.blogs.postBySlug(blogId, slug ?? ''), {
    enabled: slug !== null,
  });
  return { info, blog, post };
}

function EditorGate({ blogId, slug }: { blogId: string; slug: string | null }) {
  const viewerId = useViewerId();
  const { info, blog, post } = useEditorData(blogId, slug);
  const loading = blog.isPending || (slug !== null && post.isPending);
  if (!viewerId) return <EmptyState icon={BookOpenIcon} title="Sign in to write" description="Sign in to write on your blog." />;
  if (loading) return <View className="items-center py-12"><Spinner /></View>;
  // A failed refetch keeps what was read: only a read with nothing to show is an error.
  if ((blog.isError && blog.data === undefined) || (slug && post.isError && post.data === undefined)) {
    return <ErrorState title="Couldn't load this post" onRetry={() => { blog.refetch().catch(() => undefined); post.refetch().catch(() => undefined); }} />;
  }
  const b = blog.data;
  const p = slug ? (post.data ?? null) : null;
  if (!b || (slug && (!p || p.deleted))) return <EmptyState icon={BookOpenIcon} title="This isn't available" description="It may have been deleted." />;
  if (b.ownerId !== viewerId) return <EmptyState icon={BookOpenIcon} title="You can only write on your own blogs" />;
  return <Editor blog={b} post={p} info={info.data} />;
}

/** Write a new post on one of the viewer's blogs (web `compose-post.tsx`). */
export function NewPostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Screen>
      <Stack.Screen options={{ title: 'New post' }} />
      <EditorGate blogId={id} slug={null} />
    </Screen>
  );
}

/** Edit one of the viewer's posts. */
export function EditPostScreen() {
  const { id, slug } = useLocalSearchParams<{ id: string; slug: string }>();
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Edit post' }} />
      <EditorGate blogId={id} slug={slug} />
    </Screen>
  );
}
