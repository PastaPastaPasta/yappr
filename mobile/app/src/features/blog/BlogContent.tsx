import { Image } from 'expo-image';
import { Fragment, memo, type ReactNode } from 'react';
import { Pressable, Text as RNText, View, type TextStyle } from 'react-native';
import { PlayIcon } from 'react-native-heroicons/solid';

import { openExternal } from '~/features/post/post-navigation';
import { useMediaUrls } from '~/ui/media-url';
import { MIN_TARGET, monoFont } from '~/ui/tokens';

import {
  blocksOf,
  footnotesOf,
  headingLevel,
  headingLinks,
  inlineRuns,
  simpleTableCells,
  tableCells,
  type HeadingLink,
  type InlineRun,
  type RawBlock,
} from './blocks';
import type { BlogPalette } from './blog-theme';

/**
 * A post's BlockNote content, natively (web's read-only `BlogViewer` with
 * `blocknote-schema.tsx`'s custom blocks). Each top-level block is one row of
 * the post screen's virtualized list (`contentModel`, `BlogBlock`), so a long
 * post only mounts the blocks near the screen.
 */

/** What every block draws with. */
interface BlockStyle {
  palette: BlogPalette;
  bodyFont: TextStyle;
  headingFont: TextStyle;
  /** The reader's text size (1 = the base 17 pt). */
  scale: number;
  /** The table of contents a `tableOfContents` block lists. */
  toc: readonly HeadingLink[];
  /** A table of contents entry was tapped, by `headingLinks` index. */
  onJumpToHeading: (index: number) => void;
}

/** One top-level block, as a row. */
export interface BlockRow {
  key: string;
  block: RawBlock;
  /** The block's number when it is a numbered list item (1, 2, ...), else 0. */
  number: number;
}

interface BlogContentModel {
  rows: BlockRow[];
  toc: HeadingLink[];
  footnotes: string[];
  /** `headingLinks` index (the nth top-level heading) to its row, for the table of contents. */
  headingRows: number[];
}

/** A list of sibling blocks: numbered items count up until another kind breaks the run. */
function listNumbers(list: readonly RawBlock[]): number[] {
  return list.reduce<number[]>((acc, block, index) => {
    acc.push(block.type === 'numberedListItem' ? (index > 0 ? acc[index - 1] : 0) + 1 : 0);
    return acc;
  }, []);
}

/** The rows of a post's content, its table of contents and its footnotes. Footnote blocks draw nothing in place. */
export function contentModel(blocks: readonly RawBlock[]): BlogContentModel {
  const numbers = listNumbers(blocks);
  const rows: BlockRow[] = [];
  const headingRows: number[] = [];
  blocks.forEach((block, index) => {
    if (block.type === 'footnote') return;
    if (block.type === 'heading') headingRows.push(rows.length);
    rows.push({ key: `${index}:${String(block.id ?? '')}`, block, number: numbers[index] });
  });
  return { rows, toc: headingLinks(blocks), footnotes: footnotesOf(blocks), headingRows };
}

const HEADING_SIZES: Record<number, number> = { 1: 28, 2: 23, 3: 20, 4: 18, 5: 17, 6: 17 };
const CALLOUT_LABELS: Record<string, string> = { info: 'Info', warning: 'Warning', tip: 'Tip', note: 'Note' };
const SPACER_HEIGHTS: Record<string, number> = { small: 16, medium: 32, large: 64 };

/** `extractYouTubeVideoId` for the URL shapes BlockNote stores. */
export function youTubeId(url: string): string | null {
  const match = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(url);
  return match ? match[1] : null;
}

