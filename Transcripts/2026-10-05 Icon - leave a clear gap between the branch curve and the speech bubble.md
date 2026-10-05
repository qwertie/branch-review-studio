# Icon: leave a clear gap between the branch curve and the speech bubble

## Planning

User: "hmm on that icon, move the line a little further from the chat bubble"

"The line" is the branch curve in media/icon.svg (`M16 7c0 5-6 5-10 10`), which runs from the
right node down to where it merges into the main line at (6,17). After commit 3606be1 it no
longer overlapped the speech bubble, but it passed about 1.3 units (stroke edge to stroke edge)
from the bubble's top-left corner (13,15).

Assumptions (unasked, low-stakes cosmetic change):

- A1: Moving the bubble 1 unit to the right is acceptable, since it stays inside the 24x24 box
  (its right stroke edge is at 22.75).
- A2: Integer coordinates are preferred so the icon stays crisp at the Activity Bar's 24px size.

## Candidates

The gap was measured numerically (minimum distance from the sampled Bezier curve to the bubble's
outline, minus the 1.5 stroke width) and checked in enlarged Edge renders:

| Code | Curve | Bubble origin | Gap |
|---|---|---|---|
| C0 (old) | `c0 5-6 5-10 10` | (13,15) | 1.32 |
| C1 | `c0 4-6 4-10 10` | (13,15) | 1.94 |
| C2 | `c0 4-7 3-10 10` | (13,15) | 2.53 |
| C3 | `c0 4-6 4-10 10` | (14,15) | 2.48 |
| C4 | `c0 4-6 4-10 10` | (14,16) | 3.32 (bubble tail nearly touches the bottom edge) |
| C5 | `c0 4-7 3-10 10` | (14,15) | 3.02 |

D1: Chose C5. The curve bends left sooner and still ends at (6,17) on the main line, and at 24px
there is a visible dark pixel between the curve and the bubble.

## End phase

- media/icon.svg: branch curve is now `M16 7c0 4-7 3-10 10`; bubble is now
  `M14 15h8v5h-4l-2 2v-2h-2z`.
- media/icon.png re-rendered at 128px with the same headless-Edge recipe as before.
- Packaged with `npm run package` and reinstalled into VS Code.
