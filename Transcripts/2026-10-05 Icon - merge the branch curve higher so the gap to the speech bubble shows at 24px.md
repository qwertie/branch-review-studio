# Icon: merge the branch curve higher so the gap to the speech bubble shows at 24px

## Planning

User (earlier): "hmm on that icon, move the line a little further from the chat bubble"

Commit 9ef62ae widened the gap between the branch curve and the speech bubble from about 1.3 to
about 3 viewBox units. User's reply:

User: "um the gap in that icon is identical to the old gap AFAICT. Remember that the Icon is quite small in the actual app."

F1: The Activity Bar shows the icon at about 24x24 CSS px. Rendered at 24px (stroke #cccccc on
#333, like a dark Activity Bar), the 3606be1 icon has no background pixel between the curve and
the bubble (they form one connected blob), and the 9ef62ae icon has a single background pixel,
which is easy to miss. So the earlier fix was real but invisible at actual size.

Assumptions (unasked, low-stakes cosmetic change):

- A1: The branch curve may merge into the main line anywhere, not only at its old point (6,17),
  since the icon should still read as "git branch".
- A2: Whole-unit coordinates keep the icon crisp at 24px.

## Candidates

Each candidate was rendered at 24px and 36px in headless Edge, upscaled with nearest-neighbor
(`image-rendering: pixelated`) and inspected. "Gap" is the number of background pixels between the
curve and the bubble at 24px (Chebyshev distance, counting faint anti-aliased pixels as ink).

| Code | Curve | Bubble | Gap at 24px | Gap at 36px |
|---|---|---|---|---|
| V0 (3606be1) | `M16 7c0 5-6 5-10 10` | `M13 15...` | 0 (touching) | 0 |
| V1 (9ef62ae) | `M16 7c0 4-7 3-10 10` | `M14 15...` | 1 | 2 |
| A | `M16 7c0 3-6 3-10 6` (merges at y=13) | same as V1 | 2 | 4 |
| B | same as A | smaller, `M15 16h7v4h-3l-2 2v-2h-2z` | 3 | 5 |
| C | `M17 7c0 2-1 3-4 4s-7 1-7 2`, right node at x=17 | same as V1 | 1 | 2 |
| D | `M16 7c0 4-10 2-10 5` (merges at y=12) | same as V1 | 3 | 5 |
| G | `M16 7c0 3-10 1-10 4` (merges at y=11) | same as V1 | 4 | 6 |

D1: Chose D. Its curve drops from the right node, then sweeps left and joins the main line
tangentially at (6,12), like a common git-branch glyph, so it stays far from the bubble (about 4
units edge to edge). B made the bubble look too small, and G squashed the branch against the top
nodes.

## End phase

- media/icon.svg: branch curve is now `M16 7c0 4-10 2-10 5`; nodes and bubble are unchanged.
- media/icon.png re-rendered at 128px with the same headless-Edge recipe as before.
- Comparison image (V0, V1, D at actual 24px, upscaled; D at 240px):
  `%TEMP%\brs-icon\compare-actual.png`.
- Packaged with `npm run package` and reinstalled into VS Code.
