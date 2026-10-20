import { Image } from 'expo-image';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, TextInput, View, type TextStyle } from 'react-native';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChatBubbleBottomCenterTextIcon,
  CodeBracketIcon,
  ListBulletIcon,
  MinusIcon,
  PhotoIcon,
  QueueListIcon,
  TrashIcon,
} from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { showActionSheet } from '~/ui/action-sheet';
import { IconButton } from '~/ui/IconButton';
import { useMediaUrls } from '~/ui/media-url';
import { Text } from '~/ui/Text';
import { MIN_TARGET, monoFont, tw, useColors } from '~/ui/tokens';

import {
  LOCKED_BLOCK_NAMES,
  newEditorBlock,
  wrapSelection,
  type EditableKind,
  type EditorBlock,
} from './blocks';

/**
 * The native post editor's blocks (UX: one block per row, a type button, a
 * formatting bar for the focused text, and a row of "add" buttons). It saves
 * the web's BlockNote format through `fromEditorBlocks`.
 */

const KIND_LABELS: Record<string, string> = {
  paragraph: 'Text',
  heading: 'Heading',
  bulletListItem: 'Bulleted list',
  numberedListItem: 'Numbered list',
  checkListItem: 'Checklist',
  quote: 'Quote',
  codeBlock: 'Code',
};

const TEXT_STYLE: Partial<Record<EditableKind, TextStyle>> = {
  heading: { fontSize: 22, fontWeight: '700' },
  quote: { fontStyle: 'italic' },
  codeBlock: { ...monoFont, fontSize: 14 },
};



/** A letter in place of an icon (heroicons has none for text or headings). */
const letterIcon = (letter: string) =>
  function LetterIcon({ size = 20, color }: { size?: number | string; color?: string }) {
    return <Text style={{ fontSize: Number(size) * 0.8, color, fontWeight: '700' }}>{letter}</Text>;
  };
const Bars = letterIcon('T');
const HashIcon = letterIcon('H');

const ADD_BUTTONS: { kind: EditableKind; label: string; Icon: (props: { size?: number; color?: string }) => ReactNode }[] = [
  { kind: 'paragraph', label: 'Text', Icon: Bars },
  { kind: 'heading', label: 'Heading', Icon: HashIcon },
  { kind: 'bulletListItem', label: 'List', Icon: ListBulletIcon },
  { kind: 'quote', label: 'Quote', Icon: ChatBubbleBottomCenterTextIcon },
  { kind: 'image', label: 'Image', Icon: PhotoIcon },
  { kind: 'codeBlock', label: 'Code', Icon: CodeBracketIcon },
  { kind: 'divider', label: 'Divider', Icon: MinusIcon },
  { kind: 'tableOfContents', label: 'Contents', Icon: QueueListIcon },
];

/** The type picker for a text block. */
function chooseKind(block: EditorBlock, onChange: (patch: Partial<EditorBlock>) => void) {
  showActionSheet({
    title: 'Block type',
    actions: [
      { label: 'Text', onPress: () => onChange({ kind: 'paragraph' }) },
      { label: 'Heading 1', onPress: () => onChange({ kind: 'heading', level: 1 }) },
      { label: 'Heading 2', onPress: () => onChange({ kind: 'heading', level: 2 }) },
      { label: 'Heading 3', onPress: () => onChange({ kind: 'heading', level: 3 }) },
      { label: 'Bulleted list', onPress: () => onChange({ kind: 'bulletListItem' }) },
      { label: 'Numbered list', onPress: () => onChange({ kind: 'numberedListItem' }) },
      { label: 'Checklist', onPress: () => onChange({ kind: 'checkListItem', checked: block.checked ?? false }) },
      { label: 'Quote', onPress: () => onChange({ kind: 'quote' }) },
    ],
  });
}

