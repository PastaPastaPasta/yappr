# Yappr Mobile 1.0: UX and design spec

- **Status:** draft for 1.0, 2026-10-01.
- **Binding input:** [ADR-001](ADR-001-mobile-1.0.md) (E3 UI stack, E4 navigation, E7 scope).
- **Companion:** [PRD.md](PRD.md) holds the user stories and their acceptance criteria. Story IDs (for example `FEED-05`) are referenced here; behaviour is specified there, appearance and layout here.
- **Audience:** engineers who never saw the web app. Every value here is final unless marked **[OQ-n]** (an open question in the PRD).

**How to use it.** Build tokens first (section 1), then the components (section 2) with a gallery entry each (`/__gallery`, ADR E8), then the navigation shell (section 3), then screens (section 4). Copy comes from section 5; never invent a string a screen needs without adding it there.

## Contents

1. [Design tokens](#1-design-tokens)
2. [Components](#2-components)
3. [Navigation](#3-navigation)
4. [Screens](#4-screens)
5. [Copy deck](#5-copy-deck)
6. [Accessibility](#6-accessibility)

---

## 1. Design tokens

The root `tailwind.config.js` is the source. `mobile/app/tailwind.config.js` uses it as a NativeWind preset (ADR E3), so `bg-yappr-500`, `neutral-850`, `shadow-yappr` and the gradients are literally the web's classes. The **semantic tokens** below are what components use; they are defined once in `mobile/app/src/ui/tokens.ts` and exposed as NativeWind classes (`bg-surface`, `text-secondary`, …) with light and dark values.

### 1.1 Color primitives

| Ramp | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `yappr` (brand, Tailwind sky) | `#f0f9ff` | `#e0f2fe` | `#bae6fd` | `#7dd3fc` | `#38bdf8` | **`#0ea5e9`** | `#0284c7` | `#0369a1` | `#075985` | `#0c4a6e` | `#082f49` |
| `gray` (Tailwind) | `#f9fafb` | `#f3f4f6` | `#e5e7eb` | `#d1d5db` | `#9ca3af` | `#6b7280` | `#4b5563` | `#374151` | `#1f2937` | `#111827` | `#030712` |
| `neutral` (Tailwind + web extras) | | | | | | | | | `#262626`, **750 `#323232`** | `#171717`, **850 `#1a1a1a`** | `#0a0a0a` |

Status colors (Tailwind): red-400 `#f87171`, red-500 `#ef4444`, red-600 `#dc2626`; green-500 `#22c55e`, green-600 `#16a34a`, green-700 `#15803d`; amber-50 `#fffbeb`, amber-400 `#fbbf24`, amber-500 `#f59e0b`, amber-700 `#b45309`, amber-950 `#451a03`; purple-500 `#a855f7`, purple-600 `#9333ea`; blue-500 `#3b82f6`; yellow-500 `#eab308`; pink-400 `#f472b6`, pink-600 `#db2777`. Payment brand colors are not used in 1.0.

### 1.2 Semantic color tokens

Contrast ratios are against the token's usual background (`bg`). PD-15 in the PRD explains the light-mode shades that differ from web.

| Token | Light | Dark | Web origin | Use |
| --- | --- | --- | --- | --- |
| `bg` | `#ffffff` | `#171717` (neutral-900) | `body` | Screen background |
| `bg.elevated` | `#ffffff` | `#171717` + 1 px `border` | modal, menu | Sheets, dialogs, menus, popovers |
| `bg.subtle` | `#f9fafb` (gray-50) | `#030712` (gray-950) | row hover | Pressed rows and cards |
| `bg.muted` | `#f3f4f6` (gray-100) | `#111827` (gray-900) | secondary button | Secondary buttons, segmented track, search field |
| `bg.skeleton` | `#e5e7eb` (gray-200) | `#1f2937` (gray-800) | `animate-pulse` bars | Skeletons, avatar placeholder |
| `bg.header` | `rgba(255,255,255,0.8)` + blur | `rgba(23,23,23,0.8)` + blur | `glass-effect` | Translucent navigation bars (iOS); Android uses `bg` solid |
| `bg.unread` | `rgba(240,249,255,0.6)` | `rgba(8,47,73,0.3)` | notification row | Unread notification rows |
| `bg.selected` | `#f0f9ff` (yappr-50) | `rgba(8,47,73,0.3)` | radio card | Selected option cards, active filter chip |
| `border` | `#e5e7eb` (gray-200) | `#1f2937` (gray-800) | `border-gray-200/800` | Dividers, card borders |
| `border.strong` | `#d1d5db` (gray-300) | `#374151` (gray-700) | outline button, quote embed | Outline buttons, inputs, embeds |
| `text.primary` | `#111827` (gray-900) 17.7:1 | `#f3f4f6` (gray-100) 16.3:1 | | Body text, names |
| `text.emphasis` | `#111827` | `#ffffff` 17.9:1 | `dark:text-white` | Titles, active tab |
| `text.secondary` | `#6b7280` (gray-500) 4.8:1 | `#9ca3af` (gray-400) 7.1:1 | `text-gray-500 dark:text-gray-400` | Handles, times, descriptions, inactive tabs |
| `text.placeholder` | `#4b5563` (gray-600) 7.6:1, 6.9:1 on `bg.muted` | `#9ca3af` | | Input and search-field placeholders (AA on both `bg` and `bg.muted`, unlike web's gray-400) |
| `text.disabled` | `#9ca3af` | `#4b5563` | | Disabled labels (exempt from contrast) |
| `text.decorative` | `#d1d5db` | `#4b5563` | counter "/" | Separators that carry no meaning |
| `text.inverse` | `#ffffff` | `#ffffff` | | Text on accent and destructive fills |
| `link` | `#0369a1` (yappr-700) 5.9:1 | `#38bdf8` (yappr-400) 8.4:1 | `text-yappr-500` | Links, mentions, hashtags, text buttons |
| `accent` | `#0ea5e9` (yappr-500) | `#0ea5e9` | `bg-yappr-500` | Fills: primary button, FAB, switch on, badge, unread dot, spinner, focus ring, pull-to-refresh tint |
| `accent.pressed` | `#0284c7` (yappr-600) | `#0284c7` | `hover:bg-yappr-600` | Pressed primary fill |
| `like` | `#dc2626` (red-600) 4.8:1 | `#ef4444` (red-500) 4.8:1 | `text-red-500` | Active heart and its count |
| `repost` | `#15803d` (green-700) 5.0:1 | `#22c55e` (green-500) 7.9:1 | `text-green-500` | Active repost icon and count |
| `destructive` | `#dc2626` (red-600) | `#f87171` (red-400) | `text-red-500` | Destructive menu items and text |
| `destructive.fill` | `#dc2626` (red-600) 4.8:1 with white | `#dc2626` | `bg-red-500` (darkened for AA) | Destructive buttons (pressed `#b91c1c`) |
| `warning` | `#b45309` (amber-700) | `#fbbf24` (amber-400) | counter | Counter at ≤ 50 left, hints |
| `error` | `#dc2626` (red-600) | `#f87171` (red-400) | counter | Counter over, field errors, byte-overflow line |
| `error.bg` | `#fef2f2` (red-50) | `rgba(69,10,10,0.3)` | error bar | Inline error banners |
| `offline.bg` | `#fffbeb` (amber-50) | `#451a03` (amber-950) | | Offline banner |
| `network.chip` | bg `#f59e0b`, text `#000000` | same | `bg-amber-500 text-black` | DEVNET / TESTNET chip |
| `nsfw.cover` | bg `#111827`, label `#f3f4f6`, text `#d1d5db`, button `#f3f4f6` on `#111827` text | bg `#030712` + border `#1f2937`, same text | `SensitiveContentGate` | NSFW cover |
| `toast` | bg `#1f2937`, text `#ffffff` | same | react-hot-toast | Toasts (theme-independent, as web) |
| `overlay` | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.5)` | `bg-black/50` | Dialog scrim |
| `overlay.sheet` | `rgba(0,0,0,0.6)` | `rgba(0,0,0,0.6)` | `bg-black/60` | Sheet scrim |
| `code` | bg `#f3f4f6`, text `#be185d` (pink-700) 5.5:1 | bg `#1f2937`, text `#f472b6` | inline code (`text-pink-600`, darkened for AA) | Inline `code` in posts |
| `private` | `#9333ea` (purple-600) | `#a855f7` (purple-500) | private-feed accents | Only the "Private post" placeholder (ADR E3: purple is reserved) |
| `bubble.own` | bg `#0ea5e9`, text `#ffffff` | same | `bg-yappr-500 text-white` | Own DM bubbles (AA exception, below) |
| `bubble.other` | bg `#f3f4f6`, text `#111827` | bg `#111827`, text `#f3f4f6` | `bg-gray-100 dark:bg-gray-900` | Others' DM bubbles |

Notification type icon colors are decorative (the phrase carries the meaning): follow purple-500, mention yellow-500, like red-500, repost and quote green-500, reply blue-500.

**OQ-2 decided (darken):** in light mode, `accent` fills that carry white text or icons use `yappr-600` `#0284c7`; dark mode keeps `yappr-500`. See PRD §11.1. The original note follows. White on `accent` (`#0ea5e9`) is 2.77:1. Every `accent` fill that carries white text or icons keeps it for brand fidelity until OQ-2 is answered: primary buttons, the FAB, count badges, the new-posts pill and own DM bubbles. If OQ-2 is answered "darken", all five move together to the chosen shade. Every other text pair above passes AA.

### 1.3 Gradients

| Token | Value | Use |
| --- | --- | --- |
| `gradient-yappr` | linear 135°, `#0ea5e9` 0% → `#0284c7` 100% | Default profile banner; the "Yappr" wordmark (`text-gradient`: left-to-right yappr-500 → yappr-600 clipped to text) |
| `gradient-dark` | linear 135°, `#1e293b` → `#0f172a` | Not used in 1.0 screens; kept in the preset |

Use `expo-linear-gradient`; for the wordmark use a masked view (`@react-native-masked-view/masked-view`) or a pre-rendered SVG wordmark.

### 1.4 Radii

| Token | Value | Web | Use |
| --- | --- | --- | --- |
| `radius.sm` | 4 | `rounded` | Inline code, small tags |
| `radius.md` | 6 | `rounded-md` | Compose toolbar buttons |
| `radius.lg` | 8 | `rounded-lg` | Inputs, toasts, list cards, menu items |
| `radius.xl` | 12 | `rounded-xl` | Quote embeds, media grid, link previews, NSFW cover, menus |
| `radius.2xl` | 16 | `rounded-2xl` | Dialogs, top corners of bottom sheets |
| `radius.full` | 9999 | `rounded-full` | Buttons, pills, chips, avatars, icon buttons, badges |

### 1.5 Shadows and elevation

React Native 0.86 (Expo SDK 57 ships 0.86.3) with the New Architecture supports the CSS `boxShadow` style on iOS and Android (API 28+), so web values are used verbatim. Below Android API 28, fall back to `elevation`. In dark mode black shadows are invisible; elevated surfaces add a 1 px `border` instead (web's `dark:border` pattern). Colored yappr shadows apply in both themes.

| Token | `boxShadow` (same as web) | Android < 28 `elevation` | Use |
| --- | --- | --- | --- |
| `shadow-sm` | `0 1px 2px 0 rgba(0,0,0,0.05)` | 1 | Switch thumb, small chips |
| `shadow` | `0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)` | 2 | Cards |
| `shadow-lg` | `0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)` | 8 | Menus, popovers, toasts, new-posts pill |
| `shadow-xl` | `0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)` | 12 | Dialogs |
| `shadow-yappr` | `0 4px 20px -4px rgba(14,165,233,0.5)` | 4 | Primary buttons (default and lg sizes) |
| `shadow-yappr-lg` | `0 10px 40px -10px rgba(14,165,233,0.4)` | 6 | FAB, primary CTA on Welcome |

Native sheets and context menus (iOS `UIContextMenu`, `UISheetPresentationController`; Android Material bottom sheets) keep their system shadows.

### 1.6 Typography

System fonts: SF Pro (iOS), Roboto (Android), matching web's `-apple-system … Roboto` stack. Monospace: SF Mono / `monospace` (Roboto Mono), for identity IDs, balances and the diagnostics screen. Sizes are pt (iOS) / sp (Android) at the default text size and scale with Dynamic Type and font scale (section 6).

| Token | Size / line height | Weight | Web class | Use |
| --- | --- | --- | --- | --- |
| `caption` | 12 / 16 | 400 | `text-xs` | Counters, helper text, badges, chips, write-status row, toast secondary |
| `caption.strong` | 12 / 16 | 600 | `text-xs font-semibold` | Badge numbers, "NSFW" label |
| `chip` | 11 / 14, letter spacing 0.5, uppercase | 700 | banner `font-bold` | Network chip |
| `subhead` | 14 / 20 | 400 | `text-sm` | Handles, times, list secondary lines, settings descriptions, menu items, toasts |
| `subhead.strong` | 14 / 20 | 600 | `text-sm font-semibold` | Author names in cards, tab labels in segmented controls |
| `button` | 15 / 20 | 600 | `text-sm font-medium` (bumped for touch) | Button labels (default, lg) |
| `button.sm` | 13 / 16 | 600 | `text-xs` | Small buttons (follow in rows, Show) |
| `body` | 16 / 24 | 400 | base | Post text, inputs, list primary text, DM bubbles |
| `body.strong` | 16 / 24 | 600 | | List titles, settings row labels |
| `body.large` | 17 / 26 | 400 | compose canvas 17 / 1.7 | Compose editor, focused post on detail |
| `headline` | 18 / 28 | 600 | `text-lg` | Sheet titles, section headers, dialog titles |
| `title` | 20 / 28 | 700 | `text-xl font-bold` | Inline page titles (Android top app bar, iOS when not large), empty-state titles (600) |
| `title.profile` | 20 / 28 | 800 | `text-xl font-extrabold` | Profile display name |
| `title.large` | 24 / 32 | 700 | `text-2xl` | Welcome subheads, Lockdown title |
| `largeTitle` | 34 / 41 | 700 | iOS native | iOS large titles (native, not custom) |
| `wordmark` | 48 / 52 | 800, gradient | "Yappr" | Welcome, sign-in header |

Rules: post text is never bold except Markdown `**bold**` (700). Italic only from Markdown. Numbers in counters and balances use tabular figures (`fontVariant: ['tabular-nums']`).

### 1.7 Spacing and layout

4-pt base, Tailwind names: `0.5`=2, `1`=4, `1.5`=6, `2`=8, `2.5`=10, `3`=12, `4`=16, `5`=20, `6`=24, `8`=32, `10`=40, `12`=48, `16`=64.

| Constant | Value | Web origin |
| --- | --- | --- |
| Screen gutter | 16 | `px-4` |
| Post card padding | 16 horizontal, 12 top, 4 bottom | `px-4 pt-3 pb-1` |
| Post card avatar column | 48 avatar + 12 gap | `gap-3`, avatar lg |
| Repost banner indent | aligned with the text column (avatar 48 + gap 12 − icon 16 − gap 4 = 40 from the gutter) | `ml-9` adjusted for 48 avatar |
| Action bar | full text-column width, items spaced evenly for Reply / Repost / Like, Bookmark + Share grouped at the end; max 485 | `max-w-[485px]` |
| Media grid gap / top margin | 2 / 12 | `gap-1 mt-3` (gap halved for phones) |
| List row | min height 56; 16 horizontal, 12 vertical padding | |
| User row | min height 72; avatar 40 | |
| Settings row | min height 52 (iOS inset grouped) / 56 (Android) | |
| Section spacing | 24 between groups, 8 between header and group | |
| Sheet content padding | 20 horizontal, 16 top after the grabber | |
| Dialog width | min(screen − 48, 400) | `ConfirmDialog` 400 |
| FAB | 56 diameter, 16 from the trailing edge, 16 above the tab bar | `h-14 w-14`, mobile nav FAB |
| Hit target | ≥ 44 pt / 48 dp | |

Safe areas: everything respects `react-native-safe-area-context` insets; layouts are edge to edge on Android (ADR E4).

### 1.8 Motion

| Token | Value | Web origin | Use |
| --- | --- | --- | --- |
| `duration.fast` | 150 ms | `interactive-scale` | Press feedback: scale to 0.98 and back |
| `duration.base` | 200 ms | `fade-in`, `scale-in` | Fades; dialog scale 0.95 → 1; toast in |
| `duration.slow` | 300 ms | `slide-up` / `slide-down` | 10 px slide plus fade for pills and banners |
| `pulse` | 2000 ms loop, opacity 1 → 0.5 → 1, `cubic-bezier(0.4,0,0.6,1)` | `pulse-soft` / `animate-pulse` | Skeletons, booting dot |
| `easing.out` | `cubic-bezier(0,0,0.2,1)` | Tailwind `ease-out` | Entrances |
| `easing.inOut` | `cubic-bezier(0.4,0,0.2,1)` | Tailwind default | Exits, color changes |
| `spring.like` | Reanimated `withSpring`, damping 12, stiffness 400, mass 0.6; scale 1 → 0.8 → 1 | framer spring on the heart | Like tap |
| `spring.pill` | damping 18, stiffness 220 | | New-posts pill in and out |
| Native transitions | system defaults | | Stack push, modal, sheets, context menus |

**Reduce Motion** (iOS setting, Android "Remove animations"): springs and slides become a 150 ms crossfade or nothing; the like heart changes color only; skeletons stop pulsing; programmatic scrolls jump.

### 1.9 Haptics

`expo-haptics` on both platforms. The OS setting for system haptics turns them off automatically.

| Event | Call |
| --- | --- |
| Like (on only) | `impactAsync(Light)` |
| Repost or undo repost succeeded optimistically | `impactAsync(Medium)` |
| Follow | `impactAsync(Light)` |
| Post, reply, quote sent (compose closes) | `notificationAsync(Success)` |
| DM sent | `impactAsync(Light)` |
| Any write failed (with the error toast) | `notificationAsync(Error)` |
| Segmented control, filter chip, window toggle change | `selectionAsync()` |
| Copy to clipboard | `selectionAsync()` |
| Biometric unlock failed | `notificationAsync(Error)` |
| Pull to refresh, context menus, switches, tab bar | Native behaviour only; no extra call |

### 1.10 Icons

Heroicons v2 via `react-native-heroicons` (ADR E3): `outline` 24 by default, `solid` when active (tab bar, liked heart, reposted, bookmarked). Sizes: 28 in the tab bar (web bottom nav), 20 in the action bar, 24 in navigation bars, 16 inline with text. Stroke color follows the text token of its context.

| Meaning | Icon (outline / solid) |
| --- | --- |
| Home | `HomeIcon` |
| Explore | `MagnifyingGlassIcon` |
| Notifications | `BellIcon` |
| Messages | `EnvelopeIcon` |
| Profile | `UserIcon` |
| Compose (FAB) | `PlusIcon` (web mobile FAB), the same on both platforms |
| Reply | `ChatBubbleOvalLeftIcon` |
| Repost | `ArrowPathIcon` (web action bar) |
| Like | `HeartIcon` |
| Bookmark | `BookmarkIcon` |
| Share | `ArrowUpTrayIcon` (iOS) / `ShareIcon` (Android) |
| More | `EllipsisHorizontalIcon` |
| Delete | `TrashIcon` |
| Block | `NoSymbolIcon` |
| Report | `FlagIcon` |
| NSFW | `EyeSlashIcon` |
| Media gate | `PhotoIcon` |
| Private | `LockClosedIcon` |
| Removed stub | `ShieldExclamationIcon`; deleted `TrashIcon`; failed `ExclamationTriangleIcon` |
| Settings | `Cog6ToothIcon` |
| Offline | `WifiIcon` with a slash overlay (`SignalSlashIcon`) |

### 1.11 States

| State | Treatment |
| --- | --- |
| Pressed | Rows and cards: `bg.subtle`. Buttons: `duration.fast` scale 0.98 plus the pressed fill. Android adds the ripple (`android_ripple`, color `rgba(0,0,0,0.08)` light / `rgba(255,255,255,0.08)` dark). |
| Disabled | 50% opacity (web `disabled:opacity-50`), no press feedback, `accessibilityState.disabled`. |
| Focused (hardware keyboard, switch access) | 2 pt `accent` ring, 2 pt offset (web `focus-visible:ring-2`). |
| Loading in a button | The label is replaced by a 16 pt spinner in the label color; the width does not change. |

---

## 2. Components

Each component lives in `mobile/app/src/ui/` and has a gallery entry showing every variant and state in light and dark.

### 2.1 Button

| Variant | Fill | Label | Border | Shadow | Pressed |
| --- | --- | --- | --- | --- | --- |
| `primary` | `accent` | `text.inverse` | — | `shadow-yappr` | `accent.pressed` |
| `secondary` | `bg.muted` | `text.primary` | — | — | gray-200 / gray-800 |
| `outline` | transparent | `text.primary` | 1 px `border.strong` | — | `bg.muted` |
| `ghost` | transparent | `text.primary` | — | — | `bg.muted` |
| `destructive` | `destructive.fill` | `text.inverse` | — | — | `#b91c1c` |
| `link` | transparent | `link` | — | — | underline |

| Size | Height | Horizontal padding | Label token |
| --- | --- | --- | --- |
| `sm` | 32 (hit area padded to 44/48) | 12 | `button.sm` |
| `md` (default) | 40 | 16 | `button` |
| `lg` | 48 | 24 | `button` |
| `block` | 48, full width | 24 | `button` |

- Always `radius.full`. Optional leading icon 16 with 6 gap. Loading and disabled per 1.11.
- a11y: role `button`, label = visible label unless icon-only.

### 2.2 IconButton

- 36 visual circle (web `h-9 w-9`), 20 icon, hit area 44/48.
- Variants: `default` (`text.secondary`, pressed `bg.muted`), `primary` (`accent` icon, pressed `yappr-50` / `yappr-950`), `danger` (`destructive` icon).
- Toggle variant (action bar) uses the active token per action (`like`, `repost`, `link` for bookmark) and the solid icon when on.
- a11y: label required (copy deck 5.13); toggles expose `accessibilityState.selected`.

### 2.3 Avatar

| Size | Diameter | Use |
| --- | --- | --- |
| `xs` | 24 | Stacked avatars in grouped notifications, mention chips |
| `sm` | 32 | Compose header, reply bar, DM group sender |
| `md` | 40 | User rows, notification rows, DM inbox, autocomplete |
| `lg` | 48 | Post cards (web parity), conversation header |
| `xl` | 64 | Account rows in the switcher |
| `profile` | 88 | Profile header (web 128 scaled for phones), 4 pt ring in `bg` |

- Always round, `object-cover` (`contentFit="cover"` in `expo-image`).
- Source: the profile avatar URL; a DiceBear recipe is rendered by the engine into an SVG data URI (`lib/services/avatar-generator`), cached per recipe, and drawn locally with no network fetch; with no avatar, DiceBear `thumbs` seeded by the identity ID. IPFS URLs go through the gateway fallback (2.4.6).
- Loading: a `bg.skeleton` circle; a DiceBear recipe still rendering waits on its backdrop (below) instead. Error: the default `thumbs` avatar.
- DiceBear art is transparent. It sits on `bg` (white) in light mode, as on web, and on a gray-200 (`#e5e7eb`) disc in dark mode, where the line-art styles' black strokes (Lorelei, Notionists, Micah, Croodles) would vanish into the page. Web draws it on the page color in both modes.
- Media gate does **not** apply to avatars (as web).
- a11y: decorative inside a card (the card is the element); standalone tappable avatars are labelled "{name}'s profile".

### 2.4 PostCard

The core list cell. Web source: `components/post/post-card.tsx`. One component with variants `feed` (default), `detail` (focused post), `compact` (thread parent, compose preview), and `optimistic` (with the write-status row).

```
┌──────────────────────────────────────────────────────────┐
│        ↻ Alice reposted                                  │  repost banner (optional)
│ ┌────┐ Bob Builder ✓ @bob · 3h                       ⋯  │  header
│ │ 48 │ Replying to @carol                                │  reply context (optional)
│ └────┘ Post text with a #tag, a @mention and a link,     │  body (SensitiveContentGate wraps
│        wrapping across lines. **bold** *italic* `code`   │   body, poll, quote, media, preview)
│        ┌──────────────────────────────────────────────┐ │
│        │ poll card (read-only)                        │ │  poll (optional)
│        └──────────────────────────────────────────────┘ │
│        ┌──────────────────────────────────────────────┐ │
│        │ ○ Carol @carol · 1d                          │ │  quote embed (optional)
│        │ Quoted text, up to 4 lines…                  │ │
│        └──────────────────────────────────────────────┘ │
│        ┌─────────────────────┬────────────────────────┐ │
│        │      media          │        media           │ │  media grid (optional)
│        └─────────────────────┴────────────────────────┘ │
│        ┌──────────────────────────────────────────────┐ │
│        │ [img] example.com · Title · description      │ │  link preview (optional)
│        └──────────────────────────────────────────────┘ │
│        💬 12      ↻ 3       ♡ 48            🔖   ⇪     │  action bar
└──────────────────────────────────────────────────────────┘  1 px border-bottom
```

#### 2.4.1 Container

- Padding per 1.7; `border` hairline at the bottom; pressed `bg.subtle`.
- Tap → post detail with the card's data as the initial value (web `setPendingPostNavigation`).
- Long-press → context menu (2.4.10). iOS: `UIContextMenu` with a preview of the card; Android: a bottom sheet (2.13) after a long-press haptic.

#### 2.4.2 Repost banner

- `ArrowPathIcon` 16 + "{name} reposted" in `subhead` `text.secondary`, semibold name; "You reposted" for the viewer. Indented per 1.7. Tap → reposter's profile.

#### 2.4.3 Header

- Avatar `lg` (tap → profile).
- One line: display name (`subhead.strong`, `text.primary`, truncates first), verified badge (16, `accent`, only where web shows it), `@handle` (`subhead`, `text.secondary`, truncates second), `·`, compact time (`subhead`, `text.secondary`, never truncates).
- Nameless author: the truncated identity ID `xxxxxxxx…yyyyyy` in monospace `subhead` `text.secondary`; tap copies (PRD AUTH-15).
- While the name resolves: a 96 × 12 skeleton bar and a 64 × 12 bar; the time shows at once.
- Trailing: a lock icon (16, `private`) for private posts, then the "⋯" `IconButton` (label "Post options" / "Reply options").

#### 2.4.4 Body

- `body` text, `text.primary`, line breaks kept, links per G-9 (`link` color, no underline; pressed underline).
- Feed variant: text longer than 12 lines is clamped with a "Show more" link (`link`, `subhead`) that opens the detail. Detail variant: full text, `body.large`.
- Markdown subset: `**bold**` (700), `*italic*`, `` `code` `` (`code` token, `radius.sm`, 2 × 4 padding, monospace 14).
- Order inside the gate, as web: text → poll → quote embed → media grid → link preview → (detail only) absolute time and counts row.

#### 2.4.5 Quote embed

- `radius.xl`, 1 px `border.strong`, 12 padding, 12 top margin. Header: avatar `xs`, name, handle, time (one line). Text clamped to 4 lines. First media item as a 16:9 thumbnail on the right (64 × 64, `radius.lg`) when present.
- Tap → quoted post. NSFW gate uses the `embedded` variant (2.6).
- Missing quoted post → the embed stub (2.5). Skeleton while loading: two 12 pt bars inside the frame.

#### 2.4.6 Media grid

| Items | Layout |
| --- | --- |
| 1 | One cell, aspect ratio of the image clamped between 16:9 (wide) and 4:5 (tall); unknown ratio uses 16:9 |
| 2 | Two columns side by side, each cell 16:9 |
| 3 | First item spans two rows on the left; two stacked on the right; overall 16:9 |
| 4 | 2 × 2 grid, overall 16:9 |

- `radius.xl` on the outer frame, 2 pt gaps, `bg.skeleton` while loading. 1.0 posts carry one item; the grid is built for arrays (README D8).
- IPFS URLs load through the gateway list the engine reports (`lib/utils/ipfs-gateway` order) with fallback to the next gateway on error or 8 s timeout. Final failure: a `PhotoIcon` placeholder with "Image unavailable".
- Media gate: when gated, the whole grid is one placeholder (2.7). `mediaHashes`: the "Media changed since posting" badge bottom-left (`caption`, white on `rgba(0,0,0,0.6)`, `radius.full`).
- Tap → image viewer (4.35). Double-tap → like (PRD ENG-01).
- Video and GIF: 1.0 shows the thumbnail only, never plays inline. Video and GIF cells carry a centered play badge (GIF: a "GIF" chip instead), and their label says "Video" or "GIF". A video with no thumbnail shows the play badge on `bg.muted` ("Video"); nothing remote is loaded for it.

#### 2.4.7 Link preview

- Shown for the first http(s) link when Link previews are on. Card: `radius.xl`, 1 px `border.strong`, image on top (16:9, only when the media gate allows it for this author), then domain (`caption`, `text.secondary`), title (`subhead.strong`, 2 lines), description (`subhead`, 2 lines).
- Skeleton: image box + two bars. Failure or no metadata: no card at all.
- YouTube: thumbnail with a centered 48 play button and "YouTube" label; tap opens the YouTube app or browser. No inline player.
- A `yap.pr/post?id=` link renders as a quote embed (2.4.5) instead.
- Tap → in-app browser.

#### 2.4.8 Poll (read-only)

- `radius.xl` frame, 12 padding. Question (`body.strong`). Each option: label, a bar (`bg.muted` track, `yappr-200` / `yappr-900` fill, the leading option `accent` at 30%), percentage right-aligned (`subhead`, tabular).
- Footer: "{N} votes · Ends in 2d" / "Ended" / "No end date", and "Vote on yap.pr" (`link`).
- Error: "Poll unavailable" in `text.secondary`.

#### 2.4.9 Action bar

| Slot | Icon | Active token | Count | Label (a11y) |
| --- | --- | --- | --- | --- |
| Reply | `ChatBubbleOvalLeftIcon` | — | yes | "Reply, {N} replies" |
| Repost | `ArrowPathIcon` | `repost` | yes | "Repost or quote, {N} reposts" (detail, where the counts row tells quotes apart: "Repost or quote, {N} reposts, {N} quotes"), then ", reposted" / ", quoted" (the viewer's own quote with text) when active |
| Like | `HeartIcon` | `like` | yes | "Like, {N} likes" / "Unlike, {N} likes" |
| Bookmark | `BookmarkIcon` | `link` | no | "Bookmark" / "Remove bookmark" |
| Share | Share icon (1.10) | — | no | "Share" |

- Icons 20, inactive `text.secondary`. Counts `subhead` tabular, 4 pt after the icon, blank at 0, same color as the icon.
- Hidden slots: Bookmark when `canBookmark(kind)` is false; Repost when `canRepost(kind)` is false; Reply and the Quote item of the repost menu on private posts (PRD POST-08); the whole bar on stubs and optimistic cards.
- Like animation: `spring.like` on the icon; color change 150 ms.

#### 2.4.10 Context menu

Items and order are in PRD ENG-08. Destructive items use `destructive` color and come last before Report. iOS: native menu with SF Symbols equivalents (`person.badge.plus`, `chart.bar`, `link`, `square.and.arrow.up`, `trash`, `nosign`, `flag`); Android: bottom sheet list rows with Heroicons 24.

#### 2.4.11 Write-status row (optimistic variant)

Replaces the action bar on optimistic cards.

| State | Row content |
| --- | --- |
| Posting | 12 spinner + "Posting…" (`caption`, `text.secondary`). Also while the outcome is unknown (the network's answer timed out, an engine restart cut the call short, a minute with no answer): the app checks it by itself 5, 20, 80 and 130 s after, again when the app returns to the foreground, and when a feed, profile or thread read shows it. No manual check exists. A post that never went out is called so only from the 130 s check ("Couldn't post" with Retry): before then it may still be on its way |
| Thread progress | spinner + "Posting 2 of 5…" |
| Couldn't confirm | `ExclamationCircleIcon` 14 `text.secondary` + "Couldn't confirm" + " · " + "Edit" (`link`). Only once the automatic checks ran out without proof either way (or a failure that may have landed), with the toast `toast.postUnconfirmed` once. Edit opens compose on its text, parts known to have posted kept posted. Never Retry (it may have landed), and never while the post's call still runs (it may still land). Checks go on (foreground, reads): the card becomes the post by itself if it turns up |
| Failed | `ExclamationCircleIcon` 14 `error` + "Couldn't post" (`error`) + " · Retry · Edit" (`link`). Only when the post was refused, or a check proved it absent |
| Partly posted | "Posted 2 of 5 · Retry the rest" |

The card body renders at 70% opacity while Posting; full opacity in the other states. Announced once per change (A11Y-06).

### 2.5 Removed and deleted stubs

- Card variant: 16 × 12 padding, `border` bottom. Embed variant: inside a quote frame (`radius.xl`, `border.strong`, 12 padding).
- One line: icon 16 (`ShieldExclamationIcon` removed, `TrashIcon` deleted, `ExclamationTriangleIcon` failed or unavailable) + the sentence in `subhead` italic `text.secondary`. Removed with a reason: a second line "Reason: …" not italic. Nothing else of what a removal record kept (v11's tag and date) is shown, on mobile or web.
- Blocked-author variant (G-6): `NoSymbolIcon` + "Reply from an account you blocked" / "Post from an account you blocked".
- Not tappable, no menu. a11y: one static text element.

### 2.6 NSFW gate

- Covers the gated region (2.4.4 order) with an opaque `nsfw.cover` panel, `radius.xl`, centered row: `EyeSlashIcon` 16 + "**NSFW** · The author flagged this post" + "Show" pill (`button.sm`, `radius.full`, `#f3f4f6` fill, `#111827` text).
- Variants: `card` (min height 32, icon 16, `caption`) and `embedded` (min height 28, icon 14, 11 pt text).
- The content is laid out under the cover at full size with `opacity 0` and `importantForAccessibility="no-hide-descendants"` / `accessibilityElementsHidden`; revealing flips the cover off without changing height.
- Taps on the cover do nothing except on "Show". "Show" label: "Show post flagged as NSFW".

### 2.7 Media gate placeholder

- Fills the media cell (or the link-preview image box): `bg.muted` with a frosted look (iOS `BlurView` intensity 30 over a `PhotoIcon` 32; Android a flat `bg.muted`), text "Media from someone you don't follow" (`subhead`, `text.secondary`) and a "Show" button (`secondary`, `sm`).
- Nothing remote is fetched before "Show". "Show" reveals all media of that card for its lifetime.
- a11y: "Media hidden. Media from someone you don't follow." with action "Show".

### 2.8 Tabs and segmented controls

| Kind | Where | Look |
| --- | --- | --- |
| **Top tabs** (underline) | Home (For You / Following), Profile tabs, Engagements | Equal-width labels, `subhead.strong`; active `text.emphasis` with a 4 pt high `accent` underline 56 wide, `radius.full`; inactive `text.secondary`; 1 px `border` under the bar. Swipe between pages on Home and Profile. |
| **Segmented control** | Recent / Top; window toggles; Explore segments; Hashtag Latest / Top | iOS: native `UISegmentedControl` (`@react-native-segmented-control/segmented-control`). Android: Material 3 segmented buttons (outlined, 40 high, check icon on the selected segment, `bg.selected` fill). |
| **Filter chips** | Notifications | Horizontal scroll, 32 high, `radius.full`, 12 padding; selected `bg.selected` + `link` text + 1 px `accent` border; unselected `bg.muted` + `text.primary`. |

All fire `selectionAsync()` on change. a11y: tabs role `tab` with selected state; chips role `button` with selected state.

### 2.9 List rows

- **Navigation row** (settings): leading icon 24 in a 32 tinted square on iOS (optional), label `body`, optional value `body` `text.secondary`, trailing chevron (iOS) or nothing (Android). Min height per 1.7.
- **Switch row**: label `body.strong`, description `subhead` `text.secondary` below, native switch trailing (`trackColor.true = accent`, Android thumb white). The whole row toggles.
- **Radio row / option card**: for NSFW mode and Theme. iOS: rows with a trailing check mark in `accent`. Android: Material radio buttons leading. Each row has a title and a description line.
- **Destructive row**: label in `destructive`, centered on iOS (inset grouped convention), leading on Android.

### 2.10 User row with follow button

```
┌────────────────────────────────────────────────────┐
│ (40) Bob Builder                      [ Follow ]   │
│      @bob · Follows you                            │
│      Builder of things. Two-line bio clamp…        │
└────────────────────────────────────────────────────┘
```

- Avatar `md`, name `body.strong`, handle `subhead` `text.secondary`, "Follows you" tag (`caption`, `bg.muted`, `radius.sm`) when it applies, bio 2 lines `subhead`.
- Follow button: `sm`. States: "Follow" (`primary`), "Follow back" (`primary`), "Following" (`outline`), loading (spinner). Hidden for the viewer's own row.
- Tap row → profile.

### 2.11 Text inputs

| Kind | Spec |
| --- | --- |
| Text field | 44 high (single line), `radius.lg`, 1 px `border.strong`, `bg` fill, 12 horizontal padding, `body` text, placeholder `text.placeholder`. Focused: 2 pt `accent` border (web's purple focus ring is not used, ADR E3). Error: `error` border + a `caption` `error` message below. Label above in `subhead.strong`. Counter right-aligned below when within 20 of the max. |
| Text area | Same, multi-line, min 3 lines, grows to 8 then scrolls. |
| Secure field | Text field with a trailing show / hide `IconButton` ("Show key" / "Hide key"); `secureTextEntry`, `autoCorrect=false`, `autoComplete="off"`, `textContentType="none"`, `importantForAutofill="no"`. |
| Search field | 36 high, `radius.full` (Android) / native `UISearchBar` look via the navigation search (iOS `headerSearchBarOptions`), `bg.muted`, leading `MagnifyingGlassIcon` 16, clear button, "Cancel" on iOS while focused. |

### 2.12 Compose editor and counter

- Editor: borderless multi-line input, `body.large`, placeholder per mode, grows with content. Leading avatar `sm` per item; thread items are joined by a 2 pt `border` line between avatars (web thread line).
- Inline highlighting: mentions, hashtags and links in `link` color; over-limit text gets `error.bg` background from the first over-limit grapheme.
- Footer row per item (above the keyboard for the active item): counter right-aligned; over a limit, "Your post is too long." under the editor in `error` `caption`.
- Editors grow rather than scroll themselves, so compose scrolls for them: when text is added at an item's end (typing, a paste) or the item goes over a limit, its end, with the too-long line, is scrolled above the keyboard.
- **Limits and counting:** the limits come from `engine.info()` capabilities (`contentLimits`); the UI counts locally on each keystroke with the rules of `lib/compose/limits.ts` (code points, UTF-8 bytes, default-ignorable characters), without importing it at runtime (PRD COMP-02).
- **Counter:** the characters left, with tabular figures, `caption`: the room left under both limits, counted in the characters a plain letter fills (one code point, one UTF-8 byte), so emoji and non-Latin text use up more of it. It reaches 0 exactly at the longest post the contract takes and goes negative past it ("-3"). `text.secondary`, `warning` at ≤ 50 left, `error` below 0. a11y label "{n} characters left" / "Too long by {n}", not live. It never mentions bytes.
- **Keyboard accessory bar** (sticks above the keyboard): "Add to thread" (`PlusCircleIcon` + label, `link`; hidden in reply and quote modes and at 10 items), the image-link toggle (`LinkIcon`, a11y "Add image link" / "Remove image link"), then the counter of the active item.
- **Image link:** the toggle opens one URL field under the editors, placeholder "Paste an image link", with a preview once typing pauses. Web (https) and IPFS links are both taken; the field never names URL schemes. Errors: "That doesn't look like an image link." / "That link is too long." (over the contracts' 512 characters).
- **Mention suggestions:** a list docked above the accessory bar, max 4 visible rows (`md` avatars, name, handle), `bg.elevated`, `shadow-lg`, `radius.lg` top corners.

### 2.13 Sheets and dialogs

| Kind | iOS | Android | Use |
| --- | --- | --- | --- |
| **Action sheet** | native `ActionSheetIOS` / `UIAlertController` `.actionSheet` | Material modal bottom sheet with list rows | Repost menu, close-compose choices, unfollow confirm, profile ⋯ |
| **Bottom sheet** | `@gorhom/bottom-sheet` or native `formSheet` with detents medium / large, grabber, `radius.2xl` top, `bg.elevated`, `overlay.sheet` scrim | same component, Material drag handle | Block, report, avatar picker, network info, account switcher, NSFW / theme pickers |
| **Confirm dialog** | native `Alert` with a destructive button | Material `AlertDialog` | Delete post, sign out, clear bookmarks, end group, remove member, restart engine, clear cache |
| **Full-screen modal** | `presentation: 'fullScreenModal'` (compose) or `'modal'` page sheet (edit profile, new message, new group) | full-screen dialog with a top app bar and close × | Compose, edit profile, new message, new group, EULA |

Rules: one primary action per sheet; destructive actions in `destructive`; sheets close on scrim tap and swipe down unless a write is in flight; the Android back gesture closes the top sheet first. On Android an action sheet closes the keyboard as it opens (the keyboard is drawn over it); cancelling the sheet does not reopen it, so the user taps the field again to keep typing.

### 2.14 Toasts

Map of react-hot-toast in `app/layout.tsx`:

- Position top-center, below the status bar and the navigation bar (safe area + 8).
- `toast` colors in both themes, `radius.lg`, padding 12 × 16, `subhead` text (web 14 px), max width screen − 32, `shadow-lg`.
- Leading icon 18: success `CheckCircleIcon` green-500, error `XCircleIcon` red-500, info none.
- Duration 3000 ms; 6000 ms for messages over 80 characters and for toasts with an action. One optional trailing action ("Retry", "Edit", "Get YAPP", "Open in browser", "View") in `#7dd3fc` (yappr-300, 8.6:1 on the toast).
- In: fade + slide down 10 pt, `duration.base`. Out: fade, `duration.fast`. Swipe up dismisses. A new toast replaces the current one.
- a11y: announced with `AccessibilityInfo.announceForAccessibility` (iOS) / a polite live region (Android). Android uses this same component, not a Snackbar, so the two platforms match.

### 2.15 Skeletons

- Bars: `bg.skeleton`, `radius.full`, heights 12 (`caption`/`subhead` lines) and 16 (`body`), pulsing per 1.8.
- **Post skeleton:** 48 circle + bars 96 and 64 wide on the header line, then 3 body bars (100%, 92%, 60%), then the action bar as 4 small circles.
- **User row skeleton:** 40 circle + 2 bars. **Notification skeleton:** 40 circle + 2 bars. **Conversation skeleton:** 40 circle + 2 bars + a 32-wide time bar.
- A list shows skeletons only when it has no cached rows: Home 4 post skeletons, other lists 6 rows.

### 2.16 Empty and error states

```
            ┌──────┐
            │ icon │   48, text.decorative color (gray-300 / gray-600)
            └──────┘
        Title in `title` 600
   Description in `subhead` text.secondary,
   centered, max width 300
         [ Optional button ]
```

- Vertical padding 48. Copy from section 5.
- Error variant: `ExclamationTriangleIcon` in `warning`, title "Something went wrong" (or the categorized message as description), button "Try again" (`primary`, ADR E3: not purple). A list's read that failed with the "temporarily unavailable" category (the one place it is decided: `isTemporaryReadFailure` in `mobile/app/src/data/read-error.ts`, which also picks this copy) is also read again by itself (PRD NET-03: 2 s, 4 s, 8 s, then every 30 s while the app is in the foreground, on the 1.0 terms of NET-03's note; sooner once another read answers). Polls, reads with their own backoff and reads embedded in a card are left alone. The error stays on screen while it retries (not the list's loading state, though a stalled read takes 30-60 s to fail), with "Retrying…" (copy 5.11 `read.retrying`: `caption`, `text.secondary`, an `xs` spinner before it) under "Try again", and gives way to the content as soon as a retry answers. "Try again" (or a pull to refresh) during a retry ends that retry and reads afresh, showing the loading state as it does otherwise; it never waits on the stalled retry.
- List footer variants: end-of-list "You've reached the end." (`subhead`, `text.secondary`, 24 padding), with the legacy link under it on testnet's feeds only (never in an empty state); "Load more" pill (`primary` `sm`) for paused or failed paging.

### 2.17 Network chip

- Height 20, horizontal padding 8, `radius.full`, `network.chip` colors, `chip` text "DEVNET" / "TESTNET". A 6 pt dot before the label: steady black when the engine is ready, pulsing while booting, hollow when unavailable.
- Placement: Home navigation bar (leading on iOS next to the title, trailing on Android before the overflow), and the Settings footer.
- Tap → network sheet (4.34). a11y: "Testnet. Data may be reset. Connected." (state varies: "Connecting." / "Can't connect."; the dot carries the state, so the label must too).

### 2.18 Banners

| Banner | Look | Copy |
| --- | --- | --- |
| Offline | `offline.bg`, 36 high, `SignalSlashIcon` 16 + `subhead` `text.primary` | "You're offline. Showing saved posts." |
| Couldn't connect | `error.bg`, 44 high, text + "Try again" (`link`) | "Couldn't connect to Dash Platform." |
| Restoring messages | `bg.muted`, spinner + step text, dismiss × | DM-01 steps |

Banners sit directly under the navigation bar of the current screen, push content down (never overlay it), and slide in with `duration.slow`.

*Proposed in QA wave B (D-L4i-004), pending lead sign-off:* on the large-title tab roots (Notifications, Explore), the banner is the list's first header row and scrolls away with it. iOS only collapses a large title for a scroll view first in the screen, so a fixed banner in front of the list kept the title drawn over the rows. Home and the other screens keep the fixed banner. Write controls still explain why they're unavailable once it has scrolled away.

### 2.19 Badges and dots

- **Count badge** (tab bar, filter chips): min width 20, height 20, horizontal padding 6, `accent` fill, `caption.strong` `text.inverse`, "99+" cap. On native tab bars use the platform badge API (`tabBarBadge`) with `accent` background.
- **Unread dot:** 8 pt `accent` circle.
- **"Owner" tag, "Follows you" tag:** `caption`, `bg.muted`, `radius.sm`, 2 × 6 padding.

### 2.20 New-posts pill

- Floats 12 below the navigation bar, centered, 36 high, `radius.full`, `accent` fill, `button.sm` `text.inverse`, `ArrowUpIcon` 14 leading, up to 3 overlapping `xs` avatars of the newest authors, `shadow-lg`.
- Text "Show {N} new posts" / "Show 1 new post". Appears with `spring.pill` from −20 pt and fades; hides the same way.
- a11y: button, announced once when it appears.

### 2.21 FAB (compose)

- 56 circle, `accent` fill, `PlusIcon` 28 white (web mobile FAB), `shadow-yappr-lg`, pressed `accent.pressed` + scale 0.95.
- Shown on Home, Explore and Profile (own and others'); hidden on every other screen and while the keyboard is up.
- Hides (slides down 80 pt, `duration.slow`) while scrolling down a list and returns on scroll up; stays put with Reduce Motion.
- Signed out: opens the sign-in sheet (G-8). a11y: "New post".

### 2.22 Spinner and pull to refresh

- Spinner: native `ActivityIndicator`, color `accent`; sizes small (16/20) and large (32/48).
- Pull to refresh: native `RefreshControl`, `tintColor` / `colors` = `accent`, Android `progressBackgroundColor` = `bg.elevated`.

### 2.23 DM bubble

- Max width 78% of the screen. Padding 10 × 14. `radius.2xl` with the corner nearest the sender reduced to `radius.sm` on the last bubble of a run. `body` text.
- Own: `bubble.own`, right-aligned. Other: `bubble.other`, left-aligned; in groups a 24 avatar on the last bubble of a run and the sender name (`caption.strong`, `text.secondary`) above the first.
- Status under the last own bubble: "Sending…", "Sent", "Read" (v3 with receipts), "Not delivered · Tap to retry" (`error`).
- A send that may have gone out but is not proved (the network's answer timed out, no answer for 60 s, or an engine restart cut it short) still reads "Sending…": the app checks it by itself (5, 20, 80 and 130 s after, on foreground, and when the conversation's messages are read), and it turns "Sent" once it lands. Only once those checks ran out without proof does it read "Couldn't confirm · Tap to check" (`error`); a tap checks again, with a small spinner beside the status while it runs (a second tap does nothing, no toast). A send the engine never took goes back to the composer with `toast.dmNotSent`. Only a proved absence offers "Not delivered · Tap to retry". A refusal the engine won't retry reads "Not delivered · Tap to edit": the tap puts the unsent text back in the composer.
- Time shown on long-press only (iOS swipe-left reveals times, as Messages; Android: tap a bubble toggles its time).
- Day separator: centered `caption` `text.secondary` with 16 vertical margin.

---

## 3. Navigation

### 3.1 Tab bar

| Tab | Icon (outline / solid) | Root screen | Badge |
| --- | --- | --- | --- |
| Home | `HomeIcon` | Home (4.8) | — |
| Explore | `MagnifyingGlassIcon` | Explore (4.15) | — |
| Notifications | `BellIcon` | Notifications (4.18) | unread enabled-type count (NOTIF-03) |
| Messages | `EnvelopeIcon` | Messages inbox (4.19) | conversations with unread (DM-13) |
| Profile | `UserIcon` (signed in: the viewer's `xs` avatar with a 1.5 pt `text.emphasis` ring when active) | Own profile (4.12) or signed-out profile placeholder | — |

- **Lead decision (2026-10-01):** the JavaScript tab bar (expo-router `Tabs`) with Heroicons, styled to match the web bottom nav. Not native tabs: those need SF Symbols or drawables and would break visual parity with web. Labels are shown on both platforms. Active is `text.emphasis` and inactive is `text.secondary` (the web bottom nav colors).
- Re-tapping the active tab pops its stack to the root; re-tapping at the root scrolls to the top (Home also loads pending new posts, FEED-05).
- Long-press on Profile opens the account switcher (AUTH-10).
- Each tab keeps its own stack and state.

### 3.2 Routes

Lead decision (2026-10-01): the app uses **idiomatic expo-router routes with dynamic segments**, not web's query-parameter route names. Web URLs and `yappr://` links are translated onto these routes in one place, `src/app/+native-intent.tsx` (3.5).

- **Per-tab stacks.** Each tab keeps its own history. Shared detail screens (post, user, hashtag, followers, engagements) are pushed onto the **current** tab's stack, so Back always returns to where the user came from in that tab (expo-router shared routes across the tab groups).
- **Root modals** sit above the tabs: `compose`, `sign-in/*`, `welcome`, `terms-gate`, `lockdown`, `media`.

| Route (expo-router path) | Params | Presentation | Screen |
| --- | --- | --- | --- |
| `/welcome` | — | root modal, full screen, no tabs | 4.1 |
| `/sign-in`, `/sign-in/wallet`, `/sign-in/qr`, `/sign-in/register`, `/sign-in/key` | — | root modal stack | 4.2 – 4.6 |
| `/terms-gate` | — | root modal, full screen, not dismissible | 4.7 |
| `/(tabs)/home` | — | tab root | 4.8 |
| `/post/[id]` | `reply?` | push in the current tab | 4.9 |
| `/post/[id]/engagements` | `kind` (`post`\|`reply`), `tab?` | push | 4.10 |
| `/compose` | `mode` (`post`\|`reply`\|`quote`), `target?`, `kind?` | root modal, full screen | 4.11 |
| `/(tabs)/profile` | — | tab root (own profile) | 4.12 |
| `/user/[id]` | `tab?` | push (the viewer's own id redirects to the Profile tab) | 4.12 |
| `/user/[id]/followers`, `/user/[id]/following` | — | push | 4.14 |
| `/profile/edit` | — | modal | 4.13 |
| `/(tabs)/explore` | — | tab root | 4.15 |
| `/(tabs)/explore/search` | `q` | push inside the Explore stack | 4.16 |
| `/(tabs)/explore/search/[kind]` | `q` (`kind` = `people`\|`hashtags`\|`posts`) | push inside the Explore stack | 4.16 |
| `/hashtag/[tag]` | `sort?` | push | 4.17 |
| `/(tabs)/notifications` | `filter?` | tab root | 4.18 |
| `/(tabs)/messages` | — | tab root | 4.19 |
| `/messages/[conversationId]` | — | push (hides the tab bar) | 4.20 |
| `/messages/[conversationId]/info` | — | push | 4.22 |
| `/messages/new`, `/messages/new-group` | `with?` (identity id, prefills the 1:1 picker) | modal | 4.21 |
| `/messages/settings` | — | push | 4.23 |
| `/bookmarks` | — | push | 4.24 |
| `/settings` | — | push (from Profile) | 4.25 |
| `/settings/account`, `/settings/accounts`, `/settings/app-lock`, `/settings/privacy`, `/settings/blocked`, `/settings/appearance`, `/settings/feed-language`, `/settings/about`, `/settings/diagnostics` | — | push | 4.26 – 4.32 |
| `/settings/notifications` | — | push in the current tab (shared route): from Settings on Profile, and from the Notifications gear (4.18) on Notifications, so Back returns to the Notifications list. A launch link (`/settings?section=notifications`) opens it on Profile. *Proposed in QA wave B (D-L4a-004 / D-L4i-005), pending lead sign-off; before, it was Profile-only and the gear switched tabs.* | 4.27 |
| `/lockdown` | — | root modal, replaces the content | 4.33 |
| `/media` | `postId`, `index` | root transparent modal | 4.35 |
| `/__gallery` | — | dev builds only | component gallery |

Sheets (block, report, avatar picker, network info, account switcher, repost menu, unlock messages) are component-level, not routes.

### 3.3 Back and dismissal

- iOS: the swipe-back gesture on every pushed screen; modals swipe down unless they hold unsaved input (compose shows the save-draft sheet, PRD COMP-09; edit profile asks "Discard changes?").
- Android: the system back gesture closes the top sheet, then the modal (same rules), then pops the stack, then leaves the app from a tab root (Home) or switches to Home from another tab root.

### 3.4 Headers

- iOS: large titles on Explore, Notifications, Messages, Bookmarks and Settings; collapsing to inline on scroll; translucent `bg.header` with system blur. Home uses an inline header with the wordmark (not a large title) so the tabs sit high. Profile has a custom header (banner) that turns into an inline title with the name when the banner scrolls off.
- Android: Material 3 top app bar, `title` token, `bg` color, 1 px `border` only after scroll (lifted state).

### 3.5 Deep links

Every inbound link goes through `src/app/+native-intent.tsx`, which rewrites the URL to an app route before expo-router sees it:

- `yappr://` links keep web's paths and query parameters (`yappr://post?id=X&reply=Y`), so a web URL becomes a `yappr://` link by swapping the origin.
- Universal links / App Links use the web URL itself (PRD NET-11). The testnet build claims `https://yap.pr/…`; the devnet build claims `https://yap.pr/devnet/…` and strips the `/devnet` prefix first.
- Ids and tags are URL-decoded, then validated (identity and document ids are base58, 43–44 characters; a tag is matched against the hashtag rules). An invalid value falls through to the unsupported-link handling.

| Web URL (or `yappr://` with the same path) | App route | Notes |
| --- | --- | --- |
| `/`, `/welcome`, `/feed` | `/(tabs)/home` | First launch shows `/welcome` first |
| `/login` | `/(tabs)/home` + `/sign-in` | Ignored when signed in |
| `/post?id=X` | `/post/X` | |
| `/post?id=X&reply=Y` | `/post/X?reply=Y` | Opens reply Y focused, X as context |
| `/post/engagements?id=X&kind=K` | `/post/X/engagements?kind=K` | |
| `/user?id=X` | `/user/X` | The viewer's own id → `/(tabs)/profile` |
| `/user?id=X&edit=true` | `/(tabs)/profile` + `/profile/edit` | Only when X is the viewer; else `/user/X` |
| `/user?id=X&tip=…` | `/user/X` | Tips deferred; `tip` is ignored |
| `/followers?id=X`, `/following?id=X` | `/user/X/followers`, `/user/X/following` | `id` defaults to the viewer |
| `/hashtag?tag=T` | `/hashtag/T` | `T` without the `#`; a `$` cashtag keeps its `$` |
| `/mentions?user=X` | `/user/X?tab=mentions` | |
| `/search?q=Q` | `/(tabs)/explore/search?q=Q` | |
| `/explore` | `/(tabs)/explore` | |
| `/notifications` | `/(tabs)/notifications` | |
| `/messages` | `/(tabs)/messages` | |
| `/messages?startConversation=X` | `/messages/C` when a conversation with X exists, else `/messages/new?with=X` | Resolved by the engine (`dm` lookup) before navigating |
| `/bookmarks` | `/bookmarks` | |
| `/settings` | `/settings` | |
| `/settings?section=S` | `/settings/account`, `/settings/notifications`, `/settings/privacy`, `/settings/appearance`, `/settings/about` for S = `account`, `notifications`, `privacy`, `appearance`, `about` | Any other section → `/settings` |
| `/terms`, `/privacy`, `/about`, `/about/*`, `/cookies`, `/contract` | In-app browser | |
| `/dpns/register`, `/store*`, `/item`, `/cart`, `/checkout`, `/orders*`, `/blog*`, `/embed` | In-app browser | Web-only in 1.0 |
| `/app/connect?r=…` | Sign-in return (resumes `/sign-in/wallet`) | Only with `FEATURE_APP_CONNECT` |
| anything else | `/(tabs)/home` + toast "This link isn't supported in the app" with "Open in browser" | |

Signed out, links to the Notifications or Messages tab open that tab's signed-out placeholder (4.37); links to bookmarks, `startConversation`, and settings sections other than appearance, about and privacy open `/sign-in` first and continue to the target after sign-in.

Outbound links (share, copy link) always use the web URL form (`https://yap.pr/post?id=…`), never `yappr://`, so they work for people without the app.

---

## 4. Screens

Each screen lists: route, stories, layout from top to bottom, states, interactions, and iOS / Android differences. Copy references point to section 5.

### 4.1 Welcome

- **Route** `/welcome` · **Stories** AUTH-01.

```
┌─────────────────────────────────┐
│                       [DEVNET]  │
│                                 │
│                                 │
│            Yappr                │  wordmark, gradient
│                                 │
│  The decentralized social       │  body.large, text.secondary,
│  platform where you own your    │  centered
│  data, your identity, and your  │
│  voice.                         │
│                                 │
│   [ Powered by Dash Platform ]  │  pbde image (light/dark asset)
│                                 │
│                                 │
│  ┌───────────────────────────┐  │
│  │         Sign in           │  │  primary, block, shadow-yappr-lg
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │ Browse without signing in │  │  outline, block
│  └───────────────────────────┘  │
│   Terms of Use · Privacy        │  caption, link
└─────────────────────────────────┘
```

- **States:** static; no loading, works offline.
- **Motion:** content fades and rises 20 pt over 500 ms on first appearance (web `motion.div`), none with Reduce Motion.
- **Platform:** identical.

### 4.2 Sign in (methods)

- **Route** `/sign-in` (root modal) · **Stories** AUTH-03, AUTH-04, AUTH-05, AUTH-08, AUTH-13.

```
┌─────────────────────────────────┐
│ Cancel                          │
│            Yappr                │  wordmark 36
│   Sign in with your Dash wallet │  headline
│  Approve one request in your    │  subhead, secondary
│  wallet. Your keys never leave  │
│  it.                            │
│  ┌───────────────────────────┐  │
│  │  ◈  Open wallet           │  │  primary block (same-device)
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  Use a wallet on another  │  │  outline block → QR (4.4)
│  │  device                   │  │
│  └───────────────────────────┘  │
│                                 │
│  Other ways to sign in      ˅   │  disclosure row
│    Sign in with a private key ›│  (revealed)
│                                 │
│  New to Dash? Create an identity│  link → identity bridge
└─────────────────────────────────┘
```

- **No wallet installed:** "Open wallet" is replaced by the explanation block (copy 5.1) with "Get a Dash wallet" (primary) above "Use a wallet on another device".
- **Platform:** iOS page sheet with "Cancel" leading; Android full-screen dialog with close ×.

### 4.3 Waiting for the wallet (same device)

- **Stories** AUTH-03, AUTH-06, AUTH-07.

```
┌─────────────────────────────────┐
│ Cancel                          │
│                                 │
│           ( ◈ )                 │  64 wallet glyph, pulse
│                                 │
│    Waiting for your wallet…     │  headline
│  Approve the request in your    │  subhead, secondary
│  wallet, then come back here.   │
│                                 │
│  ┌───────────────────────────┐  │
│  │     Open wallet again     │  │  outline block
│  └───────────────────────────┘  │
│                                 │
└─────────────────────────────────┘
```

- **Steps after approval** replace the headline with a spinner and: "Wallet approved. Unlocking your keys" → "Checking your identity" → (registration, 4.5) → "Signing you in" → "Signed in" (check icon, then dismiss to the terms gate or Home).
- **No response:** headline "No response from your wallet yet", body "Approve the request in your wallet, then check again for a fresh code.", primary "Check again", secondary "Cancel".
- **Error:** headline "Sign-in failed", the reason, primary "Try again".
- No countdown is ever shown (memory: signing UX direction).

### 4.4 QR sign-in (another device)

```
┌─────────────────────────────────┐
│ ‹ Back                          │
│  Scan with your Dash wallet     │  headline
│  Open your wallet on the other  │
│  device and scan this code.     │
│     ┌─────────────────────┐     │
│     │ ▓▓ ▓ ▓▓▓  ▓ ▓▓ ▓▓▓ │     │  240×240 min, white bg, 16 quiet
│     │ ▓  QR  ▓▓ ▓  ▓ ▓   │     │  zone, even in dark mode
│     │ ▓▓▓ ▓ ▓  ▓▓▓ ▓ ▓▓▓ │     │
│     └─────────────────────┘     │
│        [ Copy link ]            │  secondary sm → "Copied"
│  Waiting for approval…  ◌       │  caption + small spinner
└─────────────────────────────────┘
```

- Keeps the screen awake while visible. States as 4.3.
- Reopened as the flow's first screen (a relaunch resuming a waiting request, AUTH-03), it has the sign-in modal's "Cancel" (iOS) / close × (Android) in place of Back, as 4.3 does; it closes the flow as the swipe-down does, and an abandoned "Add account" goes back to the previous account.

### 4.5 First-time key registration

```
┌─────────────────────────────────┐
│ Cancel                          │
│  First time login               │  title
│  Yappr needs to add keys to     │
│  your identity. Your wallet     │
│  signs this once.               │
│  Keys to be added:              │  subhead.strong
│  • Sign posts and likes         │  one row per key purpose
│  • Encrypt your messages        │
│  ┌───────────────────────────┐  │
│  │    Continue in wallet     │  │  primary block
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

- After the wallet returns: spinner + "Finishing setup… This can take up to a minute."; after 60 s "Still confirming. We'll keep checking." with "Check now".

### 4.6 Private key entry

```
┌─────────────────────────────────┐
│ ‹ Back                          │
│  Sign in with a private key     │  title
│  ┌───────────────────────────┐  │
│  │ ••••••••••••••••••••  👁  │  │  secure field
│  └───────────────────────────┘  │
│  ✓ Identity found: @alice       │  caption, green-700/green-500
│  ✓ Key matches this identity    │  (or error line in `error`)
│  Your key stays on this device. │  caption, secondary
│  Every signature happens        │
│  locally.                       │
│  ┌───────────────────────────┐  │
│  │          Sign in          │  │  primary block, disabled until valid
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

- Validation runs 400 ms after typing stops; each line shows a spinner while checking.
- iOS: `textContentType="none"`; Android: `importantForAutofill="no"`. The field clears when leaving the screen.

### 4.7 Terms gate (EULA)

- **Route** `/terms-gate` · **Story** AUTH-09.

```
┌─────────────────────────────────┐
│  Before you start               │  title.large
│  Yappr is a public network.     │  body
│  By continuing you agree to:    │
│  • No harassment, hate, threats │  body, bulleted (copy 5.1)
│    or illegal content. There is │
│    zero tolerance for abuse.    │
│  • Reported content can be      │
│    removed by the community's   │
│    moderators, and abusive      │
│    accounts can be banned.      │
│  • You can block anyone, and    │
│    report posts that break      │
│    these rules.                 │
│  • What you post is public and  │
│    permanent on Dash Platform.  │
│                                 │
│  Terms of Use · Privacy Policy  │  links (in-app browser)
│  · Community rules              │
│  ┌───────────────────────────┐  │
│  │    Agree and continue     │  │  primary block
│  └───────────────────────────┘  │
│           Not now               │  ghost → signs this account out
└─────────────────────────────────┘
```

- Not dismissible by gesture. Scrolls at large text sizes with the buttons pinned at the bottom.

### 4.8 Home

- **Route** `/(tabs)/home` · **Stories** FEED-01 – FEED-11, AUTH-15, NET-01, NET-02, NET-07.

```
┌─────────────────────────────────┐
│ Yappr [DEVNET]                  │  inline header (wordmark 24); no refresh
├─────────────────────────────────┤  button: pull to refresh replaces it
│   For You    │   Following      │  top tabs, underline under active
├─────────────────────────────────┤
│ [ Recent | Top ]  [3 days|All]  │  segmented (dev only); window only on Top
├─────────────────────────────────┤
│ ┌─ Get a username ──────── × ┐  │  AUTH-15 card (when nameless)
│ │ Usernames make you easy to │  │
│ │ find. Register one on      │  │
│ │ yap.pr.     [Open yap.pr]  │  │
│ └────────────────────────────┘  │
│      ( ↑ ○○ Show 3 new posts )  │  floating pill (FEED-05)
│ PostCard                        │
│ PostCard                        │
│ PostCard                    ┌─┐ │
│                             │✎│ │  FAB
│                             └─┘ │
├─────────────────────────────────┤
│ Home  Explore  Notif.  Msgs  Me │  tab bar
└─────────────────────────────────┘
```

- **Header:** iOS: the wordmark leading and the network chip after it; Android: wordmark as the app bar title, chip as a trailing action. The header and tabs collapse (scroll away) when scrolling down and return on scroll up (iOS `hidesBarsOnSwipe`-like behaviour via a collapsible header; Android `enterAlways` scroll flag).
- **Tabs:** swipeable pages (pager), each with its own list and scroll position.
- **States:**
  - cold, cached: cached posts immediately;
  - cold, no cache: 4 post skeletons + "Connecting to Dash Platform…" (`subhead`, `text.secondary`) under them;
  - empty For You / Following: empty states (copy 5.2);
  - Following signed out: login prompt (copy 5.2) with "Sign in";
  - error: G-11 inline error replacing the list when nothing is cached; with cache, a toast and the cached list;
  - offline: offline banner above the tabs.
- **Interactions:** pull to refresh; FAB; card interactions FEED-09; tab re-tap scroll-to-top.

### 4.9 Post detail

- **Route** `/post/[id]?reply=` · **Stories** POST-01 – POST-05, POST-08 – POST-10, ENG-*.

```
┌─────────────────────────────────┐
│ ‹            Post            ⋯  │
├─────────────────────────────────┤
│ ┊ (32) Carol · 1d               │  parent (compact) when focused is a reply
│ ┊  Parent text…                 │
│ (48) Bob Builder               │  focused post, detail variant
│      @bob                       │
│ Full post text in body.large,   │
│ never truncated…                │
│ [ media full width ]            │
│ 3:42 PM · Oct 1, 2026           │  subhead, secondary
│ 12 Reposts  4 Quotes  48 Likes  │  tappable → engagements tabs
│ ─────────────────────────────── │
│   💬     ↻     ♡     🔖    ⇪    │  action bar, evenly spread
├─────────────────────────────────┤
│ (40) Dan · 2h                   │  replies, one indent level
│      Reply text                 │
│   ┃ (32) Bob · 1h               │  indented reply-to-reply
│   ┃  Replying to @dan           │
│      Continue thread ›          │  link
│ No replies yet. Be the first…   │  (empty)
├─────────────────────────────────┤
│ (32) Post your reply            │  docked reply bar (POST-10)
└─────────────────────────────────┘
```

- **Header title:** "Post" or "Reply". "⋯" opens the focused item's context menu.
- **Counts row** shows only non-zero counts; each opens Engagements on that tab. On dev (`repostsAreQuotes`) a bare repost is a quote post, so reposts and quotes are told apart by `posts.engagementCounts` (the Engagements screen's split) and stay out of the row until it answers; counts read off a quote list that filled up show that list's split as floors ("60+ Reposts · 40+ Quotes"). When a refresh moves the quote count the list is split again; when the split cannot be read, the row shows the post's own counts.
- **Missing focused item:** stub (2.5) as the focused item; replies still listed (POST-05); reply bar replaced by the disabled note.
- **Not found:** empty state "Post not found" with "Go back".
- **Loading:** focused post skeleton; "Loading replies…" row under it.
- **Reply bar:** 52 high, `bg` with a top `border`, avatar `sm`, placeholder in `text.placeholder`; sits above the keyboard area and safe area.

### 4.10 Engagements

- **Route** `/post/[id]/engagements?kind=` · **Story** POST-06.
- Header "Post engagements". Top tabs "Quotes (4)", "Reposts (12)", "Likes (48)" (counts when known; Reposts absent when not repostable).
- Quotes: PostCards. Reposts and Likes: user rows (2.10). Infinite scroll, empty states (copy 5.3).

### 4.11 Compose

- **Route** `/compose` (root modal, full screen) · **Stories** COMP-01 – COMP-12.

```
┌─────────────────────────────────┐
│ Cancel        [NSFW]   [ Post ] │  Post: primary sm; "Reply"; "Post all (3)"
├─────────────────────────────────┤
│ Replying to @carol              │  reply mode only, subhead secondary
│ ┌ compact parent preview ─────┐ │
│ └─────────────────────────────┘ │
│ (32) What's on your mind?       │  editor 1, body.large
│  ┃                              │  thread line
│ (32) Continue your thread...    │  editor 2 (thread), × remove
│                                 │
│ ┌ quoted post embed ──────────┐ │  quote mode only
│ └─────────────────────────────┘ │
│ Your post is too long.          │  over a limit (error)
├─────────────────────────────────┤
│ ⊕ Add to thread   🔗         18 │  accessory bar: characters left
├─────────────────────────────────┤
│           keyboard              │
└─────────────────────────────────┘
```

- **NSFW toggle:** a chip in the header: off = outline `border.strong`, `text.secondary` "NSFW"; on = amber-500 fill, black text. a11y "Mark this post as NSFW", switch role.
- **Post button:** disabled per COMP-01 / COMP-02 / COMP-11; offline it stays disabled and the accessory bar shows "You're offline" instead of "Add to thread".
- **Close:** "Cancel" (iOS) / × (Android). With content: action sheet "Save draft" / "Delete draft" (destructive) / "Cancel".
- **Mention suggestions:** 2.12. **Mentions (dev, only the first notifies):** with 2 or more different @mentions, a muted caption under the editor, "Only @{first} will be notified." Nothing about tags: a tag longer than the contract indexes is simply not highlighted as a link.
- **Posting:** the sheet closes at once (PRD PD-3); the optimistic card appears in the list behind it.
- **Platform:** iOS `fullScreenModal` with the keyboard up on open; Android full-screen dialog, `adjustResize`, IME action = newline.

### 4.12 Profile (own and others)

- **Routes** `/(tabs)/profile`, `/user/[id]` · **Stories** PROF-01 – PROF-05, PROF-09 – PROF-13.

```
┌─────────────────────────────────┐
│ ‹                         ⚙  ⋯ │  over the banner, white icons on a
│▓▓▓▓▓▓▓▓▓▓▓ banner 150 ▓▓▓▓▓▓▓▓▓│  28 circle of rgba(0,0,0,0.4)
│ ┌──────┐                        │
│ │  88  │      [Edit profile]    │  own: outline sm
│ └──────┘   [✉] [ Follow ]       │  others: message icon + follow
│ Bob Builder                     │  title.profile
│ @bob · he/him                   │  subhead secondary
│ Builder of things.              │  body (bio)
│ 📍 Lisbon  🔗 bob.dev  Joined   │  subhead secondary, link for website
│ Sep 2026                        │
│ 120 Following   1.2K Followers  │  numbers body.strong, labels secondary
├─────────────────────────────────┤
│ Posts │ Replies │ Top │ Mentions│  sticky top tabs
├─────────────────────────────────┤
│ PostCard…                       │
│                             ┌─┐ │
│                             │✎│ │
└─────────────────────────────────┘
```

- **Banner:** 150 high (web 192 scaled), the banner image or `gradient-yappr`; gated by the media gate for authors the viewer doesn't follow (placeholder is plain `gradient-yappr`, no "Show"). Pull-down stretches the banner (iOS) / overscroll (Android).
- **Avatar:** `profile` size overlapping the banner by 44, ring 4 in `bg`.
- **Buttons (own):** "Edit profile" (outline sm); header gear → Settings (iOS) or overflow menu (Android) with Bookmarks, Blocked accounts, Settings, Share profile, Switch account.
- **Buttons (others):** Message `IconButton` (`EnvelopeIcon`, outline circle 32), Follow button (2.10 states). "⋯" menu: Share profile, Copy profile link, Block / Unblock.
- **Nameless:** name line shows the truncated ID (monospace, tap to copy).
- **Blocked:** tabs replaced by the blocked notice (copy 5.6).
- **NSFW profile:** interstitial replaces everything below the header bar (copy 5.6).
- **Loading:** banner gradient, avatar skeleton, 2 skeleton bars for name and handle, tabs disabled.
- **Signed-out Profile tab:** empty state "Sign in to post, follow and message" with "Sign in", then grouped rows: Appearance, Privacy & Safety, About. (Troubleshooting is the last row of About.)

### 4.13 Edit profile and avatar picker

- **Route** `/profile/edit` (modal) · **Stories** PROF-06, PROF-07, PROF-08.

```
┌─────────────────────────────────┐
│ Cancel     Edit profile    Save │
├─────────────────────────────────┤
│▓▓▓▓▓▓ banner preview ▓▓▓▓▓▓▓▓▓▓│  tap → "Banner image link" field focus
│ (88)  Change avatar             │  link → avatar sheet
│ Name                     12/25  │
│ [ Bob Builder               ]   │
│ Bio                     40/140  │
│ [ Builder of things.        ]   │
│ Your name and bio also show in  │  dev only: caption secondary
│ other Dash apps, like DashPay.  │
│ Pronouns  [ he/him          ]   │
│ Location  [ Lisbon          ]   │
│ Website   [ https://bob.dev ]   │
│ Banner image link [ https://… ] │
│ NSFW content               [○]  │  switch row
│ Mark your profile as containing │
│ adult content                   │
└─────────────────────────────────┘
```

- One list on every contract, whichever documents hold the fields: Name, Bio, Pronouns, Location, Website, Banner image link, NSFW. v2: Name (required, 50), Bio (160). Dev: Name (25), Bio (140), with the footnote under Bio.
- **Save:** disabled until changed and valid; shows a spinner and "Saving…" in the navigation bar title position, however many documents the save writes. If a dev save writes the DashPay profile and then fails on the Yappr profile, the toast names what did not save: "Couldn't save pronouns, location and website. Try again." (copy 5.6 `toast.profilePartial`).
- **Avatar sheet** (bottom sheet, large detent): segmented "Generated / Image link". Generated: a 4-column grid of 28 style tiles (64 avatars with labels), selected tile has a 2 pt `accent` ring; under it "Seed" field + "Randomize" (`secondary sm`). Image link: URL field + 88 preview + error line. "Use this avatar" (primary block) at the bottom.

### 4.14 Followers and following

- **Routes** `/user/[id]/followers`, `/user/[id]/following` · **Story** PROF-04.
- Header "{name}" with a subtitle "Followers" / "Following" (iOS: two-line title view; Android: title + subtitle). A search field under the header ("Search by username..."). User rows. Empty and error states (copy 5.6).

### 4.15 Explore

- **Route** `/(tabs)/explore` · **Stories** EXPL-01 – EXPL-04.

```
┌─────────────────────────────────┐
│ Explore                         │  iOS large title
│ ┌─────────────────────────────┐ │
│ │ 🔍 Search Yappr             │ │  search field (native on iOS)
│ └─────────────────────────────┘ │
│ [ Trending | Top | Creators ]   │  segmented (dev); hidden on v2
│ [ 3 days | All time ]           │  Top; Trending has 24h | All time
├─────────────────────────────────┤
│ 1  #dash                        │  trending rows: rank caption,
│    128 likes (dev) / posts (v2) │  tag body.strong, count subhead
│ 2  $DASH                        │
│    96 posts                     │
│ …                               │
│                             ┌─┐ │
│                             │✎│ │
└─────────────────────────────────┘
```

- **Trending count:** "{N} likes" where `topSort` is on (dev), "{N} posts" on v2 (as web).
- **Top:** PostCards. **Creators:** ranked user rows with "2.4K likes" as the secondary line.
- **Windows (dev, `windowedRankings`):** Trending "24h / All time" (opens on 24h, EXPL-02), Top "3 days / All time" (EXPL-03), as web's per-axis `RankingWindowToggle`; Creators has none.
- **States:** loading copy, empty copy (5.7), error (2.16).

### 4.16 Search and results

- **Routes** `/(tabs)/explore/search?q=`, `/(tabs)/explore/search/[kind]?q=` · **Stories** EXPL-05, EXPL-06, EXPL-08.

```
┌─────────────────────────────────┐
│ 🔍 bob                 Cancel   │
├─────────────────────────────────┤
│ People                  See all │  section header headline + link
│ (40) Bob Builder  @bob          │  user rows (no follow button here)
│ (40) Bobby  @bobby              │
│ Hashtags                See all │
│ #bobsburgers  12 posts          │
│ Recent posts            See all │
│ PostCard (compact)              │
└─────────────────────────────────┘
```

- **Focused, empty query:** "Recent" list (EXPL-08) with × per row and "Clear".
- **Typing < 3 characters:** the people section shows the hint row "Type at least 3 characters to search for people".
- **Searching:** a spinner row "Searching…". **No results:** empty state "No results for "{q}"" / "Try searching for something else".
- **iOS:** the native search bar in the Explore navigation bar with the results controller pattern; **Android:** a Material search view that expands full screen.

### 4.17 Hashtag

- **Route** `/hashtag/[tag]` · **Story** EXPL-07.
- Header title "#tag" (`$tag` for cashtags). Under it, the segmented "Latest | Top" (dev) and, on Top, "24h | All time". PostCard list with infinite scroll and pull to refresh. Loading and empty copy (5.7). FAB hidden (compose can still prefill: P2, not in 1.0).

### 4.18 Notifications

- **Route** `/(tabs)/notifications` · **Stories** NOTIF-01 – NOTIF-09.

```
┌─────────────────────────────────┐
│ Notifications      ✓all    ⚙   │  large title; "Mark all as read"
├─────────────────────────────────┤  (iOS: text button; Android: icon
│ (All)(Likes)(Reposts)(Replies)… │  with tooltip), gear → settings
├─────────────────────────────────┤
│▌♡ (40) Alice liked your post   │  unread: bg.unread + dot at the
│▌        "Post snippet two lines"│  leading edge
│         2h                      │
│ ↻ (40) Dan reposted your post  │
│ 👤 (40) Eve started following   │
│        you                      │
└─────────────────────────────────┘
```

- **Row:** type icon 20 (decorative colors 1.2) in a 40 column, then avatar `md` (or stacked `xs` avatars for grouped likes), the sentence ("**Alice** liked your post", name `body.strong`, phrase `body`), the snippet (`subhead`, `text.secondary`, 2 lines, quoted), time (`caption`, `text.secondary`). Likes that keep no time of their own (dev, v11) show no time at all, never when this device saw them.
- **End of the list:** nothing; the list just ends.
- **Tap:** opens the target and marks read. Swipe actions: none in 1.0.
- **Signed out:** empty state "Sign in to see your notifications" + "Sign in".

### 4.19 Messages inbox

- **Route** `/(tabs)/messages` · **Stories** DM-01, DM-02, DM-11, DM-13.

```
┌─────────────────────────────────┐
│ Messages               ⚙   ✎   │  large title; ✎ menu: New message /
├─────────────────────────────────┤  New group (v5); ⚙ Message settings (v5)
│ 🔍 Search messages              │
│ ◌ Restoring your messages   ×  │  banner while restoring
│ (40) Alice                 2m ● │  name body.strong, time caption,
│      You: see you there         │  unread dot
│ (40) Builders (group)      1h   │
│      Bob: shipped it            │
│ Archived (2)                    │  footer link (v5); "Hide archived"
└─────────────────────────────────┘
```

- **Unread rows:** name and preview in `text.primary` weight 600; read rows' preview `text.secondary`.
- **Swipe (iOS) / long-press menu (Android):** "Archive" / "Archive conversation" (v5), with no confirmation: the row leaves the list at once with the toast "Conversation archived" and "Undo" (6 s). It is saved once Undo has passed or the app leaves the foreground; a new message brings it back.
- **Archived:** behind the footer link "Archived ({N})" / "Hide archived". Everything archived: the empty state "No conversations yet" with the footer link under it.
- **Locked (no encryption key):** the whole tab shows the unlock empty state (copy 5.8) with "Unlock messages" opening the unlock sheet (4.38).
- **Order:** last activity, newest first. A group with no message yet is placed by when this device joined it (or created it); a 1:1 just opened to write is on top; nothing without a time goes above active conversations.
- **Loading:** until the engine has loaded the saved conversations, the conversation skeleton (2.15), with "Connecting to Dash Platform…" under it while the engine boots (4.34). If that first load fails: the inline error state (2.16) with the categorized message and "Try again", which checks again at once (as pull to refresh does). Neither shows the welcome or the "Couldn't check for new messages" notice; the notice is only for a list already on screen.
- **Empty:** welcome empty state with "New message", only once the conversations have loaded and there are none.

### 4.20 Conversation

- **Route** `/messages/[conversationId]` · **Stories** DM-03, DM-04, DM-08, DM-10, DM-14.

```
┌─────────────────────────────────┐
│ ‹  (32) Alice              ⋯   │  tap title → profile (1:1) or group info
├─────────────────────────────────┤
│            Yesterday            │  day separator
│ ┌──────────────┐                │
│ │ hey, coming? │                │  other bubble
│ └──────────────┘                │
│                 ┌─────────────┐ │
│                 │ on my way   │ │  own bubble
│                 └─────────────┘ │
│                          Sent   │  status caption
├─────────────────────────────────┤
│ ┌───────────────────────────┐ ➤│  composer + send (IconButton primary)
│ │ Type a message...         │  │
│ └───────────────────────────┘  │
└─────────────────────────────────┘
```

- **Header "⋯":** 1:1: "Block" / "Unblock", "Archive conversation" (v5). Group: "Group info", "Archive conversation" (v5). Archiving goes back to the inbox, where the toast offers Undo.
- **Group key missing (member):** the composer banner reads "Waiting for access to this group. If this doesn't clear, ask the owner to re-invite you."; the inbox preview "Waiting for access…".
- **Composer:** text area growing to 5 lines; send disabled when empty; replaced by the state banners of DM-08 / DM-10 (`bg.muted`, centered `subhead`).
- **Keyboard:** the list stays pinned to the newest message when the keyboard opens (inverted list). Long-pressing a bubble closes the keyboard before the Copy sheet opens (Android draws the keyboard over sheets).
- **Pinned to the newest:** while the user reads at the end, the list stays at the newest message whenever messages arrive or history loads above (a thread opened after a cold launch fills in its history after it opens); nothing moves the list while the user's own scroll is under way (finger down, or a fling still moving), and once it comes to rest away from the end nothing moves it until they are back at the end.
- **Tab bar** hidden on this screen.

### 4.21 New message and new group

- **Routes** `/messages/new`, `/messages/new-group` (modals) · **Stories** DM-05, DM-06.
- **New message:** title "New message", description line "Choose a person to start an encrypted conversation.", search field "Search by username...", hint line, then "Your followers" section of user rows (no follow buttons). Tapping a row opens the conversation and closes the modal.
- **Creating:** the form locks with a spinner on "Create group" and the caption "Creating group…". Confirmed: the new group opens. An unknown outcome (a timeout, an engine restart) goes to the inbox, read again, which shows the group once it is there; the form never offers a second creation, and the engine refuses one while the first still runs.
- **Keys the creation missed:** the owner's app sends them again by itself, with no toast: on group open, on app foreground and after each backoff (30 s, then 2 min), at most 3 times per member, never while a resend for that member still runs (its `dm.group` deadline is 5 minutes). A member the owner removes is dropped. Only once the attempts are used up, and only for members whose every attempt proved it failed: "1 member hasn't been added to {group} yet." / "{n} members haven't been added to {group} yet." with "Retry". A member with any resend whose outcome stayed unknown (it may have landed) is let go with no toast; "Re-invite" stays in the member menu.
- **New group:** title "New group", description "Name the group and pick its members.", "Group name" field (counter at 80+/100), selected members as chips (avatar `xs` + name + ×), the same search and followers list with checkmarks, and "Create group" (primary, in the navigation bar on iOS, a full-width bottom button on Android that stays above the keyboard while the search field has focus), disabled until a name and at least one member.

### 4.22 Group info

- **Route** `/messages/[conversationId]/info` · **Story** DM-07.

```
┌─────────────────────────────────┐
│ ‹         Group info            │
│        ( group glyph 64 )       │
│          Builders               │  title; "Rename" link under it (owner)
│ 5 members                       │  section header
│ (40) Bob (you)          Owner   │
│ (40) Alice                  ⋯   │  owner: ⋯ → Re-invite / Remove member
│ ⊕ Add members                   │  owner
│ New members can read messages   │  caption
│ sent after they join.           │
│ End group                       │  owner, destructive row
│ Leave group                     │  member, destructive row
└─────────────────────────────────┘
```

- **Ended or left:** the actions are replaced by the state text.
- **Re-invite** (owner's member menu): the fallback when the app's own key resends could not reach a member; toast "Invite sent".
- **Leave:** after the confirm, the inbox at once, without the group; it comes back only if the leave is proved not to have gone out, or the account changes first.
- **Legacy (testnet):** no groups; a link here goes to the inbox.
- Confirmations use the confirm dialog (2.13) with copy 5.8.

### 4.23 Message settings

- **Route** `/messages/settings` · **Story** DM-12.
- Section "Delete old sent messages": radio rows "Never", "After 30 days", "After 90 days", "After 1 year"; the footer below (copy 5.8 `dm.retention.footer`), which keeps the privacy caveat. Never called "disappearing messages".
- Section "Blocked": rows with "Unblock"; empty: "No blocked accounts" with the caption "Messages and group invites from people you block are ignored."
- **Legacy (testnet):** nothing to set; a link here goes to the inbox.

### 4.24 Bookmarks

- **Route** `/bookmarks` · **Story** ENG-04.
- Large title "Bookmarks", search field "Search bookmarks", header "⋯" with "Clear all bookmarks". PostCards; swipe-left "Remove" (iOS) or the card menu item "Remove bookmark" (both). Empty state (copy 5.5). Loading "Loading bookmarks…".

### 4.25 Settings root

- **Route** `/settings` · **Story** SET-01.

```
┌─────────────────────────────────┐
│ ‹ Settings                      │
│ ┌─────────────────────────────┐ │  iOS inset grouped
│ │ (32) Bob Builder          › │ │  account summary row → Account
│ │      @bob                   │ │  no balance here (Account has it)
│ └─────────────────────────────┘ │
│ ┌─────────────────────────────┐ │
│ │ 🔔 Notifications          › │ │
│ │ 🛡 Privacy & Safety       › │ │
│ │ ✉ Messages                › │ │  v5 only
│ │ 🎨 Appearance              › │ │
│ └─────────────────────────────┘ │
│ ┌─────────────────────────────┐ │
│ │ ℹ About                   › │ │
│ └─────────────────────────────┘ │
│        [DEVNET]                 │
│      Yappr 1.0.0 (123)          │  caption secondary; the chip names the network
└─────────────────────────────────┘
```

- iOS: inset grouped list, chevrons. Android: flat Material list with section headers and leading icons, no chevrons.

### 4.26 Settings: Account

- **Story** SET-02, AUTH-10, AUTH-11, AUTH-12.
- Groups:
  1. "Usernames" (each name as a row; then the link row "Register a username on yap.pr", or "Register another username on yap.pr" when there is at least one).
  2. "Balance" (DASH cut to 4 decimals, `body.strong` tabular, "< 0.0001 DASH" below that; the exact credits below in a muted `caption`). No refresh button: it is read again when the screen opens and on pull to refresh, and a failed pull toasts `account.refreshFailed`. "YAPP" (where shown).
  3. "Accounts" › (switcher list screen: rows with `xl` avatars, check on current, "Add account"; each row shows the name and @handle only, since the section header names the network), "App lock" › (switch + timeout radio rows).
     - An account marked "Sign in again" (AUTH-14) has an outline `sm` "Sign in again" button beside its row, which opens its sign-in. Tapping the row of a marked account that is not the current one still switches to it, for reading; its write controls then open the "Sign in again" sheet. Tapping the current marked account's row opens its sign-in, and so does tapping one that cannot be opened (its key is gone from the device), without a "Couldn't switch" toast; abandoning that sign-in returns to the account that was current.
  4. "Account created", then "Copy account ID" (the id middle-truncated as its value; a tap copies it whole, toast "Account ID copied").
  5. "Sign out" (destructive row).
- Moderation notice (SAFE-09) at the top when present: `error.bg` card.

### 4.27 Settings: Notifications

- "In-app notifications" header, note "Yappr checks for new activity while the app is open.", five switch rows (copy 5.10).

### 4.28 Settings: Privacy & Safety

- Groups:
  1. "Link previews" switch row + the disclosure as a footer note.
  2. "Blur media from people you don't follow" switch row.
  3. "NSFW content": three radio rows with descriptions.
  4. "Blocked accounts" › .
  5. "Read receipts" switch row (v3 only).

### 4.29 Blocked accounts

- **Route** `/settings/blocked` · **Story** SAFE-03.
- User rows with the block note under the handle (`subhead`, `text.secondary`, italic) and "Unblock" (`outline sm`). Footer note `blocked.listsNote` with the "Manage on yap.pr" link, only when the viewer follows at least one block list (`safety.followedBlockLists`); nothing about block lists otherwise. Empty state "You haven't blocked anyone".

### 4.30 Settings: Appearance

- "Theme": radio rows "System", "Light", "Dark" (iOS check marks; Android radio buttons). Applies instantly with a 200 ms crossfade of the root (none with Reduce Motion).
- "Feed language" › (v2, P2, only with `capabilities.postLanguage`): the row shows the current language and pushes `/settings/feed-language`, a picker list: radio rows for the languages web offers (English, Spanish, French, German, Portuguese, Russian, Chinese, Japanese, Korean, Arabic, Hindi, Italian, Dutch, Polish, Turkish), with the note under them. Choosing one saves it (`settings.set({ feedLanguage })`) and starts For You over in that language.

### 4.31 Settings: About

- Header block: 48 app icon, "Yappr", "Decentralized social media on Dash Platform", version line. No "Powered by Dash Platform" footer: the tagline says it.
- One info row above the links: "Version" (version and build, "1.0.0 (123)"). A long press copies the build details, "Yappr 1.0.0 (123) · 9f8e7d6c · evo-sdk 3.0.0 · testnet" (the commit's first 8 characters, baked in at build time and never fetched; a part the build doesn't know is left out), with the toast "Version info copied". A tap does nothing; screen readers hear the hint "Long press to copy version info". No Network, Engine or Commit rows.
- Rows: "Terms of Use", "Privacy Policy", "Community rules", then "Support" (mail), "Send diagnostics", "Open-source licenses", "Yappr on the web".
- "Community rules" opens one sheet: the 4.7 summary first (`about.rulesIntro` and its 4 bullets), then the full rules the 4.7 gate expands under "Community rules", until yap.pr publishes a rules page (COMPLIANCE C4); then it opens that page in the in-app browser like Terms and Privacy.
- "Send diagnostics" opens the mail composer to the support address (PRD §11.1 OQ-1) with the redacted 4.32 text as the body, sized for a mail link: its newest 10 errors (each clipped to 300 characters) and last 40 log lines, within 5,000 characters (the oldest log lines go first). With no mail app, the native share sheet offers the same text, led by "Send to support@yap.pr" so a message or note still says where it goes. The row is disabled until the composer or share sheet opens (up to 2 s while the engine's live figures load), so a second tap sends nothing.
- Last, a muted row "Troubleshooting" (`subhead`, `text.secondary`, centered, 44 tall) opens 4.32. It is there signed out and in every build, and is the only way in.
- "Open-source licenses" pushes a native list (`/settings/licenses`) generated at build time from the app's production lockfile and the packages the engine bundles (`mobile/engine/bundled-packages.json`, from esbuild's metafiles): one row per package with its version and license; a row opens to the package's license text.

### 4.32 Troubleshooting

- **Route** `/settings/diagnostics` · **Story** SET-08. Reached from About's last row only.

```
┌─────────────────────────────────┐
│ ‹ Troubleshooting        Share  │
│ ┌───────────────────────────┐   │
│ │      Copy diagnostics     │   │  primary block, first
│ └───────────────────────────┘   │
│ STATUS                          │
│ Engine            ● Ready       │
│ Boot time         3,412 ms      │  monospace values
│ WASM compile      2,180 ms      │
│ Restarts          0             │
│ WebAssembly       Available     │
│ NETWORK                         │
│ Network           devnet        │
│ evo-sdk           5.0.0-beta.1  │
│ Engine bundle     a1b2c3d4      │
│ Topology          v11           │
│ Social contract   5TAf…QxYz  ⧉  │
│ DM contract       …          ⧉  │
│ DAPI endpoints    13 · last ok  │
│                   4s ago      › │
│ CAPABILITIES                  › │  list of flags
│ CACHE             18.2 MB       │
│ RECENT ERRORS (3)             › │
│   Share diagnostics             │  outline
│   Reconnect                     │  destructive row (confirm)
│   Clear cache                   │  destructive row (confirm)
└─────────────────────────────────┘
```

- Values refresh every 2 s while visible. The errors list shows time, operation and message, newest first; a row expands to the full message.
- Recent errors keeps the last 50: every engine call that failed (reads included; the operation is its method path) except the host's own `engine.*` control calls, and every error the engine or the host logged (operation `engine` / `host`). The list is a collapsed row ("Recent errors (3) ›"), so the actions below stay in reach.
- "Copy diagnostics" toasts "Diagnostics copied". "Share" (header) and "Share diagnostics" (button) open the native share sheet with the same text "Copy diagnostics" copies. "Reconnect" asks "Reconnect to Dash Platform? Lists reload; nothing you posted is lost." and restarts the engine. The DAPI row expands to each endpoint's last success and failures; "Capabilities" expands to the flag list; each contract id (social, profile, DM, Pollr) has a copy button.
- The shared text never includes keys, WIFs, encryption keys or message content.

### 4.33 Lockdown Mode

- **Route** `/lockdown` · **Story** NET-06 (iOS only).

```
┌─────────────────────────────────┐
│         ( 🔒 shield 64 )        │
│  Lockdown Mode is blocking      │  title.large, centered
│  Yappr                          │
│  Yappr needs WebAssembly to     │  body, secondary
│  verify Dash Platform data, and │
│  Lockdown Mode turns it off for │
│  apps. You can exclude Yappr:   │
│  1. Open Settings               │  numbered steps, body
│  2. Privacy & Security          │
│  3. Lockdown Mode               │
│  4. Configure Web Browsing      │
│  5. Turn Yappr off              │
│  ┌───────────────────────────┐  │
│  │       Open Settings       │  │  primary block → app settings URL
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │    Browse saved posts     │  │  outline block → read-only cache
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

- In "Browse saved posts" mode, a persistent banner reads "Lockdown Mode is on. You're browsing saved posts." with "Fix" (back to this screen); every write control shows "Unavailable in Lockdown Mode" on tap.

### 4.34 Engine and network states (global)

| State | Where | Look |
| --- | --- | --- |
| Booting, cached content | Everywhere | Network chip dot pulses; no other indicator |
| Booting, no cache | The list being shown | Skeletons + "Connecting to Dash Platform…" |
| Offline | Current screen | Offline banner (2.18); write taps → toast |
| Couldn't connect | Current screen | "Couldn't connect" banner with "Try again" |
| Unavailable reads | The list | Inline error state (2.16) with the categorized message |
| Engine restarting | Nowhere visible | Lists keep content; in-flight writes keep their "Posting…" / "Sending…" while the app checks them |
| Network sheet | From the chip | Bottom sheet, medium detent: chip, "Yappr is running on a Dash Platform devnet. Posts and accounts may be reset." / testnet copy, and the connection line (`network.state`). No diagnostics link |

### 4.35 Image viewer

- **Route** `/media` (root transparent modal). Black background (`#000000`), the image fitted, pinch to zoom (max 4×), double-tap to zoom 2× (double-tap does **not** like here), swipe down to dismiss (background fades with the drag), swipe sideways between items of the same post.
- Top bar (fades on tap): close ×, "1 / 3". Bottom bar: Share (native share of the image URL), "Save" (save to Photos / Pictures; needs the add-only photo permission, asked on first use), and the post's like button.
- Gated media never opens here before "Show".

### 4.36 App lock screen

- Full-screen `bg`, the app icon 72 centered, "Yappr is locked" (`headline`), "Unlock" (primary). Opens the OS prompt automatically on appear. Shown in the app-switcher snapshot.

### 4.37 Signed-out placeholders

| Tab or screen | Icon | Title | Description | Button |
| --- | --- | --- | --- | --- |
| Home → Following | users icon | "See posts from people you follow" | "Sign in to see posts from people you follow." | "Sign in" |
| Notifications | `BellIcon` | "Sign in to see your notifications" | "Likes, replies, follows and mentions show up here." | "Sign in" |
| Messages | `EnvelopeIcon` | "Sign in to read your messages" | "Private 1-on-1 and group conversations." | "Sign in" |
| Profile | `UserIcon` | "Sign in to post, follow and message" | "You can keep browsing without an account." | "Sign in" |

### 4.38 Unlock messages sheet

- Bottom sheet (large detent). First "Unlocking your messages…" with a spinner (the automatic recovery). On success the sheet closes onto the inbox with the toast "Messages unlocked", with no "recovered" step. If recovery can't work, the manual form: title "Unlock your messages", body `dm.unlock.body`, one secure field (placeholder "Paste your encryption key"), error line, "Unlock" (primary block); success is the same "Messages unlocked". The key's formats are named only in the error for text that is not a key (`dm.unlock.invalid`); a key that is one but not this account's reads `dm.unlock.mismatch`. Sentence case, no "!".

### 4.39 Report sheet and block sheet

- **Report** (SAFE-04): bottom sheet, large detent, scrollable. Title "Report post" / "Report reply". The form shows at once: the one-line disclosure `report.disclosure` (`subhead`, `text.secondary`), "What is wrong with it?" with 9 radio rows (label `body.strong`, hint `subhead` `text.secondary`), "Details (optional)" text area with counter "0/500", "Report post" (primary block, `destructive.fill` is **not** used: reporting is not destructive). The viewer's existing report is read beside the form, never in front of it; found, it replaces the form. A failed read never blocks the report: a `DUPLICATE` refusal toasts `report.duplicate` and shows the existing report. "Reporting…" until the engine has the report; then, confirmed or not confirmed yet, `report.sent` with "Also block @x" (outline) and "Done". The network's answer is reconciled in the background; only a report proven not to have landed (or refused) brings the form back, with the toast `toast.reportFailed`. A post that cannot be read shows `report.loadFailed` with "Try again".
- **Existing report**: `report.existing` (date, reason, "Under review" or "Resolved: {outcome}"), the note, the moderators' resolution text when there is one, `report.expiry` (muted), "Withdraw report" (outline) and "Done" (primary). "Withdraw report" asks first (confirm dialog, `report.withdrawConfirm`), then withdraws optimistically: toast "Report withdrawn" and the sheet closes at once. A withdrawal proven not to have landed brings the report back with `toast.withdrawFailed`; a report already gone toasts `toast.reportGone` (neutral). A sheet reopened while a withdrawal is still settling shows "Report withdrawn", never Withdraw again.
- **Report by email** (SAFE-05): where the contract takes no reports (testnet), and where it waits for an elected moderation team that is not seated (decided before the form, `safety.reportsOpen`): title `report.emailTitle`, body `report.emailBody`, the same reasons and details, and "Email the Yappr team" (disabled until valid), which opens the mail composer prefilled with the post's link, the reason and the details. The link is never shown on the sheet. A late `MODERATION_NOT_SEATED` refusal shows the same view with the warning `report.notSeated` above it, keeping what was chosen.
- **Block** (SAFE-01): bottom sheet, medium detent. Title "Block @x?", the body for the network's Messages (`block.body*`), an "Add a note" link that opens the note field (counter at 260+/280, hint "Anyone can see this note."), "Block" (destructive block), "Cancel" (ghost). On DM v5 the Block also blocks them in Messages (and Unblock lifts both), so one Block covers everything; from a conversation's menu it opens the same sheet.

---

## 5. Copy deck

Short, friendly, outcome first. Mention Dash Platform only when it changes what is private, permanent or costly, or what the user must do (public posts, blocks and reports; keys; credits). Toasts: one sentence at most. Sheets and dialogs: two sentences at most. Mobile owns its copy; (web) strings are a starting point, not a constraint.

Sentence case everywhere except the network chip, and "Sign in", never "Log in". Strings marked **(web)** started as the web app's text.

### 5.1 Onboarding and sign-in

| Key | String |
| --- | --- |
| welcome.tagline | The decentralized social platform where you own your data, your identity, and your voice. **(web)** |
| welcome.signIn | Sign in |
| welcome.browse | Browse without signing in |
| signin.title | Sign in with your Dash wallet |
| signin.subtitle | Approve one request in your wallet. Your keys never leave it. |
| signin.openWallet | Open wallet |
| signin.otherDevice | Use a wallet on another device |
| signin.other | Other ways to sign in |
| signin.privateKey | Sign in with a private key |
| signin.newToDash | New to Dash? Create an identity **(web: "New to Dash?")** |
| signin.noWallet | Yappr uses a Dash wallet for your identity. No wallet on this phone handles Dash sign-in links. |
| signin.getWallet | Get a Dash wallet |
| signin.nothingOpened | Nothing opened? No wallet app on this device handles Dash links. Scan the QR code with a wallet on another device, or copy the link into your wallet. **(web)** |
| signin.waiting | Waiting for your wallet… |
| signin.waitingHint | Approve the request in your wallet, then come back here. |
| signin.openAgain | Open wallet again |
| signin.qrTitle | Scan with your Dash wallet |
| signin.qrHint | Open your wallet on the other device and scan this code. |
| signin.copyLink / copied | Copy link / Copied **(web)** |
| signin.approved | Wallet approved. Unlocking your keys **(web)** |
| signin.checking | Checking your identity **(web)** |
| signin.signingIn | Signing you in **(web)** |
| signin.signedIn | Signed in **(web)** |
| signin.noResponse | No response from your wallet yet **(web)** |
| signin.noResponseHint | Approve the request in your wallet, then check again for a fresh code. **(web)** |
| signin.checkAgain | Check again **(web)** |
| signin.failed | Sign-in failed **(web)** |
| signin.createFailed | Couldn't reach your wallet / Something went wrong while creating the sign-in request. **(web)** |
| signin.wrongNetwork | This wallet is on a different network. Switch your wallet to {network} and try again. |
| signin.noIdentity | No identity was found for this wallet on {network}. |
| keyreg.title | First time login (web: "First Time Login", sentence-cased here) |
| keyreg.body | Yappr needs to add keys to your identity. Your wallet signs this once. |
| keyreg.list | Keys to be added: **(web)** |
| keyreg.continue | Continue in wallet |
| keyreg.finishing | Finishing setup… This can take up to a minute. |
| keyreg.still | Still confirming. We'll keep checking. |
| keyreg.checkNow | Check now |
| key.title | Sign in with a private key |
| key.placeholder | WIF or hex private key |
| key.note | Your key stays on this device. Every signature happens locally. **(web)** |
| key.found | Identity found **(web)** |
| key.matches | Key matches this identity **(web)** |
| key.invalid | Invalid private key **(web)** |
| key.otherNetwork | This key is for a different network **(web)** |
| key.noIdentity | No identity uses this key **(web)** |
| key.mismatch | Private key does not match this identity **(web)** (also a key of the identity with another purpose, e.g. an encryption key) |
| key.show / hide | Show key / Hide key |
| terms.title | Before you start |
| terms.intro | Yappr is a public network. By continuing you agree to: |
| terms.rule1 | No harassment, hate, threats or illegal content. There is zero tolerance for abuse. |
| terms.rule2 | Reported content can be removed by the community's moderators, and abusive accounts can be banned. |
| terms.rule3 | You can block anyone, and report posts that break these rules. |
| terms.rule4 | What you post is public and permanent on Dash Platform. |
| terms.agree | Agree and continue |
| terms.notNow | Not now |
| username.cardTitle | Get a username |
| username.cardBody | Usernames make you easy to find. Register one on yap.pr. |
| username.cardAction | Open yap.pr |
| accounts.title | Accounts |
| accounts.add | Add account |
| signout.title | Sign out of @{name}? |
| signout.body | Your keys for this account are removed from this phone. Your posts and data stay on Dash Platform. |
| signout.confirm | Sign out |
| lock.title | Yappr is locked |
| lock.unlock | Unlock |
| session.expired | Your session has expired. Please sign in again. (web says "log in") |
| accounts.signInAgain | Sign in again **(AUTH-14: the account-list button, the write-control sheet's title and button)** |
| accounts.reauthFailed | Couldn't start signing in again. Please try again. |
| signin.reauth | Sign in again as @{name} with its wallet or key. |
| signInPrompt.reauthBody | Sign in again to keep posting as @{name}. You can keep browsing in the meantime. |
| accounts.signingInAs | Signing in as @{name}… **(AUTH-14: the one full-screen progress label of signing in again, both while the app parks the current account before the sign-in flow and while it reloads the account just signed in, to load its other keys)** |
| signin.alreadySignedIn | You're signed in as @{current}. Add @{x} as another account? / (without @{x}) Add this account too? / (without @{current}) Another account is signed in. … (the engine refused a sign-in beside the active account; on the key screen with the action "Add account") |
| signin.walletKeyDisabled | This wallet's Yappr key was turned off, so it can't sign in. Add a new key from your wallet, or sign in with a private key. **(AUTH-14: the "Sign-in failed" message. A disabled key can't be re-enabled, so never "Reconnect wallet")** |

### 5.2 Home

| Key | String |
| --- | --- |
| home.forYou / following | For You / Following **(web)** |
| home.recent / top | Recent / Top **(web)** |
| window.3days / 24h / all | 3 days / 24h / All time **(web)** |
| home.connecting | Connecting to Dash Platform… **(web)** |
| home.empty.forYou | No posts yet / Be the first to share something! **(web)** |
| home.empty.following | Your following feed is empty / Follow some people to see their posts here! **(web)** |
| home.empty.following.action | Explore |
| home.empty.top | No liked posts yet / The most-liked posts will appear here **(web)** |
| home.empty.topFollowing | No liked posts yet / The most-liked posts from people you follow will appear here **(web)** |
| home.signedOut.following | See posts from people you follow / Sign in to see posts from people you follow. |
| home.newPosts | Show {N} new posts / Show 1 new post **(web)** |
| list.end | You've reached the end. **(web)** |
| list.legacy | Looking for older posts? Open Yappr classic ↗ (testnet feed ends only) |
| list.loadMore | Load more |
| post.reposted | {name} reposted / You reposted |

### 5.3 Post detail, stubs and engagements

| Key | String |
| --- | --- |
| post.title / reply.title | Post / Reply |
| post.notFound | Post not found **(web)** |
| post.loading | Loading post… **(web)** |
| replies.loading | Loading replies… **(web)** |
| replies.empty | No replies yet. Be the first to reply! **(web)** |
| replies.continue | Continue thread **(web)** |
| replies.replyingTo | Replying to @{handle} **(web)** |
| replybar.placeholder | Post your reply |
| replybar.signedOut | Sign in to reply |
| post.cantReplyDeleted | This post was deleted, so it can't be replied to. **(web)** |
| post.cantReplyRemoved | This post was removed by moderators, so it can't be replied to. |
| stub.removed | This {post\|reply} was removed by community moderators. **(web)** |
| stub.reason | Reason: {reason} **(web)** |
| stub.deleted | This {post\|reply} was deleted by its author. **(web)** |
| stub.failed | This {post\|reply} could not be loaded. Try again later. **(web)** |
| stub.unavailable | This {post\|reply} is unavailable. **(web)** |
| stub.blockedReply | Reply from an account you blocked |
| stub.blockedPost | Post from an account you blocked |
| private.title | Private post |
| private.body | Only approved followers can see this. (with "Open on yap.pr") |
| private.open | Open on yap.pr |
| poll.votes | {N} votes |
| poll.endsIn / ended / noEnd | Ends in {time} / Ended / No end date |
| poll.vote | Vote on yap.pr |
| poll.unavailable | Poll unavailable |
| media.unavailable | Image unavailable |
| media.changed | Media changed since posting **(web)** |
| post.showMore | Show more |
| engagements.title | Post engagements |
| engagements.tabs | Quotes / Reposts / Likes |
| engagements.empty.quotes | No quotes yet / When people quote this post, they'll appear here. **(web)** |
| engagements.empty.reposts | No reposts yet / When people repost this post, they'll appear here. **(web)** |
| engagements.empty.likes | No likes yet / When people like this post, they'll appear here. **(web)** |

### 5.4 Compose and write status

| Key | String |
| --- | --- |
| compose.placeholder | What's on your mind? **(web)** |
| compose.thread | Continue your thread... **(web)** |
| compose.reply | Post your reply |
| compose.quote | Add a comment |
| compose.post / reply / postAll | Post / Reply / Post all ({N}) **(web)** |
| compose.addThread | Add to thread **(web)** |
| compose.remove | Remove this post **(web)** |
| compose.nsfw | NSFW |
| compose.nsfwLabel | Mark this post as NSFW **(web)** |
| compose.counter | {n} (the characters left; negative past the limit) |
| compose.counterLabel | {n} characters left / 1 character left / Too long by {n} |
| compose.tooLong | Your post is too long. |
| compose.mentionNote | Only @{first} will be notified. (dev, with 2 or more different mentions; muted) |
| compose.imageLink | Add image link / Remove image link (toggle a11y) / Paste an image link (placeholder) / Image link (field a11y) |
| compose.imageLink.invalid / tooLong | That doesn't look like an image link. / That link is too long. |
| compose.offline | You're offline |
| compose.close.save / delete / cancel | Save draft / Delete draft / Cancel |
| status.posting | Posting… |
| status.threadProgress | Posting {i} of {n}… |
| status.unconfirmed | Couldn't confirm (only once the automatic checks ran out; with " · Edit", never Retry) |
| status.failed | Couldn't post |
| status.retry / edit | Retry / Edit |
| status.partial | Posted {i} of {n} · Retry the rest |
| toast.postCreated | Posted |
| toast.quoteCreated | Quote posted |
| toast.threadCreated | Thread posted |
| toast.replyPosted | Reply posted |
| toast.postFailed | Couldn't post. Try again. (a refusal, and a post a check proved absent; with Retry when the engine allows one) |
| toast.postUnconfirmed | We couldn't confirm your post. Check your profile before posting it again. (once, when the automatic checks ran out) |
| toast.threadPartial | Thread partly posted. Post {n} didn't go through. (the engine's reason goes to diagnostics; a code with mobile copy, §5.4.1, says that instead: "Thread partly posted. You don't have enough credits…") |
| toast.alreadyQuoted | You have already quoted this. **(web)** |
| toast.mediaUnreadable | That image link didn't work. Edit the post to fix or remove it. (action: Edit; the engine's `MEDIA_UNREADABLE`) |
| probe.unclear | Check your profile to see whether part {n} posted. (diagnostics: why a check could not settle a part) |

#### 5.4.1 Write failures (every write)

A failed write toasts one sentence: the mobile copy for its engine code when the user can act on it, else the write's own failure sentence. The same sentence is used for a refusal and for a write a check proved absent. Web's `categorizeError` text and the consensus code go to diagnostics only. A write whose outcome is unknown says nothing while the app checks it (§2.4.11); no toast, card or bubble says "Not confirmed yet", "Check again", "Already updated" or "may still go through".

| Engine code | String |
| --- | --- |
| `INSUFFICIENT_CREDITS` | You don't have enough credits for this. Top up from your Dash wallet. |
| `INSUFFICIENT_YAPP` | You need YAPP for this. (action: Get YAPP, opens yap.pr; never Retry) |
| `NOT_OWNER`, `MODERATION_BARRED` | You can't do this from this account. |
| `TARGET_GONE` | This post no longer exists. |
| `APP_OUTDATED`, `STALE` | Update Yappr and try again. |
| `BUILD_DEFECT` | Something went wrong. Nothing was charged. Please report this. |
| `MEDIA_UNREADABLE` | That image link didn't work. Edit the post to fix or remove it. |
| `NONCE_CONFLICT` | None: it may be this very write executing, so it is checked like any unknown outcome, never re-sent |
| `PARENT_TOO_YOUNG`, `FEE_CHANGED` | None at first: the engine sends the write again by itself after 2, 5 and 15 s (Platform refused it, so nothing can be duplicated), then the default |
| `FEE_SHARE_MISMATCH` | The default, at once: the app and the contract disagree about the fee, so a re-send would be refused (and charged) the same way |
| Anything else (sponsor fees, ownership, private feed sync, the engine's own restarts) | The write's failure sentence (below) |

| Write | Failure sentence |
| --- | --- |
| Post, reply, quote, thread | Couldn't post. Try again. |
| Like / unlike | Couldn't like this post. Try again. / Couldn't unlike this post. Try again. |
| Repost / undo | Couldn't repost this post. Try again. / Couldn't undo your repost. Try again. |
| Bookmark / remove | Couldn't bookmark this post. Try again. / Couldn't remove your bookmark. Try again. |
| Follow / unfollow | Couldn't follow this account. Try again. / Couldn't unfollow this account. Try again. |
| Delete | Couldn't delete post. Try again. / Couldn't delete reply. Try again. |
| Block / unblock | Couldn't block @{handle}. Try again. / Couldn't unblock @{handle}. Try again. ("this account" when the handle is unknown) |
| Profile | Couldn't save your profile. Try again. |
| Report / withdraw | Couldn't send your report. Try again. / Couldn't withdraw your report. Try again. |
| Message | Couldn't send your message. Try again. |
| Group change | Couldn't update the group. Try again. / Couldn't leave the group. Try again. / Couldn't create the group. Try again. |

A like, repost, bookmark or reply on a post this device just made and has not seen confirmed waits for it (up to about two minutes) and then goes, with no toast; the button never refuses with "try again in a moment". A bare repost's like, repost and bookmark buttons show a spinner and take no taps until the viewer's marks have loaded.

### 5.5 Engagement

| Key | String |
| --- | --- |
| repost.menu | Repost / Undo repost / Quote / View your quote **(web, "Undo Repost" in sentence case)** |
| toast.reposted | Reposted! **(web)** |
| toast.repostRemoved | Removed repost **(web)** |
| toast.quoteDeleted | Quote deleted **(web)** |
| toast.likeFailed | Couldn't like this post. Try again. (§5.4.1) |
| toast.repostFailed | Couldn't repost this post. Try again. (§5.4.1) |
| toast.bookmarkAdded / removed | Added to bookmarks / Removed from bookmarks **(web)** |
| toast.linkCopied | Link copied to clipboard **(web)** |
| menu.follow / unfollow | Follow @{handle} / Unfollow @{handle} **(web)** |
| menu.engagements | View post engagements **(web)** |
| menu.copyLink | Copy link |
| menu.share | Share… |
| menu.delete | Delete post / Delete reply **(web)** |
| menu.block | Block @{handle} **(web)** |
| menu.report | Report post / Report reply **(web)** |
| menu.deleteQuote | Delete your quote **(web)** |
| delete.title | Delete post? / Delete reply? **(web)** |
| delete.body | This can't be undone. Replies and quotes will show that it was deleted. **(web)** One string on every contract, whether a delete erases the document or leaves a tombstone. |
| toast.deleted | Post deleted / Reply deleted **(web)** |
| bookmarks.title | Bookmarks |
| bookmarks.search | Search bookmarks **(web)** |
| bookmarks.empty | Save posts for later / Don't let the good ones fly away! Bookmark posts to easily find them again. **(web)** |
| bookmarks.loading | Loading bookmarks… **(web)** |
| bookmarks.remove | Remove bookmark |
| bookmarks.clearAll | Clear all bookmarks |
| bookmarks.clearConfirm | Clear all bookmarks? / This removes every saved post. It can't be undone. |
| toast.bookmarksCleared | All bookmarks cleared **(web)** |
| toast.bookmarksPartial | Some bookmarks could not be removed **(web)** |
| share.text | {name} on Yappr |

### 5.6 Profiles

| Key | String |
| --- | --- |
| profile.edit | Edit profile **(web)** |
| profile.follow / following / followBack | Follow / Following / Follow back **(web)** |
| profile.unfollowConfirm | Unfollow @{handle}? / Unfollow |
| toast.following / unfollowed | Following! / Unfollowed **(web)** |
| toast.followFailed | Couldn't follow this account. Try again. (§5.4.1) |
| profile.followSelf | You cannot follow yourself **(web)** |
| profile.message | Message {name} **(web)** |
| profile.share | Share profile **(web)** |
| profile.copyLink | Copy profile link |
| toast.profileLinkCopied | Profile link copied! **(web)** |
| toast.idCopied | Identity ID copied **(web)** |
| profile.tabs | Posts / Replies / Top / Mentions **(web)** |
| profile.empty.posts | No original posts yet **(web)** |
| profile.empty.replies | No replies yet **(web)** |
| profile.empty.top | No liked posts yet **(web)** |
| profile.empty.mentions | No mentions yet / Posts that mention this user will appear here **(web)** |
| profile.notFound | User not found **(web)** |
| profile.invalid | Invalid identity ID **(web)** |
| profile.nsfw | This profile may contain adult content / {name} marked their profile as NSFW. / Go back / View profile **(web)** |
| profile.blocked.own | You blocked this user / You won't see their posts in your feeds **(web)** |
| profile.blocked.list | This user is blocked / Blocked by a block list you follow. You won't see their posts in your feeds **(web)** |
| profile.aka | Also known as {names} |
| profile.joined | Joined {Month YYYY} |
| edit.title | Edit profile |
| edit.dashpayNote | Your name and bio also show in other Dash apps, like DashPay. (dev, under Bio) |
| edit.fields | Name / Bio / Pronouns / Location / Website / Banner image link **(web: Name, Pronouns, Location, Website)** |
| edit.nsfw | NSFW Content / Mark your profile as containing adult content **(web)** |
| edit.saving | Saving… |
| toast.profileUpdated | Profile updated! **(web)** |
| toast.profileFailed | Couldn't save your profile. Try again. (§5.4.1) |
| toast.profilePartial | Couldn't save {fields}. Try again. ({fields}: what the second document held, "pronouns, location and website"; "banner", "NSFW setting") / Couldn't save all of your changes. Try again. (only an avatar) |
| edit.discard | Discard changes? / Discard / Keep editing |
| avatar.change | Change avatar |
| avatar.modes | Generated / Image link |
| avatar.seed / randomize | Seed / Randomize |
| avatar.use | Use this avatar |
| avatar.error | Couldn't load this image |
| lists.followers / following | Followers / Following **(web)** |
| lists.searchPlaceholder | Search by username... **(web)** |
| lists.noMatch | No users found with that name **(web)** |
| lists.empty.followers | No followers yet / Share interesting content to gain followers **(web)** |
| lists.empty.following | Not following anyone yet / Find interesting people to follow on Yappr **(web)** |
| lists.error | Could not load {followers}. Check your connection and try again. **(web)** |
| row.followsYou | Follows you |

### 5.7 Explore and search

| Key | String |
| --- | --- |
| explore.title | Explore |
| explore.search | Search Yappr **(web: search page title)** |
| explore.segments | Trending / Top / Creators |
| explore.trending.loading | Loading trending hashtags… **(web)** |
| explore.trending.empty | No trending tags yet / Post with #hashtags or $cashtags to see them here! **(web)** |
| explore.trending.count | {N} posts (v2) / {N} likes (`topSort` on) **(web)** |
| explore.top.loading | Loading top posts… **(web)** |
| explore.top.empty | No liked posts yet / The most-liked posts will appear here **(web)** |
| explore.creators.likes | {N} likes |
| search.sections | People / Hashtags / Recent posts |
| search.seeAll | See all |
| search.searching | Searching… **(web)** |
| search.noResults | No results for "{q}" / Try searching for something else **(web second line)** |
| search.minChars | Type at least 3 characters to search for people |
| search.recent / clear | Recent / Clear |
| hashtag.segments | Latest / Top |
| hashtag.loading | Loading posts with {#tag}… **(web)** |
| hashtag.loadingTop | Loading top posts with {#tag}… **(web)** |
| hashtag.empty / emptyTop | No posts yet / No liked posts yet **(web)** |
| hashtag.loadMore | Load more posts **(web)** |

### 5.8 Notifications and messages

| Key | String |
| --- | --- |
| notif.title | Notifications **(web)** |
| notif.markAll | Mark all as read **(web)** |
| notif.settings | Notification settings **(web)** |
| notif.filters | All / Likes / Reposts / Replies / Follows / Mentions **(web)** |
| notif.phrase | started following you / mentioned you in a post / liked your post / reposted your post / quoted your post / replied to your post **(web)** |
| notif.grouped | {name} and {N} others liked your post |
| notif.nsfw | NSFW content **(web)** |
| notif.loading | Loading notifications… **(web)** |
| notif.empty.all | When someone interacts with you, you'll see it here **(web)** |
| notif.empty.likes | When someone likes your post, you'll see it here **(web)** |
| notif.empty.reposts | When someone reposts or quotes your post, you'll see it here **(web)** |
| notif.empty.replies | When someone replies to your post, you'll see it here **(web)** |
| notif.empty.follows | When someone follows you, you'll see it here **(web)** |
| notif.empty.mentions | When someone mentions you, you'll see it here **(web)** |
| notif.unknown | Unknown user |
| dm.title | Messages **(web)** |
| dm.search | Search messages **(web)** |
| dm.new / newGroup | New message / New group **(web)** |
| dm.settings | Message settings **(web)** |
| dm.welcome | Welcome to Messages / Private 1-on-1 and group conversations. Messages are encrypted, and nobody watching Dash Platform can tell who you talk to. **(web)** |
| dm.welcome.v3 | Welcome to Messages / Private 1-on-1 conversations. Messages are encrypted. |
| dm.list.empty | Your conversations will appear here **(web)** |
| dm.list.noMatch | No conversations match your search **(web)** |
| dm.you | You: **(web)** |
| dm.restoring | Restoring your messages **(web)** |
| dm.restoring.steps | Finding conversations people started with you / Checking recent chats with people you follow / Finding your groups / Checking older chats with people you follow **(web)** |
| dm.locked | Unlock your messages / Your messages are encrypted. Unlock them to read and send them on this device. / Unlock messages |
| dm.unlock.recovering | Unlocking your messages… |
| dm.unlock | Unlock your messages / Your messages are encrypted. Paste your encryption key to read and send them on this device. / Unlock |
| dm.unlock.placeholder | Paste your encryption key |
| dm.unlock.done | Messages unlocked |
| dm.unlock.invalid | That doesn't look like an encryption key. It's a WIF or 64-character hex key from yap.pr. |
| dm.unlock.mismatch | That isn't the encryption key for this account's messages. (another account's key, another of this account's keys, or another network's) |
| dm.thread.empty | No messages yet. Start the conversation! **(web)** |
| dm.composer | Type a message... **(web)** |
| dm.send | Send message **(web)** |
| dm.status | Sending… / Sent / Read / Not delivered · Tap to retry / Not delivered · Tap to edit / Couldn't confirm · Tap to check (only once the automatic checks ran out) |
| toast.dmNotSent | Message not sent. It's back in the message box. (a send the engine never took) |
| dm.copy | Copy |
| dm.newMessage.desc | Choose a person to start an encrypted conversation. **(web)** |
| dm.picker.search | Search by username... **(web)** |
| dm.picker.hint | Type at least 3 characters to search, or paste a full identity ID **(web)** |
| dm.picker.notFound | No user found with this identity ID **(web)** |
| dm.picker.invalid | Invalid identity ID **(web, `profile.invalid`)** (pasted text that looks like an identity ID but does not decode to 32 bytes) |
| dm.picker.noFollowers | No followers yet — search for a username above. **(web)** |
| dm.picker.self | You can't message yourself |
| dm.newGroup.desc | Name the group and pick its members. **(web)** |
| dm.group.name | Group name **(web)** |
| dm.group.create | Create group **(web)** |
| dm.group.max | A group can have at most 100 members. **(web)** |
| dm.group.createFailed | Could not create the group **(web)** |
| dm.group.creating | Creating group… |
| dm.group.keysFailed | 1 member hasn't been added to {group} yet. / {n} members haven't been added to {group} yet. / (the inbox has not read the name) 1 member hasn't been added yet. / {n} members haven't been added yet. (action: Retry; only once the app's own resends are used up, for members whose every resend proved it failed) |
| dm.group.info | Group info |
| dm.group.owner | Owner **(web)** |
| dm.group.rename / renamed | Rename / Group renamed **(web)** |
| dm.group.add | Add members |
| dm.group.addNote | New members can read messages sent after they join. **(web)** |
| dm.group.remove | Remove {name} from the group? / They won't see new messages. / Remove / Member removed |
| dm.group.reinvite | Re-invite / Invite sent (owner's member menu) |
| dm.group.end | End this group? / Nobody will be able to send messages to it any more. This cannot be undone. / End group / Group ended **(web)** |
| dm.group.leave | Leave group? / You'll stop getting messages from this group. / Leave / You left the group |
| dm.state.ended | This group has ended. **(web)** |
| dm.state.left | You are no longer a member of this group. **(web)** |
| dm.state.noKeys | Waiting for access to this group. If this doesn't clear, ask the owner to re-invite you. (composer banner) / Waiting for access… (inbox preview) |
| dm.state.blocked | You blocked this person. Unblock them to send messages. **(web)** |
| dm.archive | Archive conversation (menus) / Archive (iOS swipe) |
| toast.dmArchived | Conversation archived (action: Undo) |
| toast.dmArchiveFailed | Couldn't archive the conversation. Try again. |
| dm.archived.show / hide | Archived ({N}) / Hide archived |
| dm.list.allArchived | No conversations yet |
| dm.retention | Delete old sent messages (never "disappearing messages") |
| dm.retention.options | Never / After 30 days / After 90 days / After 1 year |
| dm.retention.footer | Deleting old sent messages refunds most of their storage fee. It doesn't make them private: people you messaged keep their copies, and Dash Platform keeps a history. |
| dm.blocked.empty | No blocked accounts / Messages and group invites from people you block are ignored. |

### 5.9 Safety

| Key | String |
| --- | --- |
| block.title | Block @{handle}? |
| block.body | You won't see their posts or replies. Blocks are public on Dash Platform. **(no Messages capability; also DM v5 while Messages are locked on this device, where the block in Messages waits until they unlock here)** |
| block.body.legacyDm | You won't see their posts or replies. They can still message you, but it won't show as unread. Blocks are public on Dash Platform. **(testnet: legacy DMs follow the account's blocks)** |
| block.body.v5Dm | They won't be able to message you, and you won't see their posts or replies. Blocks are public on Dash Platform. **(devnet: the Block also blocks them in Messages, DM-10; Unblock lifts both)** |
| block.addNote | Add a note |
| block.note | Note |
| block.noteHint | Anyone can see this note. |
| block.confirm | Block |
| toast.blocked | Blocked @{handle} |
| toast.unblocked | Unblocked @{handle} |
| toast.stillBlocked | Unblocked, but a block list you follow still hides them. |
| block.self | You cannot block yourself **(web)** |
| toast.blockFailed | Couldn't block @{handle}. Try again. / Couldn't unblock @{handle}. Try again. (§5.4.1) |
| toast.unblockFailed | Couldn't unblock @{handle}. Try again. **(a DM v5 conversation's Unblock when the account's block can't be read)** |
| blocked.title | Blocked accounts |
| blocked.empty | You haven't blocked anyone |
| blocked.listsNote | Also hidden by {N} block list(s) you follow · Manage on yap.pr ("1 block list", "2 block lists"; only when N ≥ 1) |
| report.title | Report post / Report reply |
| report.disclosure | Reports are public. Anyone, including the author, can see that you reported this, your reason and any details. |
| report.question | What is wrong with it? **(web)** |
| report.reasons | Spam or scam — Repetitive, misleading or fraudulent content / Harassment or bullying — Targeting, insulting or intimidating someone / Hate — Attacking people for who they are / Violence or threats — Threatening, inciting or glorifying violence / Sexual content — Explicit sexual content / Self-harm — Encouraging suicide or self-injury / Illegal goods or activity — Selling or promoting something illegal / Impersonation — Pretending to be someone else / Something else — Say what in the details **(web, `lib/reports.ts`)** |
| report.details | Details (optional) / Details (required) **(web)** |
| report.placeholder | Anything the moderators should know **(web)** |
| report.submit / busy | Report {post} / Reporting… **(web)** |
| report.sent | Report sent / Thanks for letting us know. |
| toast.reportSent | Report sent (only when the sheet closed before it could say so: before the engine took the report, or while it was on its way; once per report) |
| toast.reportFailed | Couldn't send your report. Try again. |
| report.duplicate | You already reported this. |
| report.gone | This {post\|reply} no longer exists. |
| report.loadFailed | Couldn't load this {post\|reply}. Try again. |
| report.existing | You reported this on {date} for {reason} · Under review / · Resolved: {No action taken \| Content removed \| Author actioned} |
| report.expiry | Reports close after 90 days. |
| report.withdraw / withdrawing | Withdraw report / Withdrawing… **(web)** |
| toast.reportWithdrawn | Report withdrawn **(web)** |
| report.withdrawConfirm | Withdraw your report? / The moderators will no longer see it. / Withdraw |
| toast.reportGone | This report was already closed. |
| toast.withdrawFailed | Couldn't withdraw your report. Try again. |
| report.emailTitle | Report by email |
| report.emailBody | Reports go to the Yappr team by email for now. Your email app opens with a link to the post and the reason you chose. |
| report.email | Email the Yappr team |
| report.emailSubject | Report: post {id} |
| report.emailBodyDraft | {link} / Reason: {reason} / {details} (the mail's body, prefilled) |
| report.notSeated | Your report wasn't sent. Send it by email instead. |
| toast.reportCopied | Report address copied. Send it from any email app. |
| report.alsoBlock | Also block @{handle} |
| nsfw.cover | NSFW · The author flagged this post **(web)** |
| nsfw.show | Show **(web)** / label: Show post flagged as NSFW **(web)** |
| mediaGate.text | Media from someone you don't follow **(web)** |
| mediaGate.show | Show **(web)** |

### 5.10 Settings

| Key | String |
| --- | --- |
| settings.sections | Account / Notifications / Privacy & Safety / Messages / Appearance / About |
| settings.account | {name} / @{handle} (no balance) |
| settings.version | Yappr {version} ({build}) |
| account.copyId | Copy account ID / Account ID copied |
| account.usernames | Usernames |
| account.register | Register a username on yap.pr / Register another username on yap.pr (with one already) |
| account.balance | Balance / {0.2567} DASH (4 decimals; < 0.0001 DASH) / {25,674,582,414} credits |
| account.refreshFailed | Couldn't refresh the balance. Please try again. |
| account.yapp | YAPP |
| account.created | Account created (web: "Account Created", sentence-cased here) |
| account.appLock | App lock / Require Face ID / Require Touch ID / Require fingerprint or device PIN |
| account.lockAfter | Immediately / After 1 minute / After 5 minutes / After 15 minutes |
| account.moderation | Your account has been banned or suspended here by a moderator. |
| notifSettings.header | In-app notifications **(web)** |
| notifSettings.note | Yappr checks for new activity while the app is open. |
| notifSettings.types | Likes — When someone likes your posts / Reposts — When someone reposts your content / Replies — When someone replies to you / Follows — When someone follows you / Mentions — When someone mentions you **(web)** |
| privacy.linkPreviews | Link previews / Show previews with titles, descriptions, and images for links (web, title sentence-cased) |
| privacy.linkPreviewsNote | Previews are fetched from the linked website, which can see that your device requested it. |
| privacy.mediaGate | Blur media from people you don't follow / Images and link previews from accounts you don't follow stay hidden behind a blurred placeholder until you tap to reveal them (web, title sentence-cased) |
| privacy.nsfw | NSFW content / Warn first — Cover NSFW posts until you choose to show them / Always show — Show NSFW posts without a warning / Hide — Remove NSFW posts from your feeds **(web)** |
| privacy.blocked | Blocked accounts |
| privacy.readReceipts | Read receipts / Let others see when you've read their messages (web, title sentence-cased) |
| appearance.theme | Theme / System / Light / Dark **(web)** |
| appearance.language | Feed language (web: "Feed Language", sentence-cased here) |
| appearance.languageNote | Choose the language for the "For You" feed. Posts in other languages will not appear. **(web)** |
| appearance.languages | English / Spanish / French / German / Portuguese / Russian / Chinese / Japanese / Korean / Arabic / Hindi / Italian / Dutch / Polish / Turkish **(web)** |
| about.tagline | Decentralized social media on Dash Platform **(web)** |
| about.rows | Terms of Use / Privacy Policy / Community rules / Support / Send diagnostics / Open-source licenses / Yappr on the web |
| about.info | Version |
| about.versionCopied | Version info copied |
| about.versionHint | Long press to copy version info (Version row's accessibility hint) |
| about.sendDiagnosticsTo | Send to {email} (first line of the shared diagnostics) |
| about.troubleshooting | Troubleshooting (About's muted last row) |
| diag.title | Troubleshooting |
| diag.states | Booting / Ready / Restarting / Unavailable (the screen's Engine row only) |
| diag.copy / share | Copy diagnostics / Share diagnostics |
| diag.copied | Diagnostics copied |
| diag.shareAction | Share |
| diag.rows | Boot time / WASM compile / DAPI endpoints / Capabilities / Cache / Errors / Recent errors ({count}) / No errors |
| diag.dapi | {count} · last ok {4s / 3m / 2h} ago / never |
| diag.contract | Social contract / Profile contract / DM contract / Pollr contract / Copy {contract} / {contract} copied |
| diag.reconnect | Reconnect / Reconnect to Dash Platform? Lists reload; nothing you posted is lost. / Reconnect |
| diag.clear | Clear cache / Clear saved posts and lists? Your accounts, keys and drafts stay. / Clear |

### 5.11 Network and engine

| Key | String |
| --- | --- |
| chip.devnet / testnet | DEVNET / TESTNET |
| network.devnet | Yappr is running on a Dash Platform devnet. Posts and accounts may be reset. |
| network.testnet | Yappr is running on Dash Platform Testnet. Posts and accounts may be reset. |
| network.state | Connected / Connecting… / Can't connect right now (booting and restarting both read "Connecting…") |
| offline.banner | You're offline. Showing saved posts. |
| offline.toast | You're offline. Try again when you're connected. |
| engine.couldntConnect | Couldn't connect to Dash Platform. |
| engine.tryAgain | Try again |
| read.retrying | Retrying… (under a list's G-11 error while NET-03's backoff reads it again, §2.16) |
| lockdown.title | Lockdown Mode is blocking Yappr |
| lockdown.body | Yappr needs WebAssembly to verify Dash Platform data, and Lockdown Mode turns it off for apps. You can exclude Yappr: |
| lockdown.steps | Open Settings / Privacy & Security / Lockdown Mode / Configure Web Browsing / Turn Yappr off |
| lockdown.openSettings | Open Settings |
| lockdown.browse | Browse saved posts |
| lockdown.banner | Lockdown Mode is on. You're browsing saved posts. / Fix |
| lockdown.writeBlocked | Unavailable in Lockdown Mode |
| link.unsupported | This link isn't supported in the app / Open in browser |
| update.required | This version of Yappr is out of date with the network. Update the app to keep posting. |

### 5.12 Errors (started from `lib/error-utils.ts`)

Read errors (G-11) show these. Write failures don't: they use §5.4.1, and this text goes to diagnostics.

| Category | String **(web)** |
| --- | --- |
| Unavailable | Dash Platform is temporarily unavailable. Please try again in a few moments. |
| Network | Network error. Please check your connection and try again. |
| Session | Your session has expired. Please log in again. (mobile replaces "log in" with "sign in") |
| Too long (bytes) | This is too long for the network once emoji and special characters are counted. Shorten it and try again. |
| Not supported (`NOT_SUPPORTED`, a view these contracts lack) | This isn't available yet. (mobile; never names the contract or network) |
| Nonce clash | Another write from your account went out at the same moment, so this one was not saved. Try again. |
| Not seated | This isn't available yet. Try again later. (a report shows `report.notSeated` and the email path instead) |
| Barred | Your account has been banned or suspended here by a moderator, so this action isn't allowed right now. |
| Too young | What this depends on was only just published. Wait a minute and try again. |
| Target gone | What this points to no longer exists on Dash Platform, so this action can't be completed. |
| YAPP short (locked) | You don't have enough YAPP. Switch to paying in credits in Settings. (mobile: replaced by G-5 copy, since 1.0 has no payment setting) |
| Credits short, YAPP short | Writes only: §5.4.1 |
| Generic | Something went wrong / Try again |

### 5.13 Accessibility labels

| Element | Label |
| --- | --- |
| FAB | New post |
| Card "⋯" | Post options / Reply options **(web)** |
| Reply | Reply, {N} replies **(web)** |
| Repost | Repost or quote, {N} reposts **(web: "Repost or quote")**; on detail with quotes told apart (§2.4.4): Repost or quote, {N} reposts, {N} quotes (floors read "{N}+", and a floor of 0 is left out, as the counts row leaves it out); active: …, reposted / …, quoted (own quote with text) |
| Like | Like, {N} likes **(web)** / Unlike, {N} likes (mobile) |
| Bookmark | Bookmark / Remove bookmark |
| Share | Share **(web)** |
| Compose close | Close composer **(web)** |
| Avatar (tappable) | {name}'s profile |
| Media gate | Media hidden. Media from someone you don't follow. |
| Network chip | {Devnet\|Testnet}. Data may be reset. {Connected\|Connecting\|Can't connect}. |
| New-posts pill | Show {N} new posts |
| Tab badge | {Notifications\|Messages}, {N} unread |
| Mark all read | Mark all as read |
| Message settings | Message settings **(web)** |
| New conversation | New conversation **(web)** |
| Back in conversation | Back to conversations **(web)** |
| Conversation menu | Conversation options **(web)** |
| Copy ID | Copy identity ID (a post's or profile's author); Settings → Account: Copy account ID |
| Image viewer close | Close image |

---

## 6. Accessibility

### 6.1 Text size

- All text uses the tokens in 1.6 and scales with the OS: iOS Dynamic Type up to AX5 (`allowFontScaling`, sizes multiplied by the content-size category ratio), Android font scale up to 200% (nonlinear scaling on Android 14+ is accepted).
- `maxFontSizeMultiplier`: none for content text (posts, messages, names, settings labels); 1.5 for the tab bar labels, the network chip, badges and the segmented controls, which also expose the iOS Large Content Viewer on long-press. *Proposed in QA wave B (D-L4a-008), pending lead sign-off:* the tab bar's count badge grows as one piece on Android (its 20 pt box and its number together, up to 1.5×), so the number never outgrows its circle.
- *Proposed in QA wave B (D-L4a-005), pending lead sign-off:* navigation bar titles: the Android top app bar title (`title`, 20 sp) scales with the font scale, uncapped, on one line (ellipsized when it doesn't fit). iOS keeps UIKit's navigation bar and large-title fonts.
- At accessibility sizes (iOS AX1+, Android ≥ 160%):
  - post card header wraps to two lines (name on one, handle and time on the next);
  - the action bar hides the counts next to icons (they stay in the labels) and keeps all five icons;
  - user rows move the follow button under the text;
  - settings rows stack value under label;
  - buttons grow in height; labels never truncate (they wrap to two lines).
- Line heights scale proportionally; no fixed-height container holds text, except the chip and badges (which cap their multiplier).

### 6.2 Screen readers

- **Post card:** one accessible element (`accessible`, role `button`) with the label "{name}, @{handle}, {time}. {Reposted by X.} {Replying to @y.} {text}. {Quote: name, text.} {Image: alt or "image"}. {N} replies, {N} reposts, {N} likes." (on detail with quotes told apart: "{N} replies, {N} reposts, {N} quotes, {N} likes.", floors as on the counts row; a count of 1 reads singular, "1 reply", "1 repost", "1 quote", "1 like", and a floor stays plural, "1+ quotes") and custom actions Reply, Repost, Like / Unlike, Bookmark, Share, Open profile, More. The NSFW-covered card says "NSFW post, hidden" and has the action "Show".
- **Focus order:** navigation bar → banners → tabs or segments → list → FAB → tab bar.
- **Headings:** screen titles, section headers and empty-state titles have the header role.
- **Live updates:** toasts and write-status changes are announced once (A11Y-06); counters are not live.
- **Images:** posts' media use `alt` text when present, else "Image"; decorative icons are hidden.
- **Custom controls:** segmented controls and tabs expose role `tab` / `tablist` and selected state; switches use native switches; the NSFW chip in compose is a switch.
- **Escape:** the iOS two-finger Z gesture and Android back close the top sheet or modal.

### 6.3 Contrast

- Every text pair in 1.2 passes WCAG AA (4.5:1, or 3:1 at 18 pt+ / 14 pt bold) in both themes, except the logged exception for white on `accent` fills **[OQ-2]**.
- Non-text controls (icons, switch tracks, focus ring, input borders) are at least 3:1 against their background; `border.strong` is used for input borders for that reason.
- Information is never color-only: active actions also switch to the solid icon; the counter goes negative and its label says "Too long by {n}", with "Your post is too long." under the editor; unread rows also have the dot.

### 6.4 Hit targets

- Minimum 44 × 44 pt (iOS) and 48 × 48 dp (Android) for every interactive element, using `hitSlop` where the visual is smaller (action-bar icons, "Show" pills, chips, ⋯ buttons).
- At least 8 pt between adjacent targets in the action bar.

### 6.5 Motion and effects

- Reduce Motion: 1.8 rules.
- Reduce Transparency (iOS) / no blur (Android): translucent headers and the media-gate frost become solid `bg` / `bg.muted`.
- No autoplaying media in 1.0.

### 6.6 Other

- **Bold Text (iOS):** weights step up one level (400 → 600, 600 → 700).
- **Increase Contrast / high-contrast text:** `text.secondary` becomes `text.primary`, `border` becomes `border.strong`.
- **Keyboard (iPad keyboards on iPhone, Android hardware keyboards):** focus ring per 1.11; ⌘↩ / Ctrl+Enter posts in compose; Escape closes sheets.
  - **Known limit (D-L2a-008): ⌘↩ / Ctrl+Enter is not wired yet.** React Native 0.86 gives JS no hardware-key modifiers in a text field: `TextInput.onKeyPress` reports soft-keyboard keys only on Android and carries no ⌘/Ctrl on iOS, where UIKit inserts nothing for ⌘↩ anyway. It needs native key handling, so a lead-approved dev-client rebuild: on Android RN's experimental `enableKeyEvents` flag (W3C `onKeyDown` with `ctrlKey`/`metaKey`, set at startup by a config plugin), on iOS a `UIKeyCommand` for ⌘↩ from a local module in `modules/`. Until then Post is the button.
- **Test IDs:** every interactive element has a `testID` (PRD A11Y-08); test IDs never double as accessibility labels. *Proposed in QA wave B (D-L4a-011), pending lead sign-off:* an empty state's button is `<empty state testID>-action` (for example `signed-out-notifications-action`). The one exception is the items of native menus (UIMenu, Android's popup menu, such as the Messages ✎ menu's "New message" / "New group"): the OS draws them and takes no test ID, so tests pick them by their title.
