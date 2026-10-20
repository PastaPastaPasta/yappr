# Dash-gradient

A vivid sky-to-deep-blue gradient brings a lowercase y into a soft speech bubble.
The bubble signals conversation; the blue links Yappr to its Dash Platform home
without borrowing Dash’s logo or Evolution artwork.

Colors: #38bdf8 → #0ea5e9 → #0369a1 → #075985, plus white.
No extra accent color.
The app-icon background is #ffffff, opaque and full bleed. The gradient
bubble subject is identical in app-icon.svg and app-icon-foreground.svg,
so it also remains visible on white adaptive backgrounds. The OS supplies
the corner mask.

All lettering is hand-authored geometric paths; no font or font license applies.
The matching lowercase wordmarks have identical geometry and deliberate pp spacing.
Dark variants lift the gradient endpoint for visibility on #121212.
The favicon simplifies the bubble to a rounded gradient tile with a white y.

The app-tile subject fits the centered 680px circle; the adaptive foreground
fits the stricter radius-300 circle. SVGs are standalone, with no text or images.
Raster checks use rsvg-convert at 16/32/1024 and #ffffff/#121212 backgrounds.

Weaknesses: the abstract bubble is less distinctive than a mascot, and the
favicon drops the bubble tail to keep its y readable at 16px. The sky-blue end
is intentionally luminous on white; use the deep-blue end for primary UI text.
