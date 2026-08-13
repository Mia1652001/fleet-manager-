# Fleet Manager — design standard

Every screen is one of three shapes. New features use an existing shape;
inventing a fourth is a decision, not a default. (This is the discipline that
makes Odoo and localrent feel familiar everywhere: few shapes, no exceptions.)

## The three shapes

**1. List page** — Fleet, Customers, Billing, Maintenance, Expenses (list),
Reports.
One toolbar, then cards or a table. Tapping anywhere on a card opens its
record; buttons on a card are only for actions that are not "open" (Rent out
now, Remove, Mark paid). Search is always the first control.

**2. Planner page** — Bookings, Tasks (board), Dashboard.
A bar of controls, then the time grid. The grid scrolls inside itself, never
the page. The current month stays pinned in the corner.

**3. Form popup** — every add/edit dialog.
Title top-left, × pinned top-right, fields in one column on a phone, the
action bar pinned to the bottom with Save rightmost. A form that grows past
one comfortable screen gets tabs, not more scrolling. Money-bearing forms end
with the money block: total, advance received, due at pickup — always visible
beside Save.

## THE box

One size for every text, number, date and choice box, everywhere, forever:
DM Mono 16px, 44px minimum height, 10/12px padding. 16px is the iPhone
zoom-on-focus threshold; 44px is the Apple minimum tap target. Widths follow
the layout; height and type never vary. Inputs must always carry a `type`
attribute — a typeless input escapes the standard (this happened once).

## Mobile (≤640px)

The page never scrolls sideways — it is clipped, and anything that would
overflow is a bug in that component, not a reason to scroll. Toolbars become
a two-column grid: search full-width on its own line, every other control an
equal 44px cell. Field rows stack to one column. Boards and wide tables
scroll inside their own container.

## Words

No explainer paragraphs describing features — the control's own label and
default value must carry the meaning ("All brokers" needs no "Broker" label).
Warnings live on the fact itself: an expired date turns red where the date is
shown, not in a banner above it.

## Colour

Everything reads from the CSS variables in style.css; themes only ever set
variables. `--accent` is the surface of the header, primary buttons and
active tabs; its ink is chosen for contrast automatically. Printed documents
ignore themes entirely — paper is paper.

## Non-negotiables carried by every build

Save buttons lock while saving and show visible errors. Every popup closes
from its ×, its Cancel, and a tap outside. Money figures shown anywhere must
reconcile with the books' definitions in `money-reporting-rules`. Before any
zip: parse check, brace balance, element-reference check, import-vs-usage
audit, residue audit.