interface RowProps {
  block: EditorBlock;
  index: number;
  count: number;
  /** Numbered list items: the number shown. */
  number: number;
  editable: boolean;
  onChange: (key: string, patch: Partial<EditorBlock>) => void;
  onMove: (key: string, by: -1 | 1) => void;
  onRemove: (key: string) => void;
  onFocus: (key: string) => void;
  onSelection: (key: string, selection: { start: number; end: number }) => void;
  onSubmitLine: (key: string) => void;
}

const BlockRow = memo(function BlockRow({ block, index, count, number, editable, onChange, onMove, onRemove, onFocus, onSelection, onSubmitLine }: RowProps) {
  const c = useColors();
  const urls = useMediaUrls();
  const set = (patch: Partial<EditorBlock>) => onChange(block.key, patch);
  const label = block.kind === 'locked'
    ? LOCKED_BLOCK_NAMES[block.original?.type ?? ''] ?? 'Block'
    : block.kind === 'heading'
      ? `Heading ${block.level ?? 2}`
      : KIND_LABELS[block.kind] ?? (block.kind === 'image' ? 'Image' : block.kind === 'divider' ? 'Divider' : 'Table of contents');
  const textKind = block.kind in KIND_LABELS && block.kind !== 'codeBlock';
  const inputStyle: TextStyle = { color: c.textPrimary, fontSize: 17, lineHeight: 24, minHeight: MIN_TARGET, paddingVertical: 8, ...(TEXT_STYLE[block.kind as EditableKind] ?? {}) };

  let body;
  if (block.kind === 'locked') {
    body = (
      <View className={cn('gap-1 rounded-xl border border-dashed p-3', tw.border)}>
        {block.text ? <Text variant="subhead" numberOfLines={3}>{block.text}</Text> : null}
        <Text variant="caption" tone="secondary">You can change this on yap.pr. It stays as it is.</Text>
      </View>
    );
  } else if (block.kind === 'image') {
    const preview = urls.media(block.url);
    body = (
      <View className="gap-2">
        <TextInput
          value={block.url}
          onChangeText={(url) => set({ url })}
          editable={editable}
          placeholder="Image link (https:// or ipfs://)"
          placeholderTextColor={c.textPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="Image link"
          style={{ ...inputStyle, borderBottomWidth: 1, borderColor: c.border }}
          testID={`blog-editor-image-url-${index}`}
        />
        {preview ? (
          <Image source={{ uri: preview }} style={{ width: '100%', aspectRatio: 16 / 10, borderRadius: 10 }} contentFit="contain" accessibilityIgnoresInvertColors />
        ) : null}
        <TextInput
          value={block.caption}
          onChangeText={(caption) => set({ caption })}
          editable={editable}
          placeholder="Caption (optional)"
          placeholderTextColor={c.textPlaceholder}
          accessibilityLabel="Image caption"
          style={{ ...inputStyle, fontSize: 15 }}
        />
      </View>
    );
  } else if (block.kind === 'divider') {
    body = <View style={{ height: 1, backgroundColor: c.border, marginVertical: 16 }} accessibilityLabel="Divider" />;
  } else if (block.kind === 'tableOfContents') {
    body = <Text variant="subhead" tone="secondary">The headings of your post will be listed here.</Text>;
  } else {
    body = (
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, ...(block.kind === 'quote' ? { borderLeftWidth: 3, borderColor: c.accent, paddingLeft: 10 } : {}) }}>
        {block.kind === 'bulletListItem' ? <Text style={{ paddingTop: 10 }}>•</Text> : null}
        {block.kind === 'numberedListItem' ? <Text style={{ paddingTop: 10 }}>{`${number}.`}</Text> : null}
        {block.kind === 'checkListItem' ? (
          <Pressable
            onPress={() => set({ checked: !block.checked })}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: block.checked === true }}
            accessibilityLabel="Done"
            style={{ width: MIN_TARGET, height: MIN_TARGET, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ fontSize: 20 }}>{block.checked ? '☑' : '☐'}</Text>
          </Pressable>
        ) : null}
        <TextInput
          value={block.text}
          onChangeText={(text) => set({ text })}
          editable={editable}
          multiline
          scrollEnabled={false}
          placeholder={block.kind === 'heading' ? 'Heading' : block.kind === 'codeBlock' ? 'Code' : 'Write something…'}
          placeholderTextColor={c.textPlaceholder}
          onFocus={() => onFocus(block.key)}
          onSelectionChange={(e) => onSelection(block.key, e.nativeEvent.selection)}
          autoCapitalize={block.kind === 'codeBlock' ? 'none' : 'sentences'}
          autoCorrect={block.kind !== 'codeBlock'}
          accessibilityLabel={label}
          style={{ flex: 1, ...inputStyle, ...(block.kind === 'codeBlock' ? { backgroundColor: c.bgMuted, borderRadius: 8, padding: 10 } : {}) }}
          onKeyPress={(e) => {
            if (e.nativeEvent.key === 'Enter' && textKind && block.kind !== 'quote') onSubmitLine(block.key);
          }}
          testID={`blog-editor-text-${index}`}
        />
      </View>
    );
  }

  return (
    <View className={cn('gap-1 border-b pb-2', tw.border)}>
      <View className="flex-row items-center">
        <Pressable
          onPress={textKind && editable ? () => chooseKind(block, set) : undefined}
          disabled={!textKind || !editable}
          accessibilityRole={textKind ? 'button' : 'text'}
          accessibilityLabel={textKind ? `${label}. Change block type` : label}
          hitSlop={8}
          style={{ minHeight: MIN_TARGET, justifyContent: 'center', flex: 1 }}
          testID={`blog-editor-kind-${index}`}
        >
          <Text variant="captionStrong" tone={textKind ? 'link' : 'secondary'}>{label}{textKind ? ' ▾' : ''}</Text>
        </Pressable>
        <IconButton icon={ArrowUpIcon} accessibilityLabel="Move up" disabled={!editable || block.kind === 'locked' || index === 0} onPress={() => onMove(block.key, -1)} iconSize={18} />
        <IconButton icon={ArrowDownIcon} accessibilityLabel="Move down" disabled={!editable || block.kind === 'locked' || index === count - 1} onPress={() => onMove(block.key, 1)} iconSize={18} />
        <IconButton icon={TrashIcon} accessibilityLabel="Remove block" variant="danger" disabled={!editable || block.kind === 'locked'} onPress={() => onRemove(block.key)} iconSize={18} testID={`blog-editor-remove-${index}`} />
      </View>
      {body}
    </View>
  );
});

