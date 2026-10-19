// Agent-friendly markdown export of the dashboard state.
//
// renderAgentMarkdown turns the dashboard aggregation (computeDashboard in
// actions.ts — the exact same numbers the UI displays) into one compact
// markdown document the user can paste to an AI assistant (e.g. Muse) and
// immediately discuss: what is still unused, what expires soonest, how each
// credit is redeemed, and where each number came from. It is a pure function
// of the dashboard data, so it is unit-tested with fictional fixtures.

import type { DashboardData } from "./actions";

type Credit = DashboardData["credits"][number];

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  AUD: "A$",
  CAD: "C$",
  HKD: "HK$",
  SGD: "S$",
  CHF: "CHF ",
};

/**
 * Plain amount in the account's currency: $50, $20.50, $1,234 — never
 * $50.00. USD (the default) renders exactly as it always has; other ISO
 * currencies use their symbol or code. Negatives (clawback postings)
 * render -$50.
 */
export function money(n: number, currency: string = "USD"): string {
  const rounded = Math.round(n * 100) / 100;
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  const body = Number.isInteger(abs)
    ? abs.toLocaleString("en-US")
    : abs.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  return `${sign}${symbol}${body}`;
}

function statusOf(c: Credit): string {
  if (c.currentRemaining <= 0) return `used up · renews ${c.nextPeriodStart}`;
  return c.currentUsed > 0 ? "partially used" : "available";
}

/**
 * A card's effective ending: the user-recorded fifth digit followed by
 * the mask when both are present ("41003"), otherwise the plain mask
 * ("1003"). The mask alone cannot tell one person's same-product cards
 * apart — a household can hold three Aspires all ending 1003 — while
 * the issuers' apps show the five-digit ending that does. This is THE
 * definition every surface agrees on: the duplicate heuristic in
 * actions.ts compares effective endings, and the labels below (and the
 * dashboard's) render them.
 */
export function effectiveEnding(
  mask: string | null | undefined,
  fifthDigit: string | null | undefined,
): string {
  const m = mask ?? "";
  const d = fifthDigit ?? "";
  return d !== "" && m !== "" ? `${d}${m}` : m;
}

/**
 * The canonical compact card identifier: owner label + effective
 * ending, plainly — "Kun 41003" (fifth digit recorded) or "Na 1003".
 * Falls back to whichever half exists; "" when neither does.
 */
export function cardTag(
  owner: string | null | undefined,
  mask: string | null | undefined,
  fifthDigit: string | null | undefined,
): string {
  const ending = effectiveEnding(mask, fifthDigit);
  if (owner && ending) return `${owner} ${ending}`;
  return ending || owner || "";
}

type Account = DashboardData["accounts"][number];

/**
 * "Sam 2222 · Hilton Honors Aspire Card" — the canonical tag (owner +
 * effective ending) followed by the product name.
 */
function accountLabel(a: Account): string {
  const tag = cardTag(a.owner, a.mask, a.fifthDigit);
  return tag ? `${tag} · ${a.name}` : a.name;
}

/**
 * The same composition for a credit: "Sam 2222 · Hilton Honors Aspire
 * Card". When the user has set an account nickname (the short prefix
 * the dashboard rows carry, e.g. "UA"), it stands in for the product
 * name: "Na 6151 · UA". Without a nickname, the catalog's default
 * display name for the product (e.g. "CSP") stands in instead; the raw
 * account name is the last resort.
 */
function cardLabel(c: Credit): string {
  const product =
    c.accountNickname !== ""
      ? c.accountNickname
      : c.accountDefaultName
        ? c.accountDefaultName
        : c.accountName;
  const tag = cardTag(c.owner, c.mask, c.fifthDigit);
  return tag ? `${tag} · ${product}` : product;
}