function Inline({ content, palette, style, header = false }: { content: unknown; palette: BlogPalette; style: TextStyle; header?: boolean }) {
  const urls = useMediaUrls();
  const runs = inlineRuns(content);
  // iOS (RN 0.86, Fabric) draws a paragraph of several differently styled spans with a fixed
  // line height past its right edge and clips its last lines; such a paragraph keeps the
  // font's own leading.
  const outer = runs.length > 1 ? { ...style, lineHeight: undefined } : style;
  return (
    <RNText style={outer} accessibilityRole={header ? 'header' : undefined}>
      {runs.map((run: InlineRun, index) => {
        const runStyle: TextStyle = {
          ...(run.bold ? { fontWeight: '700' } : {}),
          ...(run.italic ? { fontStyle: 'italic' } : {}),
          ...(run.code ? { ...monoFont, backgroundColor: palette.surface } : {}),
          ...(run.underline || run.href ? { textDecorationLine: run.strike ? 'underline line-through' : 'underline' } : run.strike ? { textDecorationLine: 'line-through' } : {}),
          ...(run.href ? { color: palette.link } : {}),
        };
        const href = run.href !== undefined ? urls.external(run.href) : null;
        return (
          <RNText
            key={index}
            style={runStyle}
            onPress={href ? () => openExternal(href) : undefined}
            accessibilityRole={href ? 'link' : undefined}
          >
            {run.text}
          </RNText>
        );
      })}
    </RNText>
  );
}

function ImageBlock({ url, caption, palette, scale }: { url: string; caption: string; palette: BlogPalette; scale: number }) {
  const urls = useMediaUrls();
  const source = urls.media(url);
  if (!source) return null;
  return (
    <View className="gap-2">
      <Image
        source={{ uri: source }}
        style={{ width: '100%', aspectRatio: 16 / 10, borderRadius: 12, backgroundColor: palette.surface }}
        contentFit="contain"
        accessibilityLabel={caption || 'Image'}
        accessibilityIgnoresInvertColors
      />
      {caption ? <RNText style={{ color: palette.muted, fontSize: 14 * scale, textAlign: 'center' }}>{caption}</RNText> : null}
    </View>
  );
}

