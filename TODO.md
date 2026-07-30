# Fleet Manager — feature to-do list

Requests from the pilot company (30 July 2026), parked deliberately during the
testing period. New features wait; fixes to existing behaviour go out as found.

## Money & documents
- [ ] **Bank charges / commission %** on a booking, shown on the agreement.
      Decide: percentage of what (rental total? invoice total?), who pays it,
      and whether it changes the balance owed.
- [ ] **Extras in the booking currency** — delivery, insurance and other costs
      entered in € when the booking is in €, with Rs twins like the total and
      deposits. Same lead/follow pattern as the existing fx fields.
- [ ] **Booking confirmation document** — a printable confirmation when the
      client confirms, built like the rental agreement (same company header,
      simpler content: dates, car, price, deposits).
- [ ] **Exchange-rate refresh decision** — changing the house rate in Settings
      deliberately does NOT rewrite existing bookings (the Rs figure is the
      agreed conversion, a money record). If the pilot wants old bookings
      updatable, add an explicit "recalculate at today's rate" button on the
      booking rather than any silent change.

## Planner & bookings
- [ ] **Dates shown while dragging** a booking bar — a small floating label
      with the projected new dates following the cursor during the drag.
- [ ] **Availability check** — either vertical multi-day selection on the
      planner, or a "Check availability" control: enter start + end date, see
      every free car for that range.

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