export interface BlockEditorProps {
  blocks: EditorBlock[];
  onChange: (blocks: EditorBlock[]) => void;
  editable: boolean;
}

/** Each block's number in its numbered list (0 for anything else). */
function listNumbers(blocks: readonly EditorBlock[]): number[] {
  const numbers: number[] = [];
  blocks.forEach((block, index) => {
    numbers.push(block.kind === 'numberedListItem' ? (index > 0 ? numbers[index - 1] : 0) + 1 : 0);
  });
  return numbers;
}

/** The block list with its formatting bar and "add" row. */
export function BlockEditor({ blocks, onChange, editable }: BlockEditorProps) {
  const c = useColors();
  const [focused, setFocused] = useState<string | null>(null);
  const selection = useRef(new Map<string, { start: number; end: number }>());
  const latest = useRef(blocks);
  useEffect(() => {
    latest.current = blocks;
  }, [blocks]);

  const update = (next: EditorBlock[]) => {
    latest.current = next;
    onChange(next);
  };
  const change = (key: string, patch: Partial<EditorBlock>) =>
    update(latest.current.map((block) => (block.key === key ? { ...block, ...patch } : block)));
  const move = (key: string, by: -1 | 1) => {
    const list = [...latest.current];
    const at = list.findIndex((block) => block.key === key);
    const to = at + by;
    // A block the editor can't edit keeps its stored place: nothing moves past it either.
    if (at < 0 || to < 0 || to >= list.length || list[at].kind === 'locked' || list[to].kind === 'locked') return;
    [list[at], list[to]] = [list[to], list[at]];
    update(list);
  };
  const remove = (key: string) => update(latest.current.filter((block) => block.key !== key));
  const add = (kind: EditableKind, extra?: Partial<EditorBlock>) => update([...latest.current, newEditorBlock(kind, extra)]);
  /** Return at the end of a list item starts the next item, as editors do. */
  const submitLine = (key: string) => {
    const block = latest.current.find((b) => b.key === key);
    if (!block || !['bulletListItem', 'numberedListItem', 'checkListItem'].includes(block.kind)) return;
    const at = latest.current.indexOf(block);
    const list = [...latest.current];
    list.splice(at + 1, 0, newEditorBlock(block.kind as EditableKind));
    update(list);
  };
  const format = (before: string, after = before) => {
    if (!focused) return;
    const block = latest.current.find((b) => b.key === focused);
    if (!block || block.kind === 'codeBlock') return;
    const range = selection.current.get(focused) ?? { start: block.text.length, end: block.text.length };
    change(focused, { text: wrapSelection(block.text, range, before, after).text });
  };

  const numbers = listNumbers(blocks);
  const focusedBlock = blocks.find((b) => b.key === focused);
  const formatting = editable && focusedBlock && focusedBlock.kind in KIND_LABELS && focusedBlock.kind !== 'codeBlock';
  return (
    <View className="gap-2">
      {blocks.map((block, index) => {
        return (
          <BlockRow
            key={block.key}
            block={block}
            index={index}
            count={blocks.length}
            number={numbers[index]}
            editable={editable}
            onChange={change}
            onMove={move}
            onRemove={remove}
            onFocus={setFocused}
            onSelection={(key, range) => selection.current.set(key, range)}
            onSubmitLine={submitLine}
          />
        );
      })}
      {formatting ? (
        <View className={cn('flex-row items-center gap-1 rounded-xl border px-1', tw.border)} accessibilityLabel="Formatting">
          <FormatButton label="B" a11y="Bold" style={{ fontWeight: '800' }} onPress={() => format('**')} />
          <FormatButton label="I" a11y="Italic" style={{ fontStyle: 'italic' }} onPress={() => format('*')} />
          <FormatButton label="</>" a11y="Code" style={monoFont} onPress={() => format('`')} />
          <FormatButton label="Link" a11y="Add a link" onPress={() => format('[', '](https://)')} />
          <Text variant="caption" tone="secondary" className="flex-1 text-right pr-2" numberOfLines={1}>
            Select text, then tap a style
          </Text>
        </View>
      ) : null}
      {editable ? (
        <View className="flex-row flex-wrap gap-2 pt-2" accessibilityLabel="Add a block">
          {ADD_BUTTONS.map(({ kind, label, Icon }) => (
            <Pressable
              key={kind}
              onPress={() => add(kind)}
              accessibilityRole="button"
              accessibilityLabel={`Add ${label.toLowerCase()}`}
              className={cn('flex-row items-center gap-1.5 rounded-full border px-3', tw.border)}
              style={{ minHeight: MIN_TARGET }}
              testID={`blog-editor-add-${kind}`}
            >
              <Icon size={18} color={c.textSecondary} />
              <Text variant="subhead">{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function FormatButton({ label, a11y, style, onPress }: { label: string; a11y: string; style?: TextStyle; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y} style={{ minWidth: MIN_TARGET, minHeight: MIN_TARGET, alignItems: 'center', justifyContent: 'center' }} testID={`blog-editor-format-${a11y.toLowerCase().replace(/\s+/g, '-')}`}>
      <Text variant="bodyStrong" style={style}>{label}</Text>
    </Pressable>
  );
}
