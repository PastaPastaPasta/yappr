# fox-badge — revision 2

A rounded geometric fox yaps out of a deep-blue circular badge.
The open blue mouth notch separates the muzzle and lower jaw;
a restrained white cheek and three rounded yellow ticks add expression.
The lower contour is a deliberate continuous curve, with no neck cut.

Colors: brand blue #0369a1, ink #082f49, orange #ff792e,
white #ffffff, dark-theme sky #38bdf8, footer ink #0c4a6e,
Dash blue #008de4 (credit only), and sound yellow #fdd60f.
Orange preserves the mascot; yellow is the explicitly approved second accent.
App-icon background: #0369a1, opaque and square.

All SVG geometry and lettering are hand-authored; no fonts or font licenses apply.
The sturdy lowercase wordmark is retained. Its baseline is y=46;
rounded bowls overshoot to y=47 and descenders remain inside the 64-unit box.
The footer uses optical advances, including a tighter r/e pair.

The app tile and adaptive foreground use independent enlarged scales.
Rendered subject alpha is checked against radii 340 and 300 respectively.
The monochrome mark is one black fox silhouette, including the mouth notch.
The favicon drops white cheek, nose patch, and sound ticks for 16px clarity.

Weakness: the smallest favicon communicates a fox profile more strongly than sound;
its simplified mouth notch is the remaining barking cue.

Run `python3 build.py` to regenerate SVGs and rsvg-convert previews.
Preview PNGs cover light/dark backgrounds, 16/32px favicon, and 1024px icons.
