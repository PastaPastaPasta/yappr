# Monoline — Speech y

A rounded speech bubble flows into a clear lowercase `y` stroke, connecting Yappr’s
chatty voice to the name without the email-like spiral of the first direction.
The constant-weight line, round caps, and open interior stay friendly and legible.

- Primary: #0369a1; dark-background variant: #38bdf8.
- App-icon background: #0369a1, opaque and square; subject: #ffffff.
- Dash credit alone uses #008de4; light credit lettering uses #0c4a6e.
- No extra accent, gradients, external assets, or fonts.
- All lettering and centerlines are hand-authored SVG paths.
- Mark/wordmark strokes: 6 units; all caps and joins are round.
- Favicon: simplified bubble plus y, with a heavier 7-unit source stroke scaled to 32 units.
- Mono mask: the same centerline expanded to a pure black filled outline.
- Adaptive foreground is white; pair it with the #0369a1 background.
- App subject uses the same geometry at 8x, inside the centered safe zone.

Weakness: the y is intentionally open and may merge with the bubble at very small
nav sizes; use favicon.svg for 16px browser tabs. The mark is line art, so the
transparent mono version depends on the platform applying its tint or background.

Validation: previews are rendered with rsvg-convert at 16, 32, and 1024px on
#ffffff and #121212 in preview/.
