// Rental agreement — the printable contract for one booking.
//
// Built as a real page and handed to the browser's own print dialog, where
// "Save as PDF" is a standard destination on every platform including iOS. That
// is deliberate rather than a shortcut:
//
//   * the same button covers printing for signature at the counter, which is
//     what actually happens to a rental agreement;
//   * the output is real text — selectable, searchable, a few kilobytes — where
//     a screenshot-to-PDF library produces a blurry picture of a page;
//   * long terms and conditions break across pages properly;
//   * nothing has to be fetched from a CDN that might be blocked or go stale.
//
// The trade is one extra step: print, then choose Save as PDF. The document
// title is set to the booking reference, so the suggested filename is right.

import {
  state, esc, formatDate, formatAmount, bookingCarLabel, bookingRef,
  rentalDays, rateFor, rentalTotal, hasManualTotal, advancePaid, balanceFor,
  startTime, endTime, customerForBooking, companyName, companyTerms, todayStr,
  deliveryCost, insuranceCost, otherCost, invoiceTotal, extrasTotal
} from "./store.js";

function line(label, value) {
  return value
    ? `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`
    : "";
}

function companyBlock() {
  const s = state.settings || {};
  const bits = [s.address, s.phone, s.email].filter(Boolean);
  return `
    <div class="ag-company">
      ${s.logo ? `<img class="ag-logo" src="${s.logo}" alt="">` : ""}
      <div>
        <div class="ag-name">${esc(companyName())}</div>
        ${bits.length ? `<div class="ag-contact">${esc(bits.join(" · "))}</div>` : ""}
      </div>
    </div>`;
}

function moneyBlock(b) {
  const days = rentalDays(b);
  const rate = rateFor(b);
  const total = rentalTotal(b);
  const advance = advancePaid(b);
  const balance = balanceFor(b);
  const security = b.securityDeposit || 0;

  const basis = hasManualTotal(b)
    ? `Agreed price for ${days} day${days === 1 ? "" : "s"}`
    : `${days} day${days === 1 ? "" : "s"} × ${formatAmount(rate)} per day`;

  const extras = [
    ["Delivery", deliveryCost(b)],
    ["Insurance", insuranceCost(b)],
    ["Other charges", otherCost(b)]
  ].filter(([, v]) => v > 0);

  return `
    <table class="ag-table">
      <tr><th>${esc(basis)}</th><td class="ag-num">${esc(formatAmount(total))}</td></tr>
      ${extras.map(([k, v]) =>
        `<tr><th>${esc(k)}</th><td class="ag-num">${esc(formatAmount(v))}</td></tr>`).join("")}
      ${extras.length
        ? `<tr><th>Total charges</th><td class="ag-num">${esc(formatAmount(invoiceTotal(b)))}</td></tr>`
        : ""}
      ${advance > 0 ? `<tr><th>Less advance already paid</th><td class="ag-num">− ${esc(formatAmount(advance))}</td></tr>` : ""}
      <tr class="ag-total"><th>${b.paid ? "Total (settled)" : "Balance due"}</th>
        <td class="ag-num">${esc(formatAmount(b.paid ? invoiceTotal(b) : balance))}</td></tr>
      ${security > 0 ? `<tr><th>Refundable security deposit</th><td class="ag-num">${esc(formatAmount(security))}</td></tr>` : ""}
    </table>`;
}

