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
  deliveryCost, insuranceCost, otherCost, invoiceTotal, extrasTotal, fxPair,
  bankCharge, bankChargePct, amountDue, receiptNo,
  invoiceNo, vatRatePct, vatSplit,
  paidTotal, lastPaymentMethod, hasLedger, entityForBooking
} from "./store.js";

function line(label, value) {
  return value
    ? `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`
    : "";
}

function companyBlock(ent, extraLines = []) {
  // The issuing company: the car's entity for live documents, the snapshot
  // for serialized ones. Single-company customers always get their main
  // details here — this changes nothing for them.
  const bits = [ent.addr, ent.phone, ent.email, ent.website].filter(Boolean);
  const extras = extraLines.filter(Boolean);
  return `
    <div class="ag-company">
      ${ent.logo ? `<img class="ag-logo" src="${ent.logo}" alt="">` : ""}
      <div>
        <div class="ag-name">${esc(ent.name)}</div>
        ${bits.length ? `<div class="ag-contact">${esc(bits.join(" · "))}</div>` : ""}
        ${extras.map(x => `<div class="ag-contact">${esc(x)}</div>`).join("")}
      </div>
    </div>`;
}

// Every printed document ends with the company's own details, so a sheet that
// leaves the office carries the company on it wherever it is separated from
// its envelope. Note what this is NOT: the browser prints its own footer with
// the page's web address unless "Headers and footers" is unticked in the print
// dialog. No stylesheet can suppress that — it is the browser's, not ours —
// which is all the more reason the document should end with the company rather
// than with nothing.
function docFoot(ent, label, extra = "") {
  const bits = [ent.name, ent.addr, ent.phone, ent.email, ent.website].filter(Boolean);
  return `
  <div class="ag-foot">
    <div>${esc(label)}${extra}</div>
    ${bits.length ? `<div class="ag-foot-co">${esc(bits.join(" · "))}</div>` : ""}
  </div>`;
}

function moneyBlock(b) {
  const days = rentalDays(b);
  const rate = rateFor(b);
  const total = rentalTotal(b);
  // "Advance" on a ledger booking means everything received so far — the
  // agreement and the receipt must never disagree about the same rupees.
  const ledgered = hasLedger(b);
  const advance = ledgered ? paidTotal(b) : advancePaid(b);
  const balance = balanceFor(b);
  const security = b.securityDeposit || 0;
  // Its own line, never folded into the total: the client is entitled to see
  // what the card is costing them and to choose to pay another way instead.
  const charge = bankCharge(b);

  const basis = hasManualTotal(b)
    ? `Agreed price for ${days} day${days === 1 ? "" : "s"}`
    : `${days} day${days === 1 ? "" : "s"} × ${formatAmount(rate)} per day`;

  const extras = [
    ["Delivery", deliveryCost(b), b.fxDelivery],
    ["Insurance", insuranceCost(b), b.fxInsurance],
    ["Other charges", otherCost(b), b.fxOther]
  ].filter(([, v]) => v > 0);

  return `
    <table class="ag-table">
      <tr><th>${esc(basis)}</th><td class="ag-num">${esc(fxPair(b, total, b.fxTotal))}</td></tr>
      ${extras.map(([k, v, fxv]) =>
        `<tr><th>${esc(k)}</th><td class="ag-num">${esc(fxPair(b, v, fxv))}</td></tr>`).join("")}
      ${extras.length
        ? `<tr><th>Total charges</th><td class="ag-num">${esc(formatAmount(invoiceTotal(b)))}</td></tr>`
        : ""}
      ${charge > 0
        ? `<tr><th>Bank charge (${esc(String(bankChargePct(b)))}% — card payment)</th><td class="ag-num">${esc(formatAmount(charge))}</td></tr>`
        : ""}
      ${advance > 0 ? `<tr><th>${ledgered ? "Less received so far" : "Less advance already paid"}</th><td class="ag-num">− ${esc(ledgered ? formatAmount(advance) : fxPair(b, advance, b.fxAdvance))}</td></tr>` : ""}
      <tr class="ag-total"><th>${b.paid ? "Total (settled)" : "Balance due"}</th>
        <td class="ag-num">${esc(formatAmount(b.paid ? amountDue(b) : balance))}</td></tr>
      ${security > 0 ? `<tr><th>Refundable security deposit</th><td class="ag-num">${esc(fxPair(b, security, b.fxSecurity))}</td></tr>` : ""}
    </table>`;
}

// The stylesheet and the self-print behaviour are shared by every printed
// document — the agreement and the booking confirmation must look like
// siblings, and extracting these is what guarantees they never drift apart.
const DOC_STYLES = `<style>
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
  .ag-payline { margin-top: 18pt; padding: 8pt 10pt; border: 1px solid #ccc;
    border-radius: 3pt; font-size: 9.5pt; color: #222; }

  /* Terms start their own sheet, always. They sit after the hand-over diagram
     so page one is the booking — details, charges, the car's condition — and
     page two is the contract the renter signs under. Filing and handing over a
     predictable two sheets beats a layout that reflows with the length of a
     booking. */
  .ag-termspage { page-break-before: always; break-before: page; }

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
  .ag-foot-co { margin-top: 2px; }
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
</style>`;

