# Fleet Manager — feature to-do list

Requests from the pilot company (30 July 2026), parked deliberately during the
testing period. New features wait; fixes to existing behaviour go out as found.

## Pre-zip gates (mandatory, every build)

Run all of these before packaging. Several are here because skipping them
shipped a broken version.

- `node --check` every JS file, with a FAILED flag.
- esbuild bundle link gate, target safari15 — catches a missed file or import.
- Zero literal `\uXXXX` escapes in index.html (two shipped as visible text).
- data-el checks verify PLACEMENT (inside the right section), not existence.
- `python3 css_gate.py style.css <previous shipped style.css>` — added 26 Aug
  after an edit meant for `.rep-wrap` matched a different rule with a similar
  name (the indented `#view-reports .rep-wrap` inside the shared phone
  full-bleed list) and wiped 72 lines: the full-bleed bodies for Bookings,
  Tasks, Expenses and Reports, the board-head alignment rule and the phone
  tick sizes. Brace counts stayed balanced, so nothing noticed until the
  pilot's phone did. The gate checks the mobile layout invariants by BODY,
  not by selector name, and lists every deleted line against the previous
  zip — more than 25, or any from a guarded rule, is a stop.
- Rule for editing style.css: every replacement anchors on a string asserted
  to occur exactly once. Never `index()` of a short fragment; never a slice
  between two searches. The file has near-duplicate selectors on purpose.
- APP_VERSION bumped; byte-verify changed files inside the final zip.

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
Full review against OWASP Top 10:2025 done 31 Aug 2026 — see
`VeFlow-Security-Review.md` for the findings, the console checklist and the
data-retention and registration answers.
- [x] **Password self-service** — done: "Forgot your password?" on the sign-in
      page (neutral message whether or not the address exists) and a change-
      password card on Settings with re-authentication.
- [x] **Activity log** (pilot-34) — every write goes through `audit.js`; one
      append-only entry per save/delete/sign-in/sign-out/print/message/backup
      in `audit/{companyId}/entries`. Field names always, values only for
      numbers, booleans and dates — never phone/email/passport/notes. Read on
      demand from Settings → Activity log, CSV download. Rules block added
      (update/delete: false). Retention 24 months via `expireAt` (attach a
      Firestore TTL policy on that field when convenient).
- [x] **On-device copy wiped at sign-out** (pilot-34) — terminate + clear
      persistence + reload, so a shared or lost phone holds no company data
      after sign-out. Test on the pilot's iPhone before announcing.
- [ ] **Console hardening** (no code, ~30 min) — password policy (min 10,
      Require), email-enumeration protection on, restrict the browser API key
      to app.veflowapp.com, prune Authorized domains, enable Firestore Data
      Access audit logs in Google Cloud (server-side, tamper-proof layer).
- [ ] **Schema validation in Firestore rules** — the minimal rules (create-
      only date/amount checks, logo, carLimit) are the ceiling until a change
      can be proven in the Rules playground first; two outages came from
      going further. Never the same day as an app release.
- [ ] **Backup discipline** — every active company set up with the automatic
      weekly backup to a folder; check the Firebase usage dashboard monthly
      (reads/day vs the free-plan ceiling) once 3+ companies are active.
- [ ] **Onboarding checklist** — written steps for account creation (auth user
      → users doc with exact companyId → incognito sign-in test) so no company
      is ever set up from memory.
- [ ] **Data retention tool** — "customers with no booking for N years" list
      with a delete button, and a TTL policy on audit entries. Retention
      periods must be written into the subscription agreement first.
- [ ] **Content-Security-Policy** — meta tag draft is in the review; GitHub
      Pages cannot do report-only, so it must be tested on a quiet day.
- [ ] **Rules-enforced roles** (layer 2) — staff role today is interface-only.
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

## Accounts & access (discussed 16 Aug 2026, parked)
- Staff logins: already possible today — console-created accounts sharing a companyId.
  Do this for Arshad's staff when he asks; it also makes the who-did-what stamps real.
- Restricted access, layer 1: role field on the users doc; app hides Billing/Reports/
  Settings and destructive buttons for restricted roles. Build after Arshad says which
  screens/actions his staff must not have.
- Restricted access, layer 2: rules-enforced roles. Cheap check (role rides the same
  users-doc read the rules already do) but it IS a rules change: playground-tested,
  quiet day, never with a feature release.
- Staff self-signup via invite codes (rules change) or Cloud Functions (Blaze).
  Full company self-signup: only when actually charging money.

## Colour palette follow-up
- Palette entries cannot be deleted yet (add-only, per the request). If a company
  saves an ugly colour, removal needs a small UI — long-press or an × in a manage
  mode. Ask Arshad if it bothers them before building it.

## Fleet import note
- gpsSim / psvNumber are on the car record but NOT in the Excel importer's
  recognised columns. Add mappings when a client file actually carries them.

## From the pilot, 20 Aug 2026 (parked, in his words)
- Export the bookings page to Excel "in the same format as on screen" (planner grid, not a list).
- Per-company filter on Bookings (and maybe other pages): all by default, filter to one company when needed. Agreed "can do later".
- Custom fields: users defining their own extra fields, e.g. two more on Fleet.
- Revenue by broker in Reports — possibly a filter on the existing report.
- Demo company for his sales demos (console task: create a fresh company + login, no code).

## Parked from the 22 Aug punch list (need their own builds)
- Custom fields (user-defined extra fields, e.g. two more on Fleet) — real feature: define, store, display, export.
- Bookings planner exported to Excel "same format as on screen" — grid layout doable, colours are not (library limit); needs a design decision.
- Merge Customer + Name-on-booking into one autocomplete field — surgery on the booking form; build alone, warn the pilot first.
