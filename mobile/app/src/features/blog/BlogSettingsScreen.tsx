import type { BlogDTO, BlogInfoDTO, BlogInput, BlogThemeDTO, BlogThemePresetDTO } from '@engine/api';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { CheckCircleIcon, DocumentTextIcon, NoSymbolIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useSession } from '~/data/session';
import { useWrite } from '~/data/writes';
import { errorMessage } from '~/engine/logs';
import { Button } from '~/ui/Button';
import { confirmAlert } from '~/ui/Dialog';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { KeyboardAvoider } from '~/ui/KeyboardAvoider';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { SwitchRow } from '~/ui/Switch';
import { FilterChips, SegmentedControl } from '~/ui/Tabs';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';
import { MIN_TARGET, tw } from '~/ui/tokens';

import { blogPalette, fontStyle } from './blog-theme';
import { createBlogWrite, createdId, deleteBlogWrite, updateBlogWrite } from './blog-writes';

type HeaderStyle = BlogThemeDTO['headerStyle'];

const HEADER_STYLES: { value: HeaderStyle; label: string }[] = [
  { value: 'hero', label: 'Hero' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'banner', label: 'Banner' },
];

const IMAGE_LINK = /^(https|ipfs):\/\/.+$/i;
const IMAGE_LINK_ERROR = 'Use a link that starts with https:// or ipfs://';

interface BlogForm {
  name: string;
  description: string;
  avatar: string;
  headerImage: string;
  labels: string;
  comments: boolean;
  theme: BlogThemeDTO;
}