// The action bar every printed document opens with. Inside the installed app
// there is no browser chrome — without this Close button the only way out of
// a document is killing the whole app, which is exactly what the pilot had
// to do when the confirmation shipped without it.
// The company's own car drawing — one vector shared by the printed agreement
// and the in-app damage marker, so what staff tap on screen is exactly what
// prints. Exported for the booking form's diagram dialog.
export const CAR_OUTLINE = `<svg viewBox="0 0 700 338" class="ag-car" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M136 335C129 333 120 328 117 322C114 317 112 309 112 304C112 298 111 298 109 303C106 309 102 312 91 312C83 313 76 312 75 310C74 308 74 301 75 299C76 298 78 285 79 275C80 273 81 267 82 262C84 251 84 248 82 248C80 247 37 247 35 248C33 249 34 254 37 259C41 266 43 269 42 272C41 274 41 274 26 274L11 274 L8 269C2 259 2 264 2 165L2 75 L5 69C10 61 12 60 28 60C39 60 41 60 42 62C44 64 44 64 42 67C39 70 35 80 35 82C35 86 40 87 82 86L86 86 L86 80C85 77 85 72 84 68C83 65 82 59 82 54C81 50 81 45 80 44C78 41 79 25 80 24C82 23 98 22 103 24C108 25 112 28 113 32C115 36 116 35 117 29C118 23 123 14 125 13C126 12 130 10 133 7L139 2 L149 2C159 2 159 2 164 5C171 9 179 16 180 20C180 21 181 24 182 26C184 30 183 39 182 43C180 46 183 45 186 43C187 40 191 38 207 30L214 26 L326 26C431 26 439 26 443 27C447 29 449 29 449 26C449 24 460 11 463 10C464 9 466 8 467 8C473 5 487 5 496 8C504 11 513 22 513 29C513 33 516 36 519 33C519 33 523 31 526 29L533 25 L573 25L613 25 L614 27C616 30 615 39 613 43C612 44 612 46 612 48C612 50 608 65 605 76C604 78 604 81 603 83L603 86 L633 86C650 86 664 86 664 85C665 84 662 75 660 73C657 71 657 70 658 68L659 66 L676 66L692 66 L695 72L698 78 L699 165C699 242 699 252 698 253C697 254 696 256 696 256C696 257 696 258 695 258C695 259 694 260 694 262C693 263 691 267 689 269L684 274 L670 274C652 274 650 273 657 266C661 262 663 250 660 250C659 250 652 250 644 250C598 250 599 250 599 252C598 253 598 255 599 256C599 257 601 262 601 266C602 271 604 277 605 281C606 285 607 289 607 291C607 293 608 297 609 300C610 305 611 314 610 316C609 317 601 317 576 317C536 317 525 316 516 312C509 308 508 309 508 314C507 316 506 320 504 322C502 325 501 327 501 328C501 329 496 332 492 334C485 337 467 337 460 334C457 332 455 330 454 329C453 328 452 327 452 327C449 327 445 319 444 314C443 308 443 308 437 312C433 314 216 314 208 311C203 310 192 303 177 293C175 291 175 292 176 296C180 305 175 323 169 326C168 327 166 328 166 329C163 333 146 337 136 335ZM487 327C488 326 490 325 491 325C495 325 502 312 502 306C502 304 499 301 498 301C496 301 495 303 495 309C495 320 484 327 471 324C469 324 465 323 464 323C460 322 456 314 456 309C456 303 455 301 452 301C451 301 450 302 449 304C446 316 463 331 478 329C481 329 485 328 487 327ZM159 325C170 319 174 304 167 293C162 285 160 284 152 282C144 280 138 280 130 285C118 291 116 303 124 319C128 327 148 331 159 325ZM139 324C137 324 135 323 134 323C131 323 125 313 124 308C123 301 125 297 130 292C142 279 165 286 165 303C165 318 152 329 139 324ZM482 315C489 311 491 304 487 301C484 298 465 298 463 301C460 303 461 308 464 312C466 315 470 317 478 318C478 318 480 317 482 315ZM153 314C158 311 158 309 158 302C158 298 157 298 153 296C142 291 130 297 130 306C130 315 144 321 153 314ZM602 307C603 306 601 288 599 285C598 284 598 282 598 281C598 279 597 277 597 275C596 274 595 271 595 270C595 268 595 266 594 264C594 263 593 259 592 256L591 250 L478 250L365 250 L365 277L366 304 L400 305L435 305 L439 301C445 296 448 294 459 293C478 291 499 292 504 296C506 297 507 298 507 298C508 298 511 300 515 303L523 308 L562 307C583 307 601 307 602 307ZM97 305C98 304 101 302 102 299C111 285 122 275 134 273C139 272 152 273 157 274C162 275 178 283 186 289C209 305 210 305 217 305L223 305 L223 277C223 252 223 248 221 248C219 247 96 247 93 248C92 248 91 250 89 258C89 263 87 270 86 273C85 276 84 282 84 286C83 291 83 297 82 299C80 306 81 307 88 306C92 306 96 305 97 305ZM360 277L360 250 L294 250L228 250 L228 277C228 292 228 304 229 304C229 305 259 305 294 305L360 304 L360 277ZM677 268C680 268 683 266 684 265C686 263 691 252 691 250C691 250 691 249 692 249C693 249 693 241 693 227L693 205 L682 205L670 206 L670 230C670 255 670 256 667 261C664 269 664 269 672 270C672 270 675 269 677 268ZM31 265C31 264 30 262 30 261C28 259 28 254 28 230C28 204 27 195 26 201C25 203 24 203 16 203L7 203 L7 225C8 261 10 266 23 266C28 266 30 266 31 265ZM341 257C341 257 340 256 340 254C340 252 342 251 350 251C355 251 356 252 356 254C356 255 356 257 355 257C353 258 343 258 341 257ZM593 233C593 228 593 223 593 222L592 220 L536 220L480 220 L479 225C478 227 477 232 475 235C474 238 473 241 474 241C474 242 501 242 533 242L592 242 L593 233ZM662 169L662 96 L631 96L600 96 L600 167C600 206 600 239 600 240L601 242 L631 242L662 242 L662 169ZM215 239C216 239 215 238 213 234C211 231 209 226 208 222C207 219 205 216 205 216C203 215 98 215 96 216C94 216 93 240 95 240C97 241 213 240 215 239ZM256 231C256 226 256 222 255 222C254 221 252 223 252 225C252 226 250 229 248 231C243 238 244 240 250 240C256 241 256 241 256 231ZM425 239C426 239 424 235 421 230C418 226 415 221 414 219C412 218 411 216 410 216C408 215 376 215 337 215C255 215 264 213 264 228C264 239 264 240 270 240C279 241 425 240 425 239ZM465 238C467 237 470 231 471 227L474 218 L475 164L475 109 L472 104C469 98 466 96 462 100C460 101 458 102 456 103C454 104 448 107 444 110C433 116 425 120 421 121L418 122 L418 166C418 198 418 211 419 212C422 215 453 237 455 237C455 237 457 238 458 239C460 242 462 242 465 238ZM67 239C67 238 67 238 66 238C63 238 60 233 60 229C60 220 71 216 78 222C83 227 83 231 78 236C74 240 74 240 80 240L86 240 L86 167L86 94 L81 94C74 94 74 94 79 98C83 102 83 107 79 112C74 116 69 116 64 112C59 108 59 103 63 99C64 97 66 96 66 96C67 96 67 96 67 95C67 94 61 94 51 94L34 94 L34 166C34 205 34 238 34 239C35 240 67 241 67 239ZM237 238C237 237 237 236 238 236C239 235 239 234 239 233C239 232 239 232 237 234C234 236 233 240 235 240C236 240 237 239 237 238ZM441 239C442 239 440 237 438 235C436 234 434 232 433 231C429 227 431 233 435 238C436 240 440 241 441 239ZM605 238C605 237 605 228 605 218L606 200 L617 200L628 200 L628 220L628 238 L617 239C609 239 606 239 605 238ZM228 236C228 235 229 233 230 232C231 230 233 228 234 226C237 221 251 211 255 211C256 211 257 210 258 209C260 206 259 122 258 120C257 120 255 119 252 118C245 116 239 111 232 102C230 100 228 98 227 98C225 98 220 104 217 110L214 116 L214 168C214 220 214 221 216 225C223 237 227 241 228 236ZM39 236C38 236 38 221 38 167C38 92 38 95 43 98C45 99 46 99 46 98C48 97 48 97 50 98C51 99 52 99 54 98C55 97 56 97 57 98C58 99 59 234 58 236C57 237 54 237 53 236C53 234 52 234 50 236C49 237 48 237 47 236C46 235 45 235 43 236C42 237 41 237 41 237C41 237 40 237 39 236ZM74 232C79 229 74 223 69 225C65 226 64 229 67 232C71 234 71 234 74 232ZM624 220L624 206 L617 205L610 205 L610 219C610 226 610 233 611 233C611 234 614 234 617 234L624 234 L624 220ZM63 214C56 208 62 198 71 198C76 198 82 203 82 208C82 216 69 220 63 214ZM74 211C76 209 77 206 74 204C72 203 70 203 67 205C64 208 64 210 68 211C71 213 72 213 74 211ZM592 212C593 212 593 202 593 169L592 128 L536 128L480 128 L480 169C480 192 480 211 480 212C481 213 590 214 592 212ZM412 166L412 121 L338 121L264 122 L264 165C264 200 264 210 265 210C266 211 299 211 339 211L412 210 L412 166ZM204 208C206 208 206 203 206 164L206 121 L150 121L94 121 L94 164C94 188 94 208 95 208C95 209 202 209 204 208ZM21 164L20 130 L14 130L8 130 L7 164L7 198 L14 198L21 198 L21 164ZM693 170C693 155 693 142 693 141C695 138 692 138 681 138L670 138 L670 168L670 198 L682 198L693 198 L693 170ZM612 175C612 174 612 171 612 168L612 162 L618 162C625 162 627 163 627 168C627 175 626 176 619 176C615 176 613 176 612 175ZM606 137C605 137 605 132 605 118L606 100 L616 99C624 99 628 99 628 100C630 103 629 137 627 137C625 138 608 138 606 137ZM63 132C56 126 62 116 71 116C76 116 82 121 82 125C82 134 69 139 63 132ZM624 120C624 104 624 104 617 104L610 104 L610 119L610 133 L617 133L624 132 L624 120ZM74 129C76 128 77 125 74 123C72 120 69 121 67 123C64 126 64 128 68 129C71 131 71 131 74 129ZM693 107C693 91 693 82 692 82C691 81 691 80 691 79C691 78 690 76 688 75C685 72 685 72 677 72C670 72 669 73 669 74C669 75 670 87 670 102C670 117 670 129 670 130C671 131 674 131 682 131L693 131 L693 107ZM28 102C28 90 29 78 30 76C30 73 31 70 32 69L32 66 L25 66C14 66 13 67 10 77C7 85 7 86 7 105L8 124 L17 125C23 125 26 125 26 126C26 127 26 127 27 126C28 126 28 115 28 102ZM592 119C593 119 593 114 593 107L592 96 L536 96C502 96 478 96 478 97C477 97 477 99 478 100C479 101 480 104 480 106C480 108 480 111 481 112C481 113 482 116 482 117L483 120 L519 120C577 121 591 120 592 119ZM418 113C419 112 421 109 422 107C423 104 425 101 426 100C431 96 433 96 346 96L264 96 L264 104C264 108 264 112 264 114L265 116 L340 116L416 116 L418 113ZM211 108C213 105 215 101 216 99C218 97 219 95 219 95C219 94 191 94 156 94L94 94 L94 104L94 114 L151 114L208 114 L211 108ZM441 104C446 100 451 97 450 97C450 96 447 96 444 96L438 96 L433 103C425 113 426 114 441 104ZM74 108C80 104 73 97 67 102C65 104 65 104 66 107C68 110 71 111 74 108ZM259 106C260 98 259 97 255 96C247 96 247 97 253 106C257 111 258 111 259 106ZM241 98C240 96 238 96 238 97C238 98 239 99 240 99C240 99 241 98 241 98ZM176 86L228 86 L228 60L228 33 L223 33C220 33 216 34 213 35C211 36 208 37 208 37C207 37 203 40 194 46C192 48 188 50 185 52C182 53 178 55 176 57C175 58 172 59 171 59C170 59 168 60 165 61C157 65 139 64 129 59C125 57 115 47 112 43C112 41 110 39 109 38C108 36 106 34 105 33C103 30 102 30 94 29C85 29 83 30 84 35C86 40 88 53 89 62C92 82 93 86 97 86C98 87 105 87 111 86C118 86 147 86 176 86ZM347 85C347 84 347 84 346 84C345 84 345 83 345 81C345 79 346 78 352 78C358 78 359 78 360 80C361 82 361 83 360 83C358 85 359 86 362 86L364 86 L364 60L364 34 L299 33L233 33 L233 59L233 86 L290 86C327 86 347 86 347 85ZM597 78C598 75 600 70 600 68C601 64 603 56 604 53C605 51 606 47 607 39L607 35 L567 35L526 36 L521 40C518 43 515 44 511 45C509 46 504 47 502 47C495 49 467 49 459 47C452 46 449 44 449 42C449 40 445 36 441 34C438 33 429 33 404 33L370 33 L370 60L370 86 L483 86L595 86 L597 78ZM162 52C168 49 172 46 173 42C181 26 170 11 150 11C138 11 131 15 125 25C120 34 125 46 136 51C140 53 157 54 162 52ZM142 49C139 48 135 46 135 46C135 45 134 44 132 43C129 40 128 31 131 26C133 21 140 16 146 15C151 13 160 15 163 17C170 22 173 32 169 38C169 40 168 42 168 42C168 45 162 49 158 50C150 52 149 52 142 49ZM155 43C162 40 165 35 164 30C162 24 160 23 151 23C135 23 132 29 142 40C146 46 149 46 155 43ZM490 43C492 43 494 38 494 34C494 26 479 21 472 26C467 31 466 39 471 44C472 45 485 45 490 43ZM460 36C460 34 461 32 462 31C462 29 463 28 463 26C463 24 470 18 475 17C483 15 492 17 496 22C499 25 501 31 501 36C501 41 503 41 505 37C507 32 506 27 501 22C494 15 489 13 477 13C467 14 462 17 456 27C454 32 454 33 456 37C458 41 459 40 460 36Z" fill="#111" fill-rule="evenodd"/>
    </svg>`;