function MediaLink({ url, label, palette, scale }: { url: string; label: string; palette: BlogPalette; scale: number }) {
  const urls = useMediaUrls();
  const href = urls.external(url);
  const videoId = youTubeId(url);
  const thumb = videoId ? urls.media(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`) : undefined;
  if (!href) return <RNText style={{ color: palette.muted, fontSize: 14 * scale }}>This {label.toLowerCase()} isn’t available.</RNText>;
  return (
    <Pressable
      onPress={() => openExternal(href)}
      accessibilityRole="link"
      accessibilityLabel={`Open ${label.toLowerCase()}`}
      style={{ minHeight: MIN_TARGET, borderRadius: 12, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, overflow: 'hidden' }}
    >
      {thumb ? (
        <View>
          <Image source={{ uri: thumb }} style={{ width: '100%', aspectRatio: 16 / 9 }} contentFit="cover" accessibilityIgnoresInvertColors />
          <View className="absolute inset-0 items-center justify-center">
            <View className="h-14 w-14 items-center justify-center rounded-full bg-red-600">
              <PlayIcon size={28} color="#ffffff" />
            </View>
          </View>
        </View>
      ) : null}
      <RNText style={{ color: palette.link, fontSize: 15 * scale, padding: 12 }} numberOfLines={1}>
        {videoId ? 'Watch on YouTube' : `${label}: ${url}`}
      </RNText>
    </Pressable>
  );
}

function Table({ rows, palette, scale }: { rows: string[][]; palette: BlogPalette; scale: number }) {
  if (rows.length === 0) return null;
  return (
    <View style={{ borderWidth: 1, borderColor: palette.border, borderRadius: 8, overflow: 'hidden' }} accessibilityRole="summary">
      {rows.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row', borderTopWidth: r === 0 ? 0 : 1, borderColor: palette.border, backgroundColor: r === 0 ? palette.surface : undefined }}>
          {row.map((cell, c) => (
            <RNText key={c} style={{ flex: 1, padding: 8, color: palette.text, fontSize: 14 * scale, fontWeight: r === 0 ? '600' : '400', borderLeftWidth: c === 0 ? 0 : 1, borderColor: palette.border }}>
              {cell}
            </RNText>
          ))}
        </View>
      ))}
    </View>
  );
}

/** A list of sibling blocks, below a block or a row. */
function renderList(list: readonly RawBlock[], prefix: string, depth: number, style: BlockStyle): ReactNode[] {
  const numbers = listNumbers(list);
  return list.map((block, index) => renderBlock(block, `${prefix}${String(block.id ?? index)}`, depth, numbers[index], style));
}

function renderBlock(block: RawBlock, key: string, depth: number, number: number, style: BlockStyle): ReactNode {
  const { palette, bodyFont, headingFont, scale, toc, onJumpToHeading } = style;
  const body: TextStyle = { ...bodyFont, color: palette.text, fontSize: 17 * scale, lineHeight: 28 * scale };
  const type = block.type ?? 'paragraph';
  const props = block.props ?? {};
  const children = Array.isArray(block.children) && block.children.length > 0 ? (
    <View style={{ marginLeft: 20, gap: 8 }}>{renderList(blocksOf(block.children), `${key}.`, depth + 1, style)}</View>
  ) : null;
  const align = props.textAlignment === 'center' || props.textAlignment === 'right' || props.textAlignment === 'justify' ? { textAlign: props.textAlignment } as TextStyle : {};

  switch (type) {
    case 'heading': {
      const level = headingLevel(block);
      return (
        <View key={key}>
          <Inline
            header
            content={block.content}
            palette={palette}
            style={{ ...headingFont, ...align, color: palette.heading, fontSize: HEADING_SIZES[level] * scale, lineHeight: HEADING_SIZES[level] * 1.3 * scale, fontWeight: '700', marginTop: 8 }}
          />
          {children}
        </View>
      );
    }
    case 'bulletListItem':
    case 'numberedListItem':
    case 'checkListItem':
    case 'toggleListItem': {
      const marker = type === 'numberedListItem' ? `${number}.` : type === 'checkListItem' ? (props.checked === true ? '☑' : '☐') : type === 'toggleListItem' ? '▸' : '•';
      return (
        <View key={key}>
          <View style={{ flexDirection: 'row', gap: 8 }} accessibilityLabel={type === 'checkListItem' ? (props.checked === true ? 'Done' : 'Not done') : undefined}>
            <RNText style={{ ...body, minWidth: 20, color: palette.muted }}>{marker}</RNText>
            <View style={{ flex: 1 }}>
              <Inline content={block.content} palette={palette} style={body} />
            </View>
          </View>
          {children}
        </View>
      );
    }
    case 'quote':
      return (
        <View key={key} style={{ borderLeftWidth: 4, borderLeftColor: palette.accent, paddingLeft: 14, paddingVertical: 4 }}>
          <Inline content={block.content} palette={palette} style={{ ...body, fontStyle: 'italic' }} />
          {children}
        </View>
      );
    case 'codeBlock': {
      const code = typeof props.code === 'string' ? props.code : inlineRuns(block.content).map((run) => run.text).join('');
      return (
        <View key={key} style={{ backgroundColor: '#0b1020', borderRadius: 10, padding: 14 }} accessibilityLabel={`Code, ${String(props.language ?? '')}`}>
          <RNText selectable style={{ ...monoFont, color: '#e5e7eb', fontSize: 14 * scale, lineHeight: 20 * scale }}>{code}</RNText>
        </View>
      );
    }
    case 'image':
      return <ImageBlock key={key} url={String(props.url ?? '')} caption={String(props.caption ?? '')} palette={palette} scale={scale} />;
    case 'video':
    case 'videoEmbed':
      return <MediaLink key={key} url={String(props.url ?? '')} label="Video" palette={palette} scale={scale} />;
    case 'audio':
      return <MediaLink key={key} url={String(props.url ?? '')} label="Audio" palette={palette} scale={scale} />;
    case 'file':
      return <MediaLink key={key} url={String(props.url ?? '')} label={String(props.name || 'File')} palette={palette} scale={scale} />;
    case 'divider':
      return <View key={key} style={{ height: 1, backgroundColor: palette.border, marginVertical: 12 }} accessibilityRole="none" />;
    case 'spacer':
      return <View key={key} style={{ height: SPACER_HEIGHTS[String(props.size)] ?? 32 }} />;
    case 'tableOfContents':
      return toc.length === 0 ? null : (
        <View key={key} accessibilityRole="menu" accessibilityLabel="Table of contents" style={{ borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, borderRadius: 10, padding: 12, gap: 2 }}>
          <RNText style={{ color: palette.muted, fontSize: 12, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' }}>Table of contents</RNText>
          {toc.map((heading) => (
            <Pressable
              key={heading.index}
              onPress={() => onJumpToHeading(heading.index)}
              accessibilityRole="link"
              style={{ minHeight: MIN_TARGET, justifyContent: 'center', paddingLeft: (heading.level - 1) * 12 }}
            >
              <RNText style={{ color: palette.link, fontSize: 15 * scale }}>{heading.text}</RNText>
            </Pressable>
          ))}
        </View>
      );
    case 'callout': {
      const variant = String(props.variant ?? 'info');
      return (
        <View key={key} style={{ borderWidth: 1, borderColor: palette.accent, backgroundColor: palette.surface, borderRadius: 12, padding: 12, gap: 6 }}>
          <RNText style={{ color: palette.accent, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 }}>
            {String(props.title || CALLOUT_LABELS[variant] || 'Info')}
          </RNText>
          <Inline content={block.content} palette={palette} style={{ ...body, fontSize: 15 * scale, lineHeight: 24 * scale }} />
        </View>
      );
    }
    case 'backgroundSection':
      return (
        <View key={key} style={{ backgroundColor: '#0f172a', borderRadius: 12, padding: 20 }}>
          <Inline content={block.content} palette={{ ...palette, link: '#7dd3fc', surface: '#1e293b' }} style={{ ...body, color: '#f1f5f9', fontSize: 15 * scale }} />
        </View>
      );
    case 'columnLayout': {
      const parts = inlineRuns(block.content).map((run) => run.text).join('').split('|').map((part) => part.trim());
      return (
        <View key={key} style={{ gap: 12 }}>
          {parts.filter(Boolean).map((part, index) => <RNText key={index} style={body}>{part}</RNText>)}
        </View>
      );
    }
    case 'simpleTable':
      return <Table key={key} rows={simpleTableCells(props)} palette={palette} scale={scale} />;
    case 'table':
      return <Table key={key} rows={tableCells(block.content)} palette={palette} scale={scale} />;
    case 'footnote':
      return null;
    default:
      return (
        <Fragment key={key}>
          <Inline content={block.content} palette={palette} style={{ ...body, ...align }} />
          {children}
        </Fragment>
      );
  }
}

/** One top-level block of a post. Draws nothing for a block that has nothing to show. */
export const BlogBlock = memo(function BlogBlock({ row, ...style }: { row: BlockRow } & BlockStyle) {
  const node = renderBlock(row.block, row.key, 0, row.number, style);
  // `gap` for a paragraph and the blocks nested under it, which come back as siblings.
  return node ? <View style={{ paddingBottom: 14, gap: 14 }}>{node}</View> : null;
});

/** The footnotes under a post, numbered in order. */
export const BlogFootnotes = memo(function BlogFootnotes({ notes, palette, scale }: { notes: readonly string[]; palette: BlogPalette; scale: number }) {
  return (
    <View style={{ borderTopWidth: 1, borderColor: palette.border, paddingTop: 16, marginTop: 8, marginBottom: 16, gap: 6 }}>
      <RNText style={{ color: palette.muted, fontSize: 12, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' }}>Footnotes</RNText>
      {notes.map((note, index) => (
        <RNText key={index} style={{ color: palette.muted, fontSize: 14 * scale }}>{`${index + 1}. ${note}`}</RNText>
      ))}
    </View>
  );
});