/** The labels a comma-separated line holds: trimmed, without blanks or repeats. */
function parseLabels(text: string): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const part of text.split(',')) {
    const label = part.trim();
    const key = label.toLowerCase();
    if (label === '' || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

function formFrom(blog: BlogDTO | null, startTheme: BlogThemeDTO): BlogForm {
  if (blog) {
    return {
      name: blog.name,
      description: blog.description ?? '',
      avatar: blog.avatar ?? '',
      headerImage: blog.headerImage ?? '',
      labels: blog.labels.join(', '),
      comments: blog.commentsEnabledDefault,
      theme: blog.theme,
    };
  }
  return { name: '', description: '', avatar: '', headerImage: '', labels: '', comments: true, theme: startTheme };
}

interface FormErrors {
  avatar?: string;
  headerImage?: string;
  labels?: string;
}

function validate(form: BlogForm, info: BlogInfoDTO): FormErrors {
  const errors: FormErrors = {};
  const avatar = form.avatar.trim();
  const header = form.headerImage.trim();
  if (avatar !== '' && !IMAGE_LINK.test(avatar)) errors.avatar = IMAGE_LINK_ERROR;
  if (header !== '' && !IMAGE_LINK.test(header)) errors.headerImage = IMAGE_LINK_ERROR;
  const labels = parseLabels(form.labels);
  if (labels.length > info.limits.blogLabels) {
    errors.labels = `Use at most ${info.limits.blogLabels} labels.`;
  } else if (labels.some((label) => label.length > info.limits.labelLength)) {
    errors.labels = `Each label can have at most ${info.limits.labelLength} characters.`;
  }
  return errors;
}

const sameTheme = (a: BlogThemeDTO, b: BlogThemeDTO) => JSON.stringify(a) === JSON.stringify(b);

/** A new blog's fields: what is empty is left out. */
function inputOf(form: BlogForm): BlogInput {
  const labels = parseLabels(form.labels);
  const input: BlogInput = { name: form.name.trim(), commentsEnabledDefault: form.comments, theme: form.theme };
  if (form.description.trim() !== '') input.description = form.description.trim();
  if (form.avatar.trim() !== '') input.avatar = form.avatar.trim();
  if (form.headerImage.trim() !== '') input.headerImage = form.headerImage.trim();
  if (labels.length > 0) input.labels = labels;
  return input;
}

/** An edit's fields: only what changed since the form opened. */
function patchOf(initial: BlogForm, form: BlogForm): Partial<BlogInput> {
  const patch: Partial<BlogInput> = {};
  if (form.name.trim() !== initial.name.trim()) patch.name = form.name.trim();
  if (form.description.trim() !== initial.description.trim()) patch.description = form.description.trim();
  if (form.avatar.trim() !== initial.avatar.trim()) patch.avatar = form.avatar.trim();
  if (form.headerImage.trim() !== initial.headerImage.trim()) patch.headerImage = form.headerImage.trim();
  const labels = parseLabels(form.labels);
  if (JSON.stringify(labels) !== JSON.stringify(parseLabels(initial.labels))) patch.labels = labels;
  if (form.comments !== initial.comments) patch.commentsEnabledDefault = form.comments;
  if (!sameTheme(form.theme, initial.theme)) patch.theme = form.theme;
  return patch;
}

/** A preset as a small card in its own colors. */
function PresetCard({
  preset,
  selected,
  disabled,
  onSelect,
}: {
  preset: BlogThemePresetDTO;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const palette = blogPalette(preset.theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${preset.name} look`}
      accessibilityHint={preset.description}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onSelect}
      testID={`blog-theme-${preset.id}`}
      className="w-36 gap-2 rounded-xl p-3"
      style={{
        minHeight: MIN_TARGET + 40,
        backgroundColor: palette.bg,
        borderWidth: 2,
        borderColor: selected ? palette.accent : palette.border,
      }}
    >
      <View className="flex-row items-center justify-between">
        <View className="h-4 w-4 rounded-full" style={{ backgroundColor: palette.accent }} />
        {selected ? <CheckCircleIcon size={18} color={palette.accent} /> : null}
      </View>
      <Text variant="bodyStrong" numberOfLines={1} style={{ color: palette.heading, ...fontStyle(preset.theme.fonts.heading) }}>
        {preset.name}
      </Text>
      <Text variant="caption" numberOfLines={1} style={{ color: palette.text, ...fontStyle(preset.theme.fonts.body) }}>
        Aa Bb Cc
      </Text>
    </Pressable>
  );
}

/** The blog name and description as a reader's page would open. */
function LookPreview({ theme, name, description }: { theme: BlogThemeDTO; name: string; description: string }) {
  const palette = blogPalette(theme);
  const centered = theme.headerStyle === 'hero';
  return (
    <View
      className="overflow-hidden rounded-xl"
      style={{ backgroundColor: palette.bg, borderWidth: 1, borderColor: palette.border }}
      testID="blog-settings-preview"
    >
      {theme.headerStyle === 'banner' ? <View className="h-10" style={{ backgroundColor: palette.accent }} /> : null}
      <View className={cn('gap-1 px-4', theme.headerStyle === 'hero' ? 'py-8' : 'py-4')}>
        <Text
          variant={theme.headerStyle === 'minimal' ? 'title' : 'titleLarge'}
          numberOfLines={2}
          style={{ color: palette.heading, textAlign: centered ? 'center' : 'left', ...fontStyle(theme.fonts.heading) }}
        >
          {name.trim() || 'Your blog'}
        </Text>
        <Text
          variant="body"
          numberOfLines={3}
          style={{ color: palette.muted, textAlign: centered ? 'center' : 'left', ...fontStyle(theme.fonts.body) }}
        >
          {description.trim() || 'A few words about what you write.'}
        </Text>
      </View>
    </View>
  );
}

function BlogSettingsForm({
  info,
  blog,
  startTheme,
}: {
  info: BlogInfoDTO;
  /** The blog being edited; `null` creates one. */
  blog: BlogDTO | null;
  /** A new blog's look: the first preset (minimal), unless a person picks another. */
  startTheme: BlogThemeDTO;
}) {
  const editing = blog !== null;
  const blogId = blog?.id ?? '';
  const [initial] = useState(() => formFrom(blog, startTheme));
  const [form, setForm] = useState<BlogForm>(initial);
  const set = <K extends keyof BlogForm>(key: K) => (value: BlogForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const create = useWrite(createBlogWrite);
  const update = useWrite(updateBlogWrite);
  const remove = useWrite(deleteBlogWrite);
  const save = editing ? update : create;

  // A confirmed save leaves the screen (below), and the form keeps its saving look until it has
  // gone: re-enabling the fields in the render that leaves moves them between native parents,
  // which crashes Android while the screen animates out (mobile/CLAUDE.md, "Native view structure").
  const closing = save.status === 'confirmed' || remove.status === 'confirmed';
  // Sent, but not confirmed: it may still land, so it is never called saved. The form stays locked
  // while the app checks; "Check again" checks now.
  const unsureRemove = remove.status === 'unconfirmed' && remove.ticket?.retryable !== true;
  const unsureSave = save.status === 'unconfirmed' && save.ticket?.retryable !== true;
  /** A save or delete whose answer was lost (engine restart, timeout): it may land, with no ticket to follow here. */
  const [lost, setLost] = useState<'save' | 'remove' | null>(null);
  const unsure = unsureRemove || unsureSave || lost !== null;
  const active = unsureRemove ? remove : save;
  const [checking, setChecking] = useState(false);
  // From the tap until the engine answers with a ticket: a second tap would send a second write.
  const [sending, setSending] = useState(false);
  const sendingNow = useRef(false);
  const busy = sending || save.status === 'pending' || remove.status === 'pending' || closing;
  const locked = busy || unsure;

  const errors = useMemo(() => validate(form, info), [form, info]);
  const valid = Object.keys(errors).length === 0 && form.name.trim() !== '';
  const patch = useMemo(() => patchOf(initial, form), [initial, form]);
  const canSave = valid && !locked && (!editing || Object.keys(patch).length > 0);

  const createdBlogId = createdId(create.ticket);
  const saveStatus = save.status;
  useEffect(() => {
    if (saveStatus !== 'confirmed') return;
    if (editing) {
      toast.success('Blog saved');
      router.back();
    } else if (createdBlogId) {
      router.replace({ pathname: '/blog/[id]', params: { id: createdBlogId } });
    } else {
      router.replace('/blogs/mine');
    }
  }, [saveStatus, editing, createdBlogId]);

  const removeStatus = remove.status;
  useEffect(() => {
    if (removeStatus !== 'confirmed') return;
    toast.success('Blog deleted');
    router.dismissTo('/blogs');
  }, [removeStatus]);

  const onSave = () => {
    if (!canSave || sendingNow.current) return;
    sendingNow.current = true;
    setSending(true);
    const sent = editing ? update.send({ blogId, input: patch }) : create.send({ input: inputOf(form) });
    sent
      .then((result) => {
        if (result.status === 'unknown') setLost('save');
      })
      .catch(() => undefined)
      .finally(() => {
        sendingNow.current = false;
        setSending(false);
      });
  };

  const onCheck = () => {
    if (checking) return;
    setChecking(true);
    active
      .check()
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };

  const askDelete = () => {
    if (locked || sendingNow.current) return;
    confirmAlert({
      title: 'Delete this blog?',
      message:
        'Its posts will no longer show on the blog page or in discovery. They stay stored, and deleting the blog can’t be undone.',
      confirmText: 'Delete',
      destructive: true,
    })
      .then((confirmed) => {
        if (!confirmed || sendingNow.current) return undefined;
        sendingNow.current = true;
        setSending(true);
        return remove.send({ blogId }).then((result) => {
          if (result.status === 'unknown') setLost('remove');
        });
      })
      .catch(() => undefined)
      .finally(() => {
        sendingNow.current = false;
        setSending(false);
      });
  };

  const { theme } = form;
  const fontOptions = useMemo(() => info.fonts.map((font) => ({ value: font.id, label: font.label })), [info.fonts]);

  return (
    <Screen>
      <Stack.Screen options={{ title: editing ? 'Blog settings' : 'New blog' }} />
      <KeyboardAvoider avoidOnIOS>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-5 pb-12 pt-4" testID="blog-settings">
          {/* Always mounted, so the form's tree does not change in the render that leaves it. */}
          <View accessibilityLiveRegion="polite" collapsable={false} className="gap-1 px-4" testID="blog-settings-status">
            {unsure ? (
              <>
                <Text variant="subhead" tone="secondary">
                  {unsureRemove || lost === 'remove'
                    ? "Deleting your blog was sent but isn't confirmed yet."
                    : editing
                      ? "Your changes were sent but aren't confirmed yet."
                      : "Your blog was sent but isn't confirmed yet."}
                </Text>
                {lost === null ? (
                  <Button
                    label="Check again"
                    variant="outline"
                    size="sm"
                    loading={checking}
                    onPress={onCheck}
                    layoutStyle={{ alignSelf: 'flex-start' }}
                    testID="blog-settings-check"
                  />
                ) : null}
              </>
            ) : null}
          </View>

          <View className="gap-4 px-4">
            <TextField
              label="Name"
              value={form.name}
              onChangeText={set('name')}
              maxLength={info.limits.name}
              editable={!locked}
              testID="blog-settings-name"
            />
            <TextField
              label="Description"
              value={form.description}
              onChangeText={set('description')}
              maxLength={info.limits.description}
              multiline
              editable={!locked}
              testID="blog-settings-description"
            />
            <TextField
              label="Avatar image link"
              value={form.avatar}
              onChangeText={set('avatar')}
              error={errors.avatar}
              placeholder="https://"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!locked}
              testID="blog-settings-avatar"
            />
            <TextField
              label="Header image link"
              value={form.headerImage}
              onChangeText={set('headerImage')}
              error={errors.headerImage}
              placeholder="https://"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!locked}
              testID="blog-settings-header"
            />
            <View className="gap-1.5">
              <TextField
                label="Labels"
                value={form.labels}
                onChangeText={set('labels')}
                error={errors.labels}
                placeholder="travel, food, photography"
                autoCapitalize="none"
                editable={!locked}
                autoCorrect={false}
                testID="blog-settings-labels"
              />
              <Text variant="caption" tone="secondary">
                Separate labels with commas.
              </Text>
            </View>
          </View>

          <View className={cn('border-y', tw.border)}>
            <SwitchRow
              label="Comments on new posts"
              description="You can change this on each post."
              value={form.comments}
              onValueChange={set('comments')}
              disabled={locked}
              testID="blog-settings-comments"
            />
          </View>

          <View className="gap-3">
            <Text variant="headline" tone="emphasis" accessibilityRole="header" className="px-4">
              Look
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-3 px-4" testID="blog-settings-presets">
              {info.presets.map((preset) => (
                <PresetCard
                  key={preset.id}
                  preset={preset}
                  selected={JSON.stringify(preset.theme.colors) === JSON.stringify(theme.colors)}
                  disabled={locked}
                  onSelect={() => set('theme')(preset.theme)}
                />
              ))}
            </ScrollView>
            <View>
              <Text variant="subheadStrong" className="px-4">
                Heading font
              </Text>
              <FilterChips
                options={fontOptions}
                value={theme.fonts.heading}
                onChange={(id) => set('theme')({ ...theme, fonts: { ...theme.fonts, heading: id } })}
                testID="blog-settings-heading-font"
              />
            </View>
            <View>
              <Text variant="subheadStrong" className="px-4">
                Body font
              </Text>
              <FilterChips
                options={fontOptions}
                value={theme.fonts.body}
                onChange={(id) => set('theme')({ ...theme, fonts: { ...theme.fonts, body: id } })}
                testID="blog-settings-body-font"
              />
            </View>
            <View className="gap-1.5 px-4">
              <Text variant="subheadStrong">Header style</Text>
              <SegmentedControl
                options={HEADER_STYLES}
                value={theme.headerStyle}
                onChange={(headerStyle) => set('theme')({ ...theme, headerStyle })}
                testID="blog-settings-header-style"
              />
            </View>
            <View className="px-4">
              <LookPreview theme={theme} name={form.name} description={form.description} />
            </View>
          </View>

          <View className="gap-3 px-4">
            <Button
              label={editing ? 'Save changes' : 'Create blog'}
              size="block"
              loading={busy}
              disabled={!canSave}
              onPress={onSave}
              testID="blog-settings-save"
            />
            {editing && info.canDeleteBlog ? (
              <Button
                label="Delete blog"
                variant="destructive"
                size="block"
                disabled={locked}
                onPress={askDelete}
                testID="blog-settings-delete"
              />
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoider>
    </Screen>
  );
}

function SignedOut({ title }: { title: string }) {
  return (
    <EmptyState
      title={title}
      icon={DocumentTextIcon}
      action={{ label: 'Sign in', onPress: () => router.push('/sign-in') }}
      testID="blog-settings-signed-out"
    />
  );
}

function Loading() {
  return (
    <View className="flex-1 items-center justify-center" testID="blog-settings-loading">
      <Spinner />
    </View>
  );
}

/** New blog (`/blogs/new`). */
export function CreateBlogScreen() {
  const { status } = useSession();
  const signedIn = status === 'signed-in';
  const info = useEngineQuery(queryKeys.blog.info, (api) => api.blogs.info());

  const startTheme = info.data?.presets[0]?.theme;
  if (info.data && startTheme && signedIn) return <BlogSettingsForm info={info.data} blog={null} startTheme={startTheme} />;
  let body;
  if (status === 'unknown') body = <Loading />;
  else if (!signedIn) body = <SignedOut title="Sign in to start a blog" />;
  else if (info.isError) {
    body = (
      <ErrorState
        message={errorMessage(info.error)}
        onRetry={() => {
          info.refetch().catch(() => undefined);
        }}
        retrying={info.isRetrying}
      />
    );
  } else if (info.data) body = <EmptyState title="Blogs aren't available right now" icon={NoSymbolIcon} />;
  else body = <Loading />;
  return (
    <Screen>
      <Stack.Screen options={{ title: 'New blog' }} />
      {body}
    </Screen>
  );
}

/** Blog settings (`/blog/[id]/settings`): the owner edits the details and the look, or deletes the blog. */
export function EditBlogScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { status, identityId } = useSession();
  const signedIn = status === 'signed-in';
  const info = useEngineQuery(queryKeys.blog.info, (api) => api.blogs.info());
  // The owner's copy: a blog the moderators hid still opens with its real details (blog v10).
  const blog = useEngineQuery(queryKeys.blog.manage(id), (api) => api.blogs.manage(id), { enabled: id !== '' && signedIn });

  const owned = blog.data && blog.data.ownerId === identityId ? blog.data : null;
  // Kept once the form has opened: deleting the blog makes the read come back empty in the render
  // that leaves, and the form must not be swapped out under a screen Android is animating away.
  const [kept, setKept] = useState<BlogDTO | null>(null);
  if (owned && kept === null) setKept(owned);
  const shown = owned ?? (kept?.id === id ? kept : null);
  const startTheme = info.data?.presets[0]?.theme;
  if (signedIn && info.data && startTheme && shown) {
    return <BlogSettingsForm info={info.data} blog={shown} startTheme={startTheme} />;
  }
  let body;
  if (status === 'unknown') body = <Loading />;
  else if (!signedIn) body = <SignedOut title="Sign in to edit your blog" />;
  else if (info.isError || blog.isError) {
    body = (
      <ErrorState
        message={errorMessage(info.error ?? blog.error)}
        onRetry={() => {
          Promise.all([info.refetch(), blog.refetch()]).catch(() => undefined);
        }}
        retrying={info.isRetrying || blog.isRetrying}
      />
    );
  } else if (blog.data === null) body = <EmptyState title="This blog no longer exists" icon={NoSymbolIcon} />;
  else if (blog.data && blog.data.ownerId !== identityId) {
    body = <EmptyState title="You can only edit your own blogs" icon={NoSymbolIcon} testID="blog-settings-not-owner" />;
  } else body = <Loading />;
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Blog settings' }} />
      {body}
    </Screen>
  );
}