// The outline with this booking's damage marks drawn on: numbered red rings
// at the tapped spots. No marks, plain outline — the pen still works.
function carDiagram(b) {
  const marks = Array.isArray(b.damageMarks) ? b.damageMarks : [];
  if (!marks.length) return CAR_OUTLINE;
  const overlay = marks.map((m, i) => {
    const cx = Math.round((m.x || 0) * 700), cy = Math.round((m.y || 0) * 338);
    return `<circle cx="${cx}" cy="${cy}" r="13" fill="rgba(176,0,32,0.12)" stroke="#b00020" stroke-width="2.5"/>` +
      `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="13" font-weight="bold" fill="#b00020">${i + 1}</text>`;
  }).join("");
  return CAR_OUTLINE.replace("</svg>", overlay + "</svg>");
}

const DOC_ACTIONS = `  <div class="ag-bar">
    <span>Choose <strong>Save as PDF</strong> in the print dialog to send this as a file.</span>
    <button class="ag-secondary" onclick="window.close()">Close</button>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>`;

const SELF_PRINT = `<script>
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
<\/script>`;

function documentHtml(b) {
  const ref = bookingRef(b);
  const ent = entityForBooking(b);   // agreement: live, follows the car's tag
  const customer = customerForBooking(b);
  const car = state.cars.find(c => c.id === b.carId);
  const terms = companyTerms();

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Rental agreement ${esc(ref)}</title>
${DOC_STYLES}</head>
<body>

${DOC_ACTIONS}

  <div class="ag-head">
    ${companyBlock(ent)}
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
        ${line("Phone", customer?.phone || b.phone)}
        ${line("Email", customer?.email || b.email)}
        ${line("Passport number", b.passport || customer?.passport)}
        ${line("Licence number", b.licence || customer?.license)}
        ${line("Broker", b.broker)}
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

  <h2>Condition at hand-over</h2>
  <div class="ag-damage">
    <!-- Drawn rather than an image file, so it prints crisply at any size and
         needs nothing loaded from anywhere. Marked up by hand at the counter. -->
    <!-- Traced from the diagram the company supplied, so it is their own
         drawing rather than an approximation of it. Vector rather than an
         image file: it prints crisply at any size, adds nothing to load,
         and the lines stay thin enough to write over. -->
    ${carDiagram(b)}
    <div class="ag-damage-key">
      <div>Mark any existing damage on the diagram before the vehicle leaves.</div>
      ${Array.isArray(b.damageMarks) && b.damageMarks.length ? `
      <div class="ag-damage-lines" style="line-height:1.7;">
        ${b.damageMarks.map((m, i) => `<div><strong>${i + 1}.</strong> ${esc(m.note || "damage marked")}</div>`).join("")}
      </div>` : ""}
      <div class="ag-damage-lines">
        <div>Fuel level out: ${typeof b.fuelLevel === "number" ? `<strong>${b.fuelLevel}%</strong>` : "____________"} &nbsp;&nbsp; in: ____________</div>
        <div>Mileage out: ____________ &nbsp;&nbsp; in: ____________</div>
        <div>Notes: _______________________________________________</div>
        <div>_____________________________________________________</div>
      </div>
    </div>
  </div>

  ${terms ? `
  <div class="ag-termspage">
    <h2>Terms and conditions</h2>
    <div class="ag-terms">${esc(terms)}</div>
  </div>` : ""}

  <div class="ag-sign">
    <div>
      <div class="ag-rule">${b.renterSignature ? `<img src="${b.renterSignature}" alt="" style="height:40px;display:block;">` : ""}</div>
      <div class="ag-cap">Renter — signature and date${b.renterSignature && b.renterSignedAt ? ` · signed ${esc(formatDate(String(b.renterSignedAt).slice(0, 10)))}` : ""}</div>
    </div>
    <div>
      <div class="ag-rule">${b.signature ? `<img src="${b.signature}" alt="" style="height:40px;display:block;">` : ""}</div>
      <div class="ag-cap">For ${esc(ent.name)} — signature and date${b.signature && b.signedAt ? ` · signed ${esc(formatDate(String(b.signedAt).slice(0, 10)))}` : ""}</div>
    </div>
  </div>

  ${docFoot(ent, `Agreement ${ref}`,
    `${b.broker ? ` · Broker ${esc(b.broker)}` : ""}${b.managedBy ? ` · Managed by ${esc(b.managedBy)}` : ""}`)}

${SELF_PRINT}

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
  const company = entityForBooking(b).name || "our team";
  const s = state.settings || {};
  const days = rentalDays(b);
  const total = rentalTotal(b);
  // "Advance" on a ledger booking means everything received so far — the
  // agreement and the receipt must never disagree about the same rupees.
  const ledgered = hasLedger(b);
  const advance = ledgered ? paidTotal(b) : advancePaid(b);
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
    lines.push(`Agreed price (${days} day${days === 1 ? "" : "s"}): ${fxPair(b, total, b.fxTotal)}`);
  } else {
    lines.push(`${days} day${days === 1 ? "" : "s"} at ${formatAmount(rateFor(b))} per day: ${formatAmount(total)}`);
  }
  // Itemised, or the balance will not add up from the customer's side and the
  // first thing they do is ring up to ask why.
  if (deliveryCost(b) > 0) lines.push(`Delivery: ${fxPair(b, deliveryCost(b), b.fxDelivery)}`);
  if (insuranceCost(b) > 0) lines.push(`Insurance: ${fxPair(b, insuranceCost(b), b.fxInsurance)}`);
  if (otherCost(b) > 0) lines.push(`Other charges: ${fxPair(b, otherCost(b), b.fxOther)}`);
  if (extrasTotal(b) > 0) lines.push(`Total: ${formatAmount(invoiceTotal(b))}`);
  if (bankCharge(b) > 0) {
    lines.push(`Bank charge (${bankChargePct(b)}% — card payment): ${formatAmount(bankCharge(b))}`);
  }

  if (advance > 0) lines.push(ledgered
    ? `Received so far: ${formatAmount(advance)}`
    : `Advance already paid: ${fxPair(b, advance, b.fxAdvance)}`);
  lines.push(b.paid ? "Paid in full — thank you." : `Balance due: ${formatAmount(balance)}`);
  if (security > 0) lines.push(`Refundable security deposit: ${fxPair(b, security, b.fxSecurity)}`);

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
  const to = customerForBooking(b)?.email || b.email || "";
  if (!to) {
    return {
      ok: false,
      reason: "No email address for this booking. Type one into the booking, or add it to the customer on the Customers page."
    };
  }

  const subject = `${entityForBooking(b).name || "Car rental"} — booking ${bookingRef(b)}`;
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

  // The customer record is the living truth for contact details: correct the
  // record and every document, reprint and message follows. The number typed
  // on the booking is only the fallback for walk-ins with no record.
  const raw = customerForBooking(b)?.phone || b.phone || "";
  const digits = waNumber(raw);
  if (!digits) {
    return { ok: false, reason: "No phone number saved for this booking or customer." };
  }

  openWhatsApp(raw, confirmationText(b));
  return { ok: true };
}