function documentHtml(b) {
  const ref = bookingRef(b);
  const customer = customerForBooking(b);
  const car = state.cars.find(c => c.id === b.carId);
  const terms = companyTerms();

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Rental agreement ${esc(ref)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 10.5pt; line-height: 1.5; color: #111; margin: 0;
  }
  .ag-head { display: flex; justify-content: space-between; align-items: flex-start;
             gap: 16px; border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 16px; }
  .ag-company { display: flex; gap: 12px; align-items: center; }
  .ag-logo { max-height: 52px; max-width: 150px; }
  .ag-name { font-size: 15pt; font-weight: 700; }
  .ag-contact { font-size: 9pt; color: #444; }
  .ag-title { text-align: right; }
  .ag-title h1 { font-size: 13pt; margin: 0 0 4px; letter-spacing: 0.04em; text-transform: uppercase; }
  .ag-ref { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12pt; font-weight: 700; }
  .ag-issued { font-size: 8.5pt; color: #555; }

  h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.08em;
       color: #444; margin: 16px 0 6px; }
  .ag-table { width: 100%; border-collapse: collapse; }
  .ag-table th { text-align: left; font-weight: 400; color: #444; width: 42%;
                 padding: 3px 8px 3px 0; vertical-align: top; }
  .ag-table td { padding: 3px 0; font-weight: 600; }
  .ag-num { text-align: right; font-variant-numeric: tabular-nums; }
  .ag-total th, .ag-total td { border-top: 1px solid #111; padding-top: 6px; font-weight: 700; }

  .ag-cols { display: flex; gap: 24px; }
  .ag-cols > div { flex: 1; }

  .ag-terms { white-space: pre-wrap; font-size: 9pt; color: #222; }

  .ag-damage { display: flex; gap: 18px; align-items: flex-start; page-break-inside: avoid; }
  .ag-car { width: 46%; max-width: 300px; height: auto; }
  .ag-damage-key { flex: 1; font-size: 9pt; color: #333; }
  .ag-damage-lines { margin-top: 10px; line-height: 2.1; font-size: 9pt; }

  .ag-sign { display: flex; gap: 32px; margin-top: 28px; page-break-inside: avoid; }
  .ag-sign > div { flex: 1; }
  .ag-rule { border-bottom: 1px solid #111; height: 42px; }
  .ag-cap { font-size: 8.5pt; color: #444; margin-top: 4px; }

  .ag-foot { margin-top: 22px; border-top: 1px solid #bbb; padding-top: 6px;
             font-size: 8pt; color: #666; }
  /* The toolbar belongs to the screen only; the printed page starts at the
     agreement itself. */
  @media print { .ag-bar { display: none !important; } }
  .ag-bar {
    display: flex; gap: 8px; align-items: center; justify-content: flex-end;
    padding: 8px 0 14px; border-bottom: 1px solid #ddd; margin-bottom: 14px;
  }
  .ag-bar button {
    font: inherit; font-size: 10pt; padding: 7px 16px; cursor: pointer;
    border: 1px solid #111; border-radius: 4px; background: #111; color: #fff;
  }
  .ag-bar .ag-secondary { background: #fff; color: #111; }
  .ag-bar span { margin-right: auto; font-size: 9pt; color: #555; }
</style></head>
<body>

  <div class="ag-bar">
    <span>Choose <strong>Save as PDF</strong> in the print dialog to send this as a file.</span>
    <button class="ag-secondary" onclick="window.close()">Close</button>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>

  <div class="ag-head">
    ${companyBlock()}
    <div class="ag-title">
      <h1>Rental agreement</h1>
      <div class="ag-ref">${esc(ref)}</div>
      <div class="ag-issued">Issued ${esc(formatDate(todayStr()))}</div>
    </div>
  </div>

  <div class="ag-cols">
    <div>
      <h2>Renter</h2>
      <table class="ag-table">
        ${line("Name", b.renter)}
        ${line("Phone", b.phone || customer?.phone)}
        ${line("Email", customer?.email)}
        ${line("Licence number", customer?.license)}
      </table>
    </div>
    <div>
      <h2>Vehicle</h2>
      <table class="ag-table">
        ${line("Vehicle", bookingCarLabel(b))}
        ${line("Registration", car?.plate)}
        ${line("Category", car?.category)}
        ${line("Mileage at hand-over", car?.mileage ? `${car.mileage} km` : "")}
      </table>
    </div>
  </div>

  <h2>Rental period</h2>
  <div class="ag-cols">
    <div>
      <table class="ag-table">
        ${line("Pick-up date", formatDate(b.startDate))}
        ${line("Pick-up time", startTime(b))}
        ${line("Pick-up place", b.pickupLocation)}
      </table>
    </div>
    <div>
      <table class="ag-table">
        ${line("Return date", formatDate(b.endDate))}
        ${line("Return time", endTime(b))}
        ${line("Return place", b.dropoffLocation)}
      </table>
    </div>
  </div>

  <h2>Charges</h2>
  ${moneyBlock(b)}

  ${b.notes ? `<h2>Notes</h2><div class="ag-terms">${esc(b.notes)}</div>` : ""}

  ${terms ? `<h2>Terms and conditions</h2><div class="ag-terms">${esc(terms)}</div>` : ""}

  <h2>Condition at hand-over</h2>
  <div class="ag-damage">
    <!-- Drawn rather than an image file, so it prints crisply at any size and
         needs nothing loaded from anywhere. Marked up by hand at the counter. -->
    <svg viewBox="0 0 320 150" class="ag-car" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="#111" stroke-width="2" stroke-linejoin="round">
        <rect x="18" y="30" width="284" height="90" rx="30"/>
        <path d="M96 30 L110 58 L210 58 L224 30"/>
        <path d="M96 120 L110 92 L210 92 L224 120"/>
        <rect x="110" y="58" width="100" height="34" rx="6"/>
        <path d="M18 62 L4 62 L4 88 L18 88"/>
        <circle cx="72" cy="30" r="9"/><circle cx="72" cy="120" r="9"/>
        <circle cx="248" cy="30" r="9"/><circle cx="248" cy="120" r="9"/>
        <path d="M296 60 L308 60 M296 90 L308 90"/>
      </g>
    </svg>
    <div class="ag-damage-key">
      <div>Mark any existing damage on the diagram before the vehicle leaves.</div>
      <div class="ag-damage-lines">
        <div>Fuel level out: ____________ &nbsp;&nbsp; in: ____________</div>
        <div>Mileage out: ____________ &nbsp;&nbsp; in: ____________</div>
        <div>Notes: _______________________________________________</div>
        <div>_____________________________________________________</div>
      </div>
    </div>
  </div>

  <div class="ag-sign">
    <div>
      <div class="ag-rule"></div>
      <div class="ag-cap">Renter — signature and date</div>
    </div>
    <div>
      <div class="ag-rule"></div>
      <div class="ag-cap">For ${esc(companyName())} — signature and date</div>
    </div>
  </div>

  <div class="ag-foot">
    Agreement ${esc(ref)} · ${esc(companyName())}
    ${b.managedBy ? ` · Managed by ${esc(b.managedBy)}` : ""}
  </div>

<script>
  // Prints itself once, from inside its own window, after the logo has had a
  // chance to load — an image still loading prints as a blank gap. Guarded so a
  // late load event cannot open a second dialog on top of the first.
  (function () {
    var done = false;
    function once() {
      if (done) return;
      done = true;
      setTimeout(function () { window.print(); }, 300);
    }
    if (document.readyState === "complete") once();
    else window.addEventListener("load", once);
    setTimeout(once, 2000);   // backstop if an image never arrives
  })();
<\/script>

</body></html>`;
}

// ---------- Sending the booking to the customer ----------
// A mailto link cannot carry an attachment — that is a limit of the format, and
// with no server there is nothing to send mail from anyway. So this is the
// confirmation rather than the agreement: everything the customer needs to know,
// written into the body, opening in whatever mail app the staff member uses so
// it can be read and edited before it goes. Nothing is sent behind their back.
//
// The signed agreement stays a printed document, which is what actually happens
// to it at the counter.

export const DEFAULT_MESSAGE_NOTE =
  "Please bring your driving licence when collecting the vehicle.\n" +
  "The rental agreement will be provided for signature at hand-over.";

function confirmationText(b) {
  const company = companyName() || "our team";
  const s = state.settings || {};
  const days = rentalDays(b);
  const total = rentalTotal(b);
  const advance = advancePaid(b);
  const balance = balanceFor(b);
  const security = b.securityDeposit || 0;

  const where = (place, time) => [time, place].filter(Boolean).join(" · ");

  const lines = [
    `Dear ${b.renter || "customer"},`,
    "",
    `Thank you for booking with ${company}. Here are your rental details.`,
    "",
    `Booking reference: ${bookingRef(b)}`,
    `Vehicle: ${bookingCarLabel(b)}`,
    "",
    `Pick-up:  ${formatDate(b.startDate)}   ${where(b.pickupLocation, startTime(b))}`,
    `Return:   ${formatDate(b.endDate)}   ${where(b.dropoffLocation, endTime(b))}`,
    ""
  ];

  if (hasManualTotal(b)) {
    lines.push(`Agreed price (${days} day${days === 1 ? "" : "s"}): ${formatAmount(total)}`);
  } else {
    lines.push(`${days} day${days === 1 ? "" : "s"} at ${formatAmount(rateFor(b))} per day: ${formatAmount(total)}`);
  }
  // Itemised, or the balance will not add up from the customer's side and the
  // first thing they do is ring up to ask why.
  if (deliveryCost(b) > 0) lines.push(`Delivery: ${formatAmount(deliveryCost(b))}`);
  if (insuranceCost(b) > 0) lines.push(`Insurance: ${formatAmount(insuranceCost(b))}`);
  if (otherCost(b) > 0) lines.push(`Other charges: ${formatAmount(otherCost(b))}`);
  if (extrasTotal(b) > 0) lines.push(`Total: ${formatAmount(invoiceTotal(b))}`);

  if (advance > 0) lines.push(`Advance already paid: ${formatAmount(advance)}`);
  lines.push(b.paid ? "Paid in full — thank you." : `Balance due: ${formatAmount(balance)}`);
  if (security > 0) lines.push(`Refundable security deposit: ${formatAmount(security)}`);

  if (b.notes) { lines.push("", `Note: ${b.notes}`); }

  // The closing lines are the company's own words. Anything set on the Settings
  // page replaces the default, so the message reads like them rather than like
  // the app — and a company with different practices is not stuck saying
  // something untrue about licences or signatures.
  const custom = (state.settings?.messageNote || "").trim();
  lines.push("", custom || DEFAULT_MESSAGE_NOTE, "", "Kind regards,", company);
  if (s.phone) lines.push(s.phone);
  if (s.address) lines.push(s.address);

  return lines.join("\n");
}

/**
 * Opens the staff member's mail app with the confirmation written out and the
 * customer's address already filled in, taken from the booking's customer record.
 */
export function emailBooking(bookingId) {
  const b = state.bookings.find(x => x.id === bookingId);
  if (!b) return { ok: false, reason: "That booking could not be found." };

  // The booking's own address first: a walk-in booked with "just type a name"
  // has contact details on the booking rather than in the customer register, and
  // that is the route most bookings are taken through.
  const to = b.email || customerForBooking(b)?.email || "";
  if (!to) {
    return {
      ok: false,
      reason: "No email address for this booking. Type one into the booking, or add it to the customer on the Customers page."
    };
  }

  const subject = `${companyName() || "Car rental"} — booking ${bookingRef(b)}`;
  window.location.href =
    `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(confirmationText(b))}`;
  return { ok: true };
}

// wa.me needs digits only, with the country code and no leading plus. Staff
// write local numbers the local way — "5712 3456" — which on its own opens a
// chat with nobody. So a bare local number gets the country code put in front.
//
// The code is taken from the company's own phone number on the Settings page
// rather than written in here, so this still works if the app is ever used
// outside Mauritius. 230 is the fallback when Settings has nothing to go on.
function companyCountryCode() {
  const own = String(state.settings?.phone || "");
  const m = own.match(/^\s*\+\s*(\d{1,3})/);
  return m ? m[1] : "230";
}

function waNumber(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return "";

  // Written with a country code already, either as +230… or as 00230…
  if (/^\s*\+/.test(text)) return digits;
  if (digits.startsWith("00")) return digits.slice(2);

  const cc = companyCountryCode();
  if (digits.startsWith(cc) && digits.length > cc.length + 5) return digits;

  return cc + digits.replace(/^0+/, "");   // a local number, leading zero dropped
}

/**
 * The same confirmation over WhatsApp, which is how a lot of this business is
 * actually conducted locally. Opens the chat with the message ready to send.
 */
export function whatsappBooking(bookingId) {
  const b = state.bookings.find(x => x.id === bookingId);
  if (!b) return { ok: false, reason: "That booking could not be found." };

  const raw = b.phone || customerForBooking(b)?.phone || "";
  const digits = waNumber(raw);
  if (!digits) {
    return { ok: false, reason: "No phone number saved for this booking or customer." };
  }

  window.open(
    `https://wa.me/${digits}?text=${encodeURIComponent(confirmationText(b))}`,
    "_blank"
  );
  return { ok: true };
}

/**
 * Opens the agreement in its own window and offers it to print. From the print
 * dialog, "Save as PDF" produces the file.
 *
 * A separate window rather than printing the app itself: the app's own styles
 * would fight the document's, and the person keeps their place in the planner.
 */
export function openAgreement(bookingId) {
  const b = state.bookings.find(x => x.id === bookingId);
  if (!b) return { ok: false, reason: "That booking could not be found." };

  const win = window.open("", "_blank");
  if (!win) {
    // Pop-up blockers are common and silent, so say what happened rather than
    // appearing to do nothing at all.
    return {
      ok: false,
      reason: "Your browser blocked the new window. Allow pop-ups for this site and try again."
    };
  }

  win.document.open();
  win.document.write(documentHtml(b));
  win.document.close();

  // The parent deliberately does nothing further. Driving the print dialog from
  // here froze the app: a print dialog is modal and the two windows share a main
  // thread, so this page sat blocked waiting on a dialog belonging to the other
  // one — and a retry timer queued a second dialog behind the first, which
  // nothing could then clear. The document prints itself instead, once, and
  // carries its own button in case that is blocked.
  try { win.focus(); } catch {}

  return { ok: true };
}
