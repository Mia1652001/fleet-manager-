# Fleet Manager — feature to-do list

Requests from the pilot company (30 July 2026), parked deliberately during the
testing period. New features wait; fixes to existing behaviour go out as found.

## Money & documents
- [ ] **Bank charges / commission %** on a booking, shown on the agreement.
      Decide: percentage of what (rental total? invoice total?), who pays it,
      and whether it changes the balance owed.
- [x] **Extras in the booking currency** — typed in the booking currency when
      one is set; converted at the booking's own agreed rate (house rate as
      fallback) and recorded in Rs, both figures kept and shown paired.
- [x] **Booking confirmation document** — printable sibling of the agreement:
      same header and styles (shared, so they cannot drift), booking facts and
      the full money table, no terms or signature lines.
- [x] **Exchange-rate refresh** — done: "Use today's rate" buttons on the
      total and both deposits, per-booking, with a confirmation on paid
      bookings.

## Planner & bookings
- [x] **Dates shown while dragging** — a floating tag follows the cursor:
      moving a bar shows the projected dates (and target car on a diagonal
      drag); dragging out a new range shows the range and its day count.
- [x] **Availability check** — "Check availability" beside New booking: dates
      and times in, every car judged by the same clash check bookings use;
      free cars listed in planner order with a Book button that opens the
      form pre-filled (times included), busy cars shown with why.

## Tasks & staff
- [ ] **Staff expenses tab** — like Tasks, but entries carry amounts and an
      expense category (car wash, repairs, fuel, …). Needs a new Firestore
      collection → remember the matching rules block.

## Fleet & maintenance
- [ ] **Service history per car** — keep each completed servicing (date,
      mileage, notes) instead of overwriting; show as a history list.
- [ ] **Car document dates** — registration date, licence expiry, road tax
      expiry, insurance expiry, fitness expiry, lease expiry. Plus a view or
      report of upcoming expiries (dashboard alert like service-due).

## Pricing enforcement
- [x] **Per-company car limit** — `carLimit` on the settings document, set only
      from the Firebase console; the app blocks adding cars past it with an
      upgrade message and shows "N of L on plan" in the Fleet summary. Rules
      make the field immutable to clients. No limit set = unlimited (pilots).
- [ ] **Hard server-side enforcement** (Blaze/Cloud Functions) — a modified
      client can currently still write past the limit; the usage line makes
      that visible, and the contract handles it until Functions exist.

## Security — before the first paying customer
Do-now items (console work, no code): two-factor authentication on the Google
account and on GitHub; get every pilot company to run its first backup.
- [ ] **Password self-service** — "forgot password" reset link on the sign-in
      page, and let users change their own password (Firebase Auth supports
      both; small code change). Stops passwords living in WhatsApp threads.
- [ ] **Schema validation in Firestore rules** — verify *what* is written, not
      just who writes: amounts are numbers, dates are dates, required fields
      present. Protects a company from its own buggy or tampered client.
- [ ] **Backup discipline** — every active company set up with the automatic
      weekly backup to a folder; check the Firebase usage dashboard monthly
      (reads/day vs the free-plan ceiling) once 3+ companies are active.
- [ ] **Onboarding checklist** — written steps for account creation (auth user
      → users doc with exact companyId → incognito sign-in test) so no company
      is ever set up from memory.
- [ ] Onboard the 3-car company (~1 week after Mauritius Tour Operator starts).

## Bigger items (likely need Blaze / Firebase Storage — stage 7 territory)
- [ ] **Damage annotation on a car picture** — draw on a photo (WhatsApp-style)
      before generating the agreement.
- [ ] **Signature capture** on the agreement.

## Done since this list was made
- [x] Task filter by person hides the columns, not just the chips (v21)
- [x] Double scrolling on the planner and board removed; headers stay pinned
      (v20–v23)
- [x] Full task names visible on board chips — wrap instead of truncating (v24)
- [x] Currency list trimmed to € / $ / £ (v24)
- [x] Booking form sized for desktop — no inner scrolling on PC (v24)
