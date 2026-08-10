# Fleet Manager — feature to-do list

Requests from the pilot company (30 July 2026), parked deliberately during the
testing period. New features wait; fixes to existing behaviour go out as found.

## Money & documents
- [x] **Bank charges / commission %** — done (v92). Answers from the pilot,
      6 August: a percentage of the invoice total (rental + all extras), added
      on top of what the client pays, and it does change the balance owed. Only
      when the client pays by credit card. Default rate on the Settings page,
      snapshotted onto each booking so a later change never rewrites an agreed
      one. Deliberately excluded from Booked and the monthly revenue figures —
      the company collects it and hands it to the bank, so it is not income.
      Its own line on the agreement, confirmation, receipt, invoice card and
      both exports.
- [x] **Extras in the booking currency** — typed in the booking currency when
      one is set; converted at the booking's own agreed rate (house rate as
      fallback) and recorded in Rs, both figures kept and shown paired.
- [x] **Booking confirmation document** — printable sibling of the agreement:
      same header and styles (shared, so they cannot drift), booking facts and
      the full money table, no terms or signature lines.
- [x] **Exchange-rate refresh** — done: "Use today's rate" buttons on the
      total and both deposits, per-booking, with a confirmation on paid
      bookings.

- [x] **Consecutive receipt numbers (MRA)** — done (v101). A receipt now carries
      its own serial, separate from the scrambled booking reference: optional
      company prefix, the year, then a four-digit counter that restarts each
      January (OCR-2026-0001). The number is allocated by a Firestore
      transaction on the settings document, so two people pressing Receipt at
      the same moment cannot be given the same one, and issuing is blocked
      offline for the same reason. The suggested number can be overwritten to
      continue a paper book — a number already used on another receipt is
      refused. Once issued the number is fixed and reprints identically.

## Planner & bookings
- [x] **Dates shown while dragging** — a floating tag follows the cursor:
      moving a bar shows the projected dates (and target car on a diagonal
      drag); dragging out a new range shows the range and its day count.
- [x] **Availability check** — "Check availability" beside New booking: dates
      and times in, every car judged by the same clash check bookings use;
      free cars listed in planner order with a Book button that opens the
      form pre-filled (times included), busy cars shown with why.

## Tasks & staff
- [x] **Staff expenses tab** — new Expenses view: entries with date, amount,
      category (company-defined in Settings), who spent it, optional car and
      note; month/year/category filters with honest totals; Excel backup
      sheet. NOTE: needs the /expenses rules block published before use.

## Fleet & maintenance
- [x] **Service history per car** — "Log service" records date, mileage, work
      done and the next due date/mileage in one motion, appended permanently;
      "History (N)" viewer per car, last-serviced line on the card, and a
      Service history sheet in the Excel backup.
- [x] **Car document dates** — the six dates on the car form (all optional);
      expired/expiring warnings on each Fleet card (red/amber per document),
      Dashboard alerts 30 days ahead, and all six columns in the Excel backup.

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
- [x] **Damage diagram** — tap-to-mark on the company's own car drawing, with
      numbered notes, printed on the agreement (photo annotation on real
      pictures remains the Blaze-tier upgrade).
- [x] **Signature capture** — finger/stylus pad on the booking; the signature
      prints on the renter's line with the signed date.
- [ ] **Photo damage annotation** (Blaze) — draw on real photos of the car;
      joins check-out photos and the damage log in stage 7.

## Done since this list was made
- [x] Task filter by person hides the columns, not just the chips (v21)
- [x] Double scrolling on the planner and board removed; headers stay pinned
      (v20–v23)
- [x] Full task names visible on board chips — wrap instead of truncating (v24)
- [x] Currency list trimmed to € / $ / £ (v24)
- [x] Booking form sized for desktop — no inner scrolling on PC (v24)