/**
 * Opens a WhatsApp chat with a message ready to send. Exported because the
 * Billing page sends payment reminders the same way and must not carry a second
 * copy of the number rules — a reminder that reached a different number from
 * the confirmation would be its own kind of bug.
 * Returns false when there is no usable number, so the caller can say so.
 */
export function openWhatsApp(rawPhone, text) {
  const digits = waNumber(rawPhone);
  if (!digits) return false;
  window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`, "_blank");
  return true;
}

/**
 * Opens the agreement in its own window and offers it to print. From the print
 * dialog, "Save as PDF" produces the file.
 *
 * A separate window rather than printing the app itself: the app's own styles
 * would fight the document's, and the person keeps their place in the planner.
 */
function openPrintable(html) {
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
  win.document.write(html);
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

export function openAgreement(bookingId) {
  const b = state.bookings.find(x => x.id === bookingId);
  if (!b) return { ok: false, reason: "That booking could not be found." };
  return openPrintable(documentHtml(b));
}

// The confirmation is the agreement's lighter sibling: same header, same
// styles, the booking's facts and money — no terms, no damage diagram, no
// signature lines. Sent or handed over when the client says yes, printed the
// same way the agreement is.
export function openConfirmation(bookingId) {
  const b = state.bookings.find(x => x.id === bookingId);
  if (!b) return { ok: false, reason: "That booking could not be found." };
  return openPrintable(confirmationHtml(b));
}

// A receipt is proof that money was received — the third printed document,
// built from the same blocks so all three are visibly the same family. It
// states what was paid, when, and what (if anything) remains.
// ---------- Invoice ----------
// The bill itself — issued whether or not anything has been paid yet, which is
// exactly what makes it a different document from the receipt. Prices are
// VAT-inclusive: a VAT invoice shows the same total the customer was quoted,
// split into value and VAT at the rate snapshotted when the number was issued.
export function openInvoice(bookingId, justIssuedNo, justKind) {
  const b = state.bookings.find(x => x.id === bookingId);
  if (!b) return { ok: false, reason: "That booking could not be found." };
  return openPrintable(invoiceHtml(b, justIssuedNo, justKind));
}

function invoiceHtml(b, justIssuedNo, justKind) {
  // Serialized: the snapshot taken at issue decides who issued this invoice —
  // re-tagging the car later can never rewrite an issued document. Invoices
  // from before entities existed default to the main company.
  const ent = entityForBooking(b, b.invoiceEntityId || "");
  const s = state.settings || {};
  const ref = bookingRef(b);
  const serial = String(justIssuedNo || invoiceNo(b) || "");
  const kind = String(justKind || b.invoiceKind || (s.vatRegistered ? "vat" : "normal"));
  const isVat = kind === "vat";
  const customer = customerForBooking(b);
  const total = amountDue(b);
  const pct = typeof b.invoiceVatPct === "number" && b.invoiceVatPct > 0 ? b.invoiceVatPct : vatRatePct();
  const split = vatSplit(total, pct);
  // Everything actually received — the payments ledger when there is one,
  // the old advance/settled figures when there is not. Same rupees either way.
  const settled = paidTotal(b);
  const outstanding = Math.max(0, Math.round((total - settled) * 100) / 100);
  const issuedOn = b.invoiceIssuedAt ? String(b.invoiceIssuedAt).slice(0, 10) : todayStr();
  const extras = [
    ["Delivery", deliveryCost(b)],
    ["Insurance", insuranceCost(b)],
    ["Other charges", otherCost(b)]
  ].filter(([, v]) => Number(v) > 0);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>${isVat ? "VAT invoice" : "Invoice"} ${esc(serial || ref)}</title>
${DOC_STYLES}
</head><body>

${DOC_ACTIONS}

  <div class="ag-head">
    ${companyBlock(ent, [
      ent.brn ? `BRN ${ent.brn}` : "",
      isVat && ent.vatNumber ? `VAT No ${ent.vatNumber}` : ""
    ])}
    <div class="ag-title">
      <h1>${isVat ? "VAT invoice" : "Invoice"}</h1>
      <div class="ag-ref">${esc(serial || ref)}</div>
      ${serial ? `<div class="ag-issued">Booking ${esc(ref)}</div>` : ""}
      <div class="ag-issued">Issued ${esc(formatDate(issuedOn))}</div>
    </div>
  </div>

  <div class="ag-cols">
    <div>
      <h2>Billed to</h2>
      <table class="ag-table">
        ${line("Name", b.renter)}
        ${line("Phone", customer?.phone || b.phone)}
        ${line("Email", customer?.email || b.email)}
      </table>
    </div>
    <div>
      <h2>For the rental of</h2>
      <table class="ag-table">
        ${line("Vehicle", bookingCarLabel(b))}
        ${line("From", formatDate(b.startDate))}
        ${line("To", formatDate(b.endDate))}
        ${line("Days", String(rentalDays(b)))}
      </table>
    </div>
  </div>

  <h2>Charges</h2>
  <table class="ag-table">
    <tr><th>Rental${hasManualTotal(b) ? " (agreed price)" : ` (${rentalDays(b)} × ${esc(formatAmount(rateFor(b)))})`}</th>
      <td class="ag-num">${esc(formatAmount(rentalTotal(b)))}</td></tr>
    ${extras.map(([label, v]) => `<tr><th>${label}</th><td class="ag-num">${esc(formatAmount(Number(v)))}</td></tr>`).join("")}
    ${bankCharge(b) > 0
      ? `<tr><th>Bank charge (${esc(String(bankChargePct(b)))}% — card payment)</th><td class="ag-num">${esc(formatAmount(bankCharge(b)))}</td></tr>`
      : ""}
    ${isVat ? `
    <tr><th>Value excluding VAT</th><td class="ag-num">${esc(formatAmount(split.excl))}</td></tr>
    <tr><th>VAT ${esc(String(pct))}% (included)</th><td class="ag-num">${esc(formatAmount(split.vat))}</td></tr>` : ""}
    <tr class="ag-total"><th>Total${isVat ? " (incl. VAT)" : ""}</th><td class="ag-num">${esc(formatAmount(total))}</td></tr>
    ${settled > 0 ? `<tr><th>${b.paid ? "Settled in full" : "Advance received"}</th><td class="ag-num">${esc(formatAmount(settled))}</td></tr>` : ""}
    ${outstanding > 0 ? `<tr><th>Balance due</th><td class="ag-num">${esc(formatAmount(outstanding))}</td></tr>` : ""}
  </table>

  ${ent.invoiceNote ? `<div class="ag-payline">${esc(String(ent.invoiceNote)).replace(/\n/g, "<br>")}</div>` : ""}

  ${docFoot(ent, `${isVat ? "VAT invoice" : "Invoice"} ${serial || ref}${serial ? ` · booking ${ref}` : ""}`)}

  ${SELF_PRINT}

</body></html>`;
}