function creditBlock(c: Credit): string {
  const lines: string[] = [`### ${c.name} — ${cardLabel(c)}`];
  const days =
    c.daysLeft <= 0
      ? "ends today"
      : `${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"} left`;
  lines.push(`- Period: ${c.periodStart} to ${c.periodEnd} (${c.periodLabel}) · ${days}`);
  const cur = c.currency ?? "USD";
  lines.push(
    `- ${money(c.amount, cur)} credit · ${money(c.currentUsed, cur)} used · ${money(c.currentRemaining, cur)} remaining · ${statusOf(c)}`,
  );
  if (c.enrolled === null && c.enrollmentRequired)
    lines.push(
      "- Enrollment: unconfirmed — this app cannot see the issuer's enrollment state; enroll before using, or mark this credit enrolled if you already have",
    );
  if (c.enrolled === false) lines.push("- Enrollment: marked not enrolled — enroll before using");
  // The catalog fact that this benefit requires enrollment at all (as
  // opposed to the row's enrollment state above): an assistant must
  // never advise spending toward a credit that cannot pay out yet.
  if (c.enrollmentRequired && c.enrollmentNote) lines.push(`- ${c.enrollmentNote}`);
  // The catalog note is the usage rule (how to redeem, trigger conditions,
  // manual-claim steps) — the part that lets an assistant advise, not just
  // report numbers.
  if (c.note) lines.push(`- How to use: ${c.note}`);
  if (c.currentPostings.length > 0) {
    lines.push("- Postings this period:");
    for (const p of c.currentPostings) {
      const src = p.source === "manual" ? "manual entry" : "Plaid";
      const posted = p.postedDate !== p.date ? ` · posted ${p.postedDate}` : "";
      lines.push(`  - ${p.date} "${p.name}" ${money(p.amount, cur)} (${src})${posted}`);
    }
  } else {
    lines.push("- Postings this period: none yet");
  }
  return lines.join("\n");
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The "needs your decision" list: every place the dashboard is running
 * on an assumption the user has not confirmed — a catalog-default
 * anniversary anchor, a suspected duplicate account, an enrollment that
 * was never marked done, a login whose owner was never identified. An
 * assistant reading this export should RAISE these with the user rather
 * than silently trusting the affected numbers.
 */
export function warningLines(data: DashboardData): string[] {
  const lines: string[] = [];
  for (const c of data.credits) {
    if (c.anchorMonth != null && c.anchorDay != null && !c.anchorConfirmed) {
      lines.push(
        `- Anchor not confirmed: ${c.name} — ${cardLabel(c)} is using the catalog-default ` +
          `anniversary anchor (${MONTH_NAMES[c.anchorMonth - 1]} ${c.anchorDay}). If the card's ` +
          "real anniversary differs, its period — and everything computed from it — is wrong. " +
          "Confirm or correct the anchor on the credit (Edit) in the dashboard.",
      );
    }
  }
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  for (const a of data.accounts) {
    if (!a.suspectedDuplicate) continue;
    const suspects = a.duplicateSuspectIds
      .map((id) => accountById.get(id))
      .filter((o): o is Account => o != null);
    const others = suspects.map((o) => accountLabel(o)).join("; ");
    // The same-ending heuristic (same product + same effective ending,
    // same owner) has a user-side resolution the transaction-evidence
    // signal does not: record each card's fifth digit, and cards whose
    // five-digit endings differ stop being flagged.
    const sameEnding = suspects.some(
      (o) =>
        o.name.trim().toLowerCase() === a.name.trim().toLowerCase() &&
        (o.owner ?? null) === (a.owner ?? null) &&
        effectiveEnding(o.mask, o.fifthDigit) === effectiveEnding(a.mask, a.fifthDigit),
    );
    lines.push(
      `- Possible duplicate account: ${accountLabel(a)} may be the same ` +
        `underlying card as ${others}. It is still counted in every total. If it is a ` +
        "supplementary/duplicate record, mark it ignored in the Cards section; if it is a " +
        "genuinely separate card, no action is needed." +
        (sameEnding
          ? " If the two are separate cards that share an ending, record each card's fifth " +
            "digit in the Cards section — the digit before the last four, shown as part of " +
            "the five-digit ending in your issuer's app: cards whose five-digit endings " +
            "differ are no longer flagged."
          : ""),
    );
  }
  for (const c of data.credits) {
    if (c.active && c.enrollmentRequired && c.enrolled === null) {
      lines.push(
        `- Enrollment required, status unconfirmed: ${c.name} — ${cardLabel(c)}. ` +
          "The app cannot see the issuer's enrollment state. If this card is enrolled, mark it enrolled; otherwise purchases do not count toward this credit until the card is enrolled with the issuer.",
      );
    }
    if (c.active && c.enrollmentRequired && c.enrolled === false) {
      lines.push(
        `- Enrollment required, marked not enrolled: ${c.name} — ${cardLabel(c)}. ` +
          "Purchases do not count toward this credit until the card is enrolled with the issuer.",
      );
    }
  }
  for (const a of data.accounts) {
    if (!a.ignored && a.owner == null) {
      lines.push(
        `- Login not identified yet: ${accountLabel(a)} has no owner ` +
          "attribution. Set its owner in the Cards section so its credits group under the right person.",
      );
    }
  }
  return lines;
}

/** Every imported account, so cards with no tracked credits are visible too. */
function accountLines(data: DashboardData): string[] {
  if (data.accounts.length === 0) return ["- No accounts imported yet."];
  return data.accounts.map((a) => {
    let line = `- ${accountLabel(a)}`;
    const shown = a.nickname !== "" ? a.nickname : (a.defaultName ?? "");
    if (shown !== "") line += ` — shown as "${shown}"`;
    if (a.ignored) line += " — ignored (you marked it a duplicate / not tracked)";
    else if (a.creditCount === 0) line += " — no supported credits tracked";
    if (a.suspectedDuplicate) line += " — possible duplicate (see Warnings)";
    return line;
  });
}

export function renderAgentMarkdown(data: DashboardData, generatedAt: Date): string {
  const tracked = data.credits.filter((c) => c.active);
  const stoppedCount = data.credits.length - tracked.length;
  // Urgency first: credits that still have money sort by nearest period end
  // (largest remaining first on ties); used-up credits follow, also by
  // period end. Mirrors the dashboard action list's own ordering.
  const sorted = [...tracked].sort((a, b) => {
    const aDone = a.currentRemaining <= 0 ? 1 : 0;
    const bDone = b.currentRemaining <= 0 ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    if (a.periodEnd !== b.periodEnd) return a.periodEnd < b.periodEnd ? -1 : 1;
    return b.currentRemaining - a.currentRemaining;
  });
  const open = sorted.filter((c) => c.currentRemaining > 0);
  const usedUp = sorted.filter((c) => c.currentRemaining <= 0);

  const out: string[] = [];
  out.push("# Credit Card Coupon Book");
  out.push("");
  out.push(
    `Generated: ${generatedAt.toISOString()} · Current periods as of ${data.today}. ` +
      "Paste this file to your AI assistant to discuss your card credits.",
  );
  if (data.lastImportAt) out.push(`Postings last imported: ${data.lastImportAt}`);
  out.push("");
  out.push("## Summary");
  out.push("");
  out.push(
    `- Total unused in current periods: ${money(data.totals.remainingNow)} across ` +
      `${data.totals.openCredits} open credit${data.totals.openCredits === 1 ? "" : "s"}`,
  );
  const soonest = open[0];
  if (soonest) {
    const atBoundary = open.filter((c) => c.periodEnd === soonest.periodEnd);
    const amount = atBoundary.reduce((s, c) => s + c.currentRemaining, 0);
    out.push(
      `- Expiring soonest: ${money(amount)} on ${soonest.periodEnd} ` +
        `(${atBoundary.length} credit${atBoundary.length === 1 ? "" : "s"})`,
    );
  } else {
    out.push("- Expiring soonest: nothing — every tracked credit is used up");
  }
  if (stoppedCount > 0) {
    out.push(
      `- Not shown: ${stoppedCount} credit${stoppedCount === 1 ? "" : "s"} marked "stop tracking" in the dashboard`,
    );
  }
  out.push("");
  // Decisions the user still owes: the dashboard must surface its own
  // unconfirmed assumptions instead of letting an assistant (or the
  // user) trust numbers built on them.
  out.push("## Warnings — needs your decision");
  out.push("");
  const warnings = warningLines(data);
  if (warnings.length > 0) {
    out.push(...warnings);
  } else {
    out.push("- Nothing needs your attention.");
  }
  out.push("");
  // Credits hidden by the display-exclusion preference never appear above
  // and never count in the totals — but an assistant managing the user's
  // credits has to know they exist (and that it can re-enable them via the
  // preference actions) instead of concluding the cards lack them.
  if (data.excludedPatterns.length > 0) {
    out.push("## Hidden by preference");
    out.push("");
    out.push(
      "These credits are hidden by your display preference and are not counted " +
        "in any total above. To change which credits are hidden, use the Display " +
        "settings section on the dashboard page, or ask your assistant in chat — " +
        "both update the same preference.",
    );
    out.push("");
    if (data.hiddenCredits.length > 0) {
      for (const h of data.hiddenCredits) {
        const tag = cardTag(h.owner, h.mask, h.fifthDigit);
        const card = tag ? `${tag} · ${h.accountName}` : h.accountName;
        out.push(`- ${h.name} — ${card}`);
      }
    } else {
      out.push("- None of your stored credits currently match the preference.");
    }
    out.push(`- Exclusion entries in force: ${data.excludedPatterns.join(", ")}`);
    out.push("");
  }
  out.push("## Credits — most urgent first");
  out.push("");
  if (open.length === 0) {
    out.push("No unused credits in the current periods.");
    out.push("");
  } else {
    for (const c of open) {
      out.push(creditBlock(c));
      out.push("");
    }
  }
  if (usedUp.length > 0) {
    out.push("## Used up — renewing next period");
    out.push("");
    for (const c of usedUp) {
      out.push(creditBlock(c));
      out.push("");
    }
  }
  out.push("## Accounts");
  out.push("");
  out.push(...accountLines(data));
  out.push("");
  return `${out.join("\n").trimEnd()}\n`;
}
