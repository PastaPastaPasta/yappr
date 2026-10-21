# gpt-fox

One mark everywhere: the howling fox head from the browser favicon (#875) is the
icon mark, the lockup's mark, the app tile, the adaptive icon foreground and the
splash.

The fox is a vector trace (vtracer) of a raster illustration the owner picked.
It has six colour families, approximately:
- orange `#fc5e02`, rust `#c03002`, ear orange `#fc891b`;
- peach throat `#f6d2a8` with its shade `#eab27a`;
- brown mouth and nose `#3f130d`.

The trace's fills vary by a step or two within each family.

The throat is a deeper peach than the source's cream, and has a thin rust edge
below the mouth, so it keeps its outline on white. The marks, lockups and tiles
use the trace with whole-number path data in its 1024-unit drawing.
`favicon.svg` and `favicon-16.svg` are #875's files unchanged; the 16 px one is
hand-drawn.

- **Mark** (`mark.svg`, `mark-dark.svg`): the full-colour fox on transparent, its
  bounding box filling the 64-unit square with a 1-unit margin. It reads on light
  and dark pages alike, so the two files are the same.
- **Lockup:** the fox in the old badge's 64-unit slot, followed by the unchanged
  wordmark (ink `#082f49`, sky `#38bdf8` on dark).
- **App tile** (`app-icon.svg`): the fox on ink `#171717`, the app's dark
  surface, with every opaque pixel inside the centred r 340 subject circle.
  Ink was compared with navy `#082f49`, brand blue `#0369a1` and white at 180,
  120 and 60 px; on ink the orange stands out most at small sizes and matches
  the dark app.
- **Foreground** (`app-icon-foreground.svg`): the same fox on transparent inside
  r 300, for the Android adaptive icon and the splash.
- **Mono mark** (`mark-mono.svg`): one black silhouette, inside the inscribed r 31
  circle, so the themed Android icon and the tinted iOS icon survive the masks.

Weakness: it is an illustration rather than a glyph, so it is busier than a
flat mark at small sizes. The SVGs are about 23 KB each.