export function openReceipt(bookingId, justIssuedNo) {
  const b = state.bookings.find(x => x.id === bookingId);
  if (!b) return { ok: false, reason: "That booking could not be found." };
  if (!b.paid && !(paidTotal(b) > 0)) {
    return { ok: false, reason: "Nothing has been received on this booking yet — record a payment first." };
  }
  // The number is passed in when it has only just been allocated: the write is
  // on its way to the server but this device's copy of the booking may not
  // carry it yet, and a receipt printing without its number would be the one
  // failure this whole feature exists to prevent.
  return openPrintable(receiptHtml(b, justIssuedNo));
}

function receiptHtml(b, justIssuedNo) {
  const ent = entityForBooking(b, b.receiptEntityId || "");
  const ref = bookingRef(b);
  // The serial number the MRA expects. Old receipts issued before numbering
  // existed have none, and fall back to the booking reference so a reprint of
  // an old one still identifies itself.
  const serial = String(justIssuedNo || receiptNo(b) || "");
  const customer = customerForBooking(b);
  // What the client actually handed over includes the card fee, so a receipt
  // that showed only the rental would not match their statement.
  const total = amountDue(b);
  const settled = paidTotal(b);
  const outstanding = Math.max(0, Math.round((total - settled) * 100) / 100);
  const paidOn = b.paid && b.paidAt ? String(b.paidAt).slice(0, 10) : todayStr();
  // How the money arrived — the last recorded payment's method. The slot for
  // this existed in the receipt from the start; the ledger finally fills it.
  const paidBy = lastPaymentMethod(b);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Receipt ${esc(serial || ref)}</title>
${DOC_STYLES}
</head><body>

${DOC_ACTIONS}

  <div class="ag-head">
    ${companyBlock(ent)}
    <div class="ag-title">
      <h1>Receipt</h1>
      <div class="ag-ref">${esc(serial || ref)}</div>
      ${serial ? `<div class="ag-issued">Booking ${esc(ref)}</div>` : ""}
      <div class="ag-issued">Issued ${esc(formatDate(todayStr()))}</div>
    </div>
  </div>

  <p>Received with thanks from <strong>${esc(b.renter || "")}</strong>${b.passport ? ` (passport ${esc(b.passport)})` : ""},
  the sum of <strong>${esc(formatAmount(settled))}</strong> on ${esc(formatDate(paidOn))}${paidBy ? `, paid by ${esc(paidBy)}` : ""}.</p>

  <div class="ag-cols">
    <div>
      <h2>Paid by</h2>
      <table class="ag-table">
        ${line("Name", b.renter)}
        ${line("Phone", customer?.phone || b.phone)}
        ${line("Email", customer?.email || b.email)}
      </table>
    </div>
    <div>
      <h2>For the rental of</h2>
      <table class="ag-table">
        ${line("Vehicle", bookingCarLabel(b))}
        ${line("From", formatDate(b.startDate))}
        ${line("To", formatDate(b.endDate))}
      </table>
    </div>
  </div>

  <h2>Amount</h2>
  <table class="ag-table">
    <tr><th>Total charges</th><td class="ag-num">${esc(formatAmount(invoiceTotal(b)))}</td></tr>
    ${bankCharge(b) > 0
      ? `<tr><th>Bank charge (${esc(String(bankChargePct(b)))}% — card payment)</th><td class="ag-num">${esc(formatAmount(bankCharge(b)))}</td></tr>`
      : ""}
    <tr class="ag-total"><th>${b.paid ? "Received in full" : "Received (advance)"}</th>
      <td class="ag-num">${esc(formatAmount(settled))}</td></tr>
    ${outstanding > 0 ? `<tr><th>Still outstanding</th><td class="ag-num">${esc(formatAmount(outstanding))}</td></tr>` : ""}
    ${Number(b.securityDeposit) > 0 ? `<tr><th>Security deposit ${esc(b.securityStatus === "refunded" ? "(refunded)" : b.securityStatus === "kept" ? "(retained)" : "(held)")}</th>
      <td class="ag-num">${esc(formatAmount(Number(b.securityDeposit)))}</td></tr>` : ""}
  </table>

  <div class="ag-sign" style="margin-top:26px;">
    <div>
      <div class="ag-rule">${b.signature ? `<img src="${b.signature}" alt="" style="height:40px;display:block;">` : ""}</div>
      <div class="ag-cap">For ${esc(ent.name)} — received by</div>
    </div>
    <div></div>
  </div>

  ${docFoot(ent, `Receipt ${serial || ref}${serial ? ` · booking ${ref}` : ""}`)}

  ${SELF_PRINT}

</body></html>`;
}

function confirmationHtml(b) {
  const ent = entityForBooking(b);
  const ref = bookingRef(b);
  const customer = customerForBooking(b);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Booking confirmation ${esc(ref)}</title>
${DOC_STYLES}
</head><body>

${DOC_ACTIONS}

  <div class="ag-head">
    ${companyBlock(ent)}
    <div class="ag-title">
      <h1>Booking confirmation</h1>
      <div class="ag-ref">${esc(ref)}</div>
      <div class="ag-issued">Issued ${esc(formatDate(todayStr()))}</div>
    </div>
  </div>

  <p>We are pleased to confirm your booking. Please check the details below and
  let us know if anything needs changing.</p>

  <div class="ag-cols">
    <div>
      <h2>Booked for</h2>
      <table class="ag-table">
        ${line("Name", b.renter)}
        ${line("Phone", customer?.phone || b.phone)}
        ${line("Email", customer?.email || b.email)}
      </table>
    </div>
    <div>
      <h2>Vehicle</h2>
      <table class="ag-table">
        ${line("Vehicle", bookingCarLabel(b))}
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

  <h2>Price</h2>
  ${moneyBlock(b)}

  ${(function () {
    // The same wording the email and WhatsApp confirmations use. The printed
    // one used to hard-code the standard lines and ignore Settings entirely,
    // so a company that had customised its message still handed the customer a
    // sheet saying something else.
    const custom = (state.settings?.messageNote || "").trim();
    const body = custom || (DEFAULT_MESSAGE_NOTE + "\nWe look forward to welcoming you.");
    return body.split("\n").filter(l => l.trim())
      .map(l => `<p>${esc(l.trim())}</p>`).join("\n  ");
  })()}

  ${docFoot(ent, `Booking confirmation ${ref}`)}

  ${SELF_PRINT}

</body></html>`;
}
