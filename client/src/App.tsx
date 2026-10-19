import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import { groupCredits, type CreditGroup } from "./grouping";
import { REFER_PROMPT } from "./referPrompt";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Credit = Dashboard["credits"][number];
type Period = Credit["period"];

/** Format an amount in the account's currency (USD when unknown). */
const money = (n: number, currency: string = "USD") => {
  try {
    return n.toLocaleString("en-US", { style: "currency", currency });
  } catch {
    return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }
};

/** "2027-01-01" → "Jan 1, 2027" (interpreted as a plain calendar date). */
const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const MONO = "font-mono tabular-nums";

/**
 * A card's effective ending: the recorded fifth digit followed by the
 * mask ("41003") when a digit is set, otherwise the plain mask
 * ("1003"). The server defines the same rule (effectiveEnding in
 * agentMarkdown.ts); every surface renders endings through it.
 */
function endingOf(mask: string, fifthDigit: string): string {
  return fifthDigit !== "" && mask !== "" ? `${fifthDigit}${mask}` : mask;
}

/**
 * The canonical compact card label: owner label + effective ending,
 * plainly — "Kun 41003" (fifth digit recorded) or "Na 1003". Falls
 * back to whichever half exists; "" when neither does.
 */
function cardTag(owner: string | null, mask: string, fifthDigit: string): string {
  const ending = endingOf(mask, fifthDigit);
  if (owner && ending) return `${owner} ${ending}`;
  return ending || owner || "";
}

/** Shortened product name ("Hilton Honors Aspire Card" → "Aspire"). */
function shortProduct(name: string): string {
  return name
    .replace(/®/g, "")
    .replace("American Express Card", "")
    .replace(" Card", "")
    .replace("Hilton Honors ", "")
    .replace("Marriott Bonvoy ", "Marriott ")
    .trim();
}

/**
 * How a card is identified in rows and lists: the canonical tag
 * followed by the product — "Kun 41003 · Aspire". Falls back to the
 * product alone when there is no tag (no owner label and no ending).
 */
function cardLabel(owner: string | null, name: string, mask: string, fifthDigit: string): string {
  const tag = cardTag(owner, mask, fifthDigit);
  const product = shortProduct(name);
  return tag ? `${tag} · ${product}` : product;
}

// The household's logins belong to different master accounts (for example,
// two people in one household). Every card/credit carries its login's
// display label (configured in the dashboard settings) so the two master
// accounts are always distinguishable. The badge color is derived from the
// label text itself, so renamed labels keep working without code changes.
function OwnerBadge({ owner }: { owner: string | null }) {
  if (!owner) return null;
  const alt = [...owner].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 2 === 1;
  return (
    <span
      className="ml-2 inline-block rounded px-1.5 py-0.5 align-middle text-xs font-semibold"
      style={{
        background: alt ? "rgba(193, 78, 116, 0.16)" : "color-mix(in srgb, var(--accent) 16%, transparent)",
        color: alt ? "#c14e74" : "var(--accent)",
      }}
    >
      {owner}
    </span>
  );
}

// Short card-product prefix shown before every credit name, so a credit is
// identifiable at a glance without reading the card line underneath:
// Aspire, BusPlat, BusGold, Plat, Brilliant, …
// Co-branded Platinum variants (e.g. the Morgan Stanley Platinum) are
// personal Platinums with the same benefits, so they use the plain "Plat"
// prefix like any other Platinum.
function productPrefix(accountName: string): string {
  const n = accountName.toLowerCase();
  if (n.includes("aspire")) return "Aspire";
  if (n.includes("business platinum")) return "BusPlat";
  if (n.includes("business gold")) return "BusGold";
  if (n.includes("morgan stanley")) return "Plat";
  if (n.includes("brilliant")) return "Brilliant";
  if (n.includes("blue business")) return "BBPlus";
  if (n.includes("bonvoy business")) return "BonvoyBiz";
  if (n.includes("everyday")) return "EveryDay";
  if (n.includes("sapphire")) return "Sapphire";
  if (n.includes("world of hyatt") && n.includes("business")) return "HyattBiz";
  if (n.includes("ihg")) return "IHG";
  if (n.includes("ritz")) return "Ritz";
  if (n.includes("altitude")) return "Altitude";
  if (n.includes("platinum")) return "Plat";
  if (n.includes("gold")) return "Gold";
  return accountName.replace(/®/g, "").replace(" Card", "").trim().split(/\s+/)[0] ?? "";
}

/**
 * The prefix a credit row carries: the account's user-set nickname when
 * one exists (e.g. UA / UABus), otherwise the catalog's default display
 * name for the product (e.g. CSP), otherwise the product-derived prefix.
 */
function prefixFor(c: Credit): string {
  if (c.accountNickname !== "") return c.accountNickname;
  if (c.accountDefaultName !== "") return c.accountDefaultName;
  return productPrefix(c.accountName);
}

function PrefixChip({ label }: { label: string }) {
  if (!label) return null;
  return (
    <span className="mr-2 inline-block rounded bg-[var(--bg)] px-1.5 py-0.5 align-middle text-xs font-semibold text-[var(--dim)]">
      {label}
    </span>
  );
}

function periodWord(p: Period): string {  return p === "monthly"
    ? "this month"
    : p === "quarterly"
      ? "this quarter"
      : p === "semiannual"
        ? "this half-year"
        : "this year";
}

function urgencyColor(daysLeft: number, remaining: number): string {
  if (remaining <= 0) return "var(--good)";
  if (daysLeft <= 14) return "var(--bad)";
  if (daysLeft <= 45) return "var(--warn)";
  return "var(--accent)";
}

export function App() {
  const queryClient = useQueryClient();
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard({}) });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const refresh = useMutation({
    mutationFn: () => api.refreshCredits({}),
    onSuccess: (res) => {
      if (res.started) {
        setRefreshing(true);
        setRefreshError(null);
      } else {
        setRefreshError(res.error ?? "Refresh could not be started.");
      }
    },
    onError: (e) => setRefreshError(String(e)),
  });

  const status = useQuery({
    queryKey: ["refresh-status"],
    queryFn: () => api.refreshStatus({}),
    enabled: refreshing,
    refetchInterval: 4000,
  });

  useEffect(() => {
    if (!refreshing || !status.data) return;
    if (status.data.status === "completed" || status.data.status === "failed") {
      setRefreshing(false);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  }, [refreshing, status.data, queryClient]);

  // First open with no import yet: pull the cards automatically instead of
  // showing an empty dashboard that looks like there are no cards at all.
  const autoRefreshTried = useRef(false);
  useEffect(() => {
    if (autoRefreshTried.current) return;
    if (!dash.data) return;
    if (dash.data.accounts.length > 0 || dash.data.lastImportAt) return;
    autoRefreshTried.current = true;
    refresh.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dash.data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });

  // Agent Markdown: a one-file snapshot of the dashboard state (same
  // numbers as below) to paste to an AI assistant for discussion.
  const [agentMd, setAgentMd] = useState<string | null>(null);
  const [agentMdError, setAgentMdError] = useState<string | null>(null);
  const [mdCopied, setMdCopied] = useState(false);
  const agentMdFetch = useMutation({
    mutationFn: () => api.getAgentMarkdown({}),
    onSuccess: (res) => {
      setAgentMd(res.markdown);
      setMdCopied(false);
      setAgentMdError(null);
    },
    onError: (e) => setAgentMdError(String(e)),
  });
  const copyAgentMd = async () => {
    if (!agentMd) return;
    try {
      await navigator.clipboard.writeText(agentMd);
      setMdCopied(true);
    } catch {
      setMdCopied(false);
    }
  };
  const downloadAgentMd = () => {
    if (!agentMd) return;
    const url = URL.createObjectURL(new Blob([agentMd], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "credit-card-coupon-book.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Refer: a fixed prompt (REFER_PROMPT) a friend pastes into their own
  // Muse to build their own private dashboard from the public repo. It
  // carries none of this instance's data — it refers the product, not access.
  const [referOpen, setReferOpen] = useState(false);
  const [referCopied, setReferCopied] = useState(false);
  const copyReferPrompt = async () => {
    try {
      await navigator.clipboard.writeText(REFER_PROMPT);
      setReferCopied(true);
    } catch {
      setReferCopied(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10">
        <header className="flex flex-col items-start gap-3 pt-5 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-tight">Available now</h1>
            <p className="mt-1 text-sm text-[var(--dim)]">
              {dash.data
                ? dash.data.lastImportAt
                  ? `Card postings imported ${new Date(dash.data.lastImportAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${dash.data.accounts.filter((a) => !a.ignored).length} cards tracked · current periods only${dash.data.dataCoverageStart ? ` · postings kept from ${new Date(`${dash.data.dataCoverageStart}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} — refreshes only add the last 30 days, older postings are never removed` : ""}`
                  : refreshing
                    ? "Pulling your cards from Plaid — your credits will appear here in a minute."
                    : "No Plaid import yet — tap Refresh to pull your credits."
                : "Loading your credits…"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 sm:shrink-0">
            <button
              type="button"
              aria-label="Refer this dashboard to a friend"
              aria-expanded={referOpen}
              onClick={() => {
                setReferOpen((v) => !v);
                setReferCopied(false);
              }}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium"
            >
              Refer
            </button>
            <button
              type="button"
              aria-label="Get agent markdown snapshot"
              disabled={agentMdFetch.isPending}
              onClick={() => agentMdFetch.mutate()}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium disabled:opacity-50"
            >
              {agentMdFetch.isPending ? "Preparing…" : "Agent Markdown"}
            </button>
            <button
              type="button"
              aria-label="Refresh credits from Plaid"
              disabled={refresh.isPending || refreshing}
              onClick={() => refresh.mutate()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        {refreshError && (
          <p role="alert" className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--bad)]">
            {refreshError}
          </p>
        )}
        {refreshing && (
          <p className="mb-3 text-sm text-[var(--dim)]">
            Reading your card accounts from Plaid — this can take a minute. The list below updates when it lands.
          </p>
        )}

        {agentMdError && (
          <p role="alert" className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--bad)]">
            Couldn't prepare the markdown snapshot: {agentMdError}
          </p>
        )}
        {agentMd && (
          <section aria-label="Agent markdown snapshot" className="mb-5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
              <span className="text-base font-medium">Agent Markdown</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  aria-label="Copy agent markdown to clipboard"
                  onClick={() => void copyAgentMd()}
                  className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
                >
                  {mdCopied ? "Copied ✓" : "Copy"}
                </button>
                <button
                  type="button"
                  aria-label="Download agent markdown as a file"
                  onClick={downloadAgentMd}
                  className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
                >
                  Download .md
                </button>
                <button
                  type="button"
                  aria-label="Close agent markdown"
                  onClick={() => setAgentMd(null)}
                  className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
                >
                  Close
                </button>
              </div>
            </div>
            <p className="px-4 pt-3 text-sm text-[var(--dim)]">
              One markdown file with everything on this page — paste it to your AI assistant to discuss what to use next.
            </p>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-relaxed">{agentMd}</pre>
          </section>
        )}

        {referOpen && (
          <section aria-label="Refer this dashboard" className="mb-5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
              <span className="text-base font-medium">Refer this dashboard</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  aria-label="Copy refer prompt to clipboard"
                  onClick={() => void copyReferPrompt()}
                  className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
                >
                  {referCopied ? "Copied ✓" : "Copy prompt"}
                </button>
                <button
                  type="button"
                  aria-label="Close refer panel"
                  onClick={() => setReferOpen(false)}
                  className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
                >
                  Close
                </button>
              </div>
            </div>
            <p className="px-4 pt-3 text-sm text-[var(--dim)]">
              Send this prompt to a friend — they paste it into their own Muse and get their own private dashboard built from the open-source repo, connected to their own cards. It gives them no access to your data.
            </p>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-relaxed">{REFER_PROMPT}</pre>
          </section>
        )}

        {dash.isPending && <p className="py-10 text-center text-sm text-[var(--dim)]">Loading…</p>}
        {dash.error && (
          <p role="alert" className="py-10 text-center text-sm text-[var(--bad)]">
            Couldn't load the dashboard: {String(dash.error)}
          </p>
        )}

        {dash.data && (
          <>
            <SummaryStrip data={dash.data} />
            <ActionList data={dash.data} onChanged={invalidate} />
            <UnassignedSection data={dash.data} onChanged={invalidate} />
            <AccountsSection data={dash.data} onChanged={invalidate} />
            <DisplaySettingsSection onChanged={invalidate} />
          </>
        )}
      </main>
    </div>
  );
}

function SummaryStrip({ data }: { data: Dashboard }) {
  const t = data.totals;
  const items: { label: string; value: string; color?: string }[] = [
    { label: "Left to use right now", value: money(t.remainingNow) },
    {
      label: "Expires within 31 days",
      value: money(t.expiring31),
      color: t.expiring31 > 0 ? "var(--warn)" : undefined,
    },
    {
      label: "Expires within 14 days",
      value: money(t.expiring14),
      color: t.expiring14 > 0 ? "var(--bad)" : undefined,
    },
    {
      label: "Credits still open",
      value: String(t.openCredits),
    },
  ];
  return (
    <section aria-label="Totals" className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="bg-[var(--surface)] px-3 py-3">
          <div className={`${MONO} text-lg font-semibold`} style={it.color ? { color: it.color } : undefined}>
            {it.value}
          </div>
          <div className="mt-0.5 text-xs leading-snug text-[var(--dim)]">{it.label}</div>
        </div>
      ))}
    </section>
  );
}

function sortedActionable(credits: Credit[]): Credit[] {
  return credits
    .filter((c) => c.active)
    .sort((a, b) => {
      const aDone = a.currentRemaining <= 0 ? 1 : 0;
      const bDone = b.currentRemaining <= 0 ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      if (a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft;
      return b.currentRemaining - a.currentRemaining;
    });
}

function ActionList({ data, onChanged }: { data: Dashboard; onChanged: () => void }) {
  const [showUsedUp, setShowUsedUp] = useState(false);
  const all = groupCredits(sortedActionable(data.credits));
  const available = all.filter((g) => g.remaining > 0);
  const usedUp = all.filter((g) => g.remaining <= 0);
  const list = showUsedUp ? all : available;
  if (all.length === 0) {
    return (
      <section aria-label="Credits available now" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-8 text-center">
        <p className="text-sm text-[var(--dim)]">
          No credits tracked yet. Once your Plaid import lands, every card's monthly, quarterly, and annual credits show up here with what's left in the current period.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Credits available now" className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <span className="text-base font-medium">Available now ({available.length})</span>
        {usedUp.length > 0 && (
          <button
            type="button"
            aria-label={showUsedUp ? "Hide used-up credits" : "Show used-up credits"}
            aria-expanded={showUsedUp}
            onClick={() => setShowUsedUp((v) => !v)}
            className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            {showUsedUp ? "Hide used up" : `Used up (${usedUp.length})`}
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-[var(--dim)]">
          Nothing left to use in the current periods — every tracked credit is used up.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {list.map((g) => {
            const only = g.members.length === 1 ? g.members[0] : undefined;
            return only ? (
              <CreditRow key={g.key} credit={only} allCredits={data.credits} onChanged={onChanged} />
            ) : (
              <GroupRow key={g.key} group={g} allCredits={data.credits} onChanged={onChanged} />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CreditRow({
  credit: c,
  allCredits,
  onChanged,
  nested = false,
}: {
  credit: Credit;
  allCredits: Credit[];
  onChanged: () => void;
  nested?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const pct = c.amount > 0 ? Math.min(100, (c.currentUsed / c.amount) * 100) : 0;
  const done = c.currentRemaining <= 0;
  const color = urgencyColor(c.daysLeft, c.currentRemaining);

  const toggleActive = useMutation({
    mutationFn: (active: boolean) => api.updateCredit({ id: c.id, active }),
    onSuccess: onChanged,
  });
  const toggleEnrolled = useMutation({
    mutationFn: (enrolled: boolean) => api.updateCredit({ id: c.id, enrolled }),
    onSuccess: onChanged,
  });
  const confirmAnchor = useMutation({
    mutationFn: () => api.updateCredit({ id: c.id, anchorConfirmed: true }),
    onSuccess: onChanged,
  });
  // An anchor that came from the catalog is a placeholder guess: the
  // credit warns until the user confirms it (or corrects it in Edit).
  const anchorUnconfirmed = !c.anchorConfirmed && c.anchorMonth != null && c.anchorDay != null;

  return (
    <li className={nested ? "py-3" : "px-4 py-3"}>
      <button
        type="button"
        aria-label={`${c.name} on ${cardLabel(c.owner, c.accountName, c.mask, c.fifthDigit)} — details`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="block w-full text-left"
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-medium leading-snug">
              {!nested && <PrefixChip label={prefixFor(c)} />}
              {nested ? cardLabel(c.owner, c.accountName, c.mask, c.fifthDigit) : c.name}
              <OwnerBadge owner={c.owner} />
              {c.enrolled === false && (
                <span className="ml-2 rounded bg-[var(--bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--warn)]">
                  not enrolled
                </span>
              )}
              {c.enrolled === null && c.enrollmentRequired && (
                <span className="ml-2 rounded bg-[var(--bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--warn)]">
                  enrollment unconfirmed
                </span>
              )}
              {anchorUnconfirmed && (
                <span className="ml-2 rounded bg-[var(--bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--warn)]">
                  anchor unconfirmed
                </span>
              )}
            </div>
            <div className="mt-0.5 text-sm text-[var(--dim)]">
              {nested
                ? `${c.periodLabel} · ends ${c.periodEnd}`
                : `${cardLabel(c.owner, c.accountName, c.mask, c.fifthDigit)} · ${c.periodLabel} · ends ${c.periodEnd}`}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className={`${MONO} text-xl font-semibold`} style={{ color }}>
              {done ? money(0, c.currency) : money(c.currentRemaining, c.currency)}
            </div>
            <div className="text-xs text-[var(--dim)]">
              {done ? `used up ✓ · renews ${fmtDay(c.nextPeriodStart)}` : `${c.daysLeft}d left ${periodWord(c.period)}`}
            </div>
          </div>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg)]" role="img" aria-label={`${money(c.currentUsed, c.currency)} of ${money(c.amount, c.currency)} used`}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
        <div className={`${MONO} mt-1 text-xs text-[var(--dim)]`}>
          {money(c.currentUsed, c.currency)} of {money(c.amount, c.currency)} posted
        </div>
      </button>

      {open && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          {c.note && <p className="mb-2 text-sm text-[var(--dim)]">{c.note}</p>}
          {c.enrollmentRequired && c.enrollmentNote && (
            <p className="mb-2 text-sm font-medium text-[var(--warn)]">{c.enrollmentNote}</p>
          )}
          {anchorUnconfirmed && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-[var(--warn)]">
                This credit's anniversary anchor ({c.anchorMonth}/{c.anchorDay}) is the catalog
                default and hasn't been confirmed — if your card's anniversary differs, its
                period is wrong. Confirm it here, or correct it under Edit credit.
              </p>
              <button
                type="button"
                aria-label={`Confirm the anniversary anchor for ${c.name}`}
                disabled={confirmAnchor.isPending}
                onClick={() => confirmAnchor.mutate()}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Confirm anchor
              </button>
            </div>
          )}

          {c.currentPostings.length > 0 ? (
            <ul className="mb-3 space-y-1">
              {c.currentPostings.map((p) => (
                <li key={p.id} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">
                    <span className={`${MONO} text-[var(--dim)]`}>{p.date}</span> {p.name}
                    {p.postedDate !== p.date && (
                      <span className="text-[var(--dim)]"> · posted {p.postedDate}</span>
                    )}
                  </span>
                  <span className={MONO}>{money(p.amount, c.currency)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-sm text-[var(--dim)]">No credit posted yet {periodWord(c.period)}.</p>
          )}

          <ManualEntryForm credit={c} onChanged={onChanged} />

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              aria-label={`Mark ${c.name} as ${c.enrolled ? "not enrolled" : "enrolled"}`}
              onClick={() => toggleEnrolled.mutate(c.enrolled !== true)}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
            >
              {c.enrolled === true ? "Enrolled ✓" : "Mark enrolled"}
            </button>
            {c.enrolled === null && (
              <button
                type="button"
                aria-label={`Mark ${c.name} as not enrolled`}
                onClick={() => toggleEnrolled.mutate(false)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
              >
                Mark not enrolled
              </button>
            )}
            <button
              type="button"
              aria-label={`${editing ? "Close" : "Edit"} settings for ${c.name}`}
              onClick={() => setEditing((v) => !v)}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
            >
              {editing ? "Close settings" : "Edit credit"}
            </button>
            <button
              type="button"
              aria-label={`Stop tracking ${c.name}`}
              onClick={() => toggleActive.mutate(false)}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--bad)]"
            >
              Stop tracking
            </button>
          </div>

          {editing && <EditCreditForm credit={c} siblings={allCredits} onChanged={onChanged} onClose={() => setEditing(false)} />}
        </div>
      )}
    </li>
  );
}

function GroupRow({
  group: g,
  allCredits,
  onChanged,
}: {
  group: CreditGroup<Credit>;
  allCredits: Credit[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pct = g.amount > 0 ? Math.min(100, (g.used / g.amount) * 100) : 0;
  const done = g.remaining <= 0;
  const color = urgencyColor(g.daysLeft, g.remaining);

  return (
    <li className="px-4 py-3">
      <button
        type="button"
        aria-label={`${g.name} combined across ${g.members.length} cards — details`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="block w-full text-left"
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-medium leading-snug">
              <PrefixChip label={[...new Set(g.members.map((m) => prefixFor(m)))].join("/")} />
              {g.name}
              {g.owners.map((o) => (
                <OwnerBadge key={o} owner={o} />
              ))}
              <span className="ml-2 rounded bg-[var(--bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--dim)]">
                {g.members.length} cards
              </span>
              {g.notEnrolled > 0 && (
                <span className="ml-2 rounded bg-[var(--bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--warn)]">
                  not enrolled on {g.notEnrolled}
                </span>
              )}
              {g.enrollmentUnconfirmed > 0 && (
                <span className="ml-2 rounded bg-[var(--bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--warn)]">
                  enrollment unconfirmed on {g.enrollmentUnconfirmed}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-sm text-[var(--dim)]">
              {g.periodLabel} · ends {g.periodEnd}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className={`${MONO} text-xl font-semibold`} style={{ color }}>
              {done ? money(0, g.members[0]!.currency) : money(g.remaining, g.members[0]!.currency)}
            </div>
            <div className="text-xs text-[var(--dim)]">
              {done ? `used up ✓ · renews ${fmtDay(g.members[0]!.nextPeriodStart)}` : `${g.daysLeft}d left ${periodWord(g.period)}`}
            </div>
          </div>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg)]" role="img" aria-label={`${money(g.used, g.members[0]!.currency)} of ${money(g.amount, g.members[0]!.currency)} used across ${g.members.length} cards`}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
        <div className={`${MONO} mt-1 text-xs text-[var(--dim)]`}>
          {money(g.used, g.members[0]!.currency)} of {money(g.amount, g.members[0]!.currency)} posted
        </div>
      </button>

      {open && (
        <div className="mt-3 border-t border-[var(--border)]">
          <ul className="divide-y divide-[var(--border)]">
            {g.members.map((c) => (
              <CreditRow key={c.id} credit={c} allCredits={allCredits} onChanged={onChanged} nested />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function ManualEntryForm({ credit: c, onChanged }: { credit: Credit; onChanged: () => void }) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(c.periodStart);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.addManualPosting({
        creditId: c.id,
        date,
        amount: Number(amount),
        note: note.trim(),
      }),
    onSuccess: () => {
      setAmount("");
      setNote("");
      setMsg("Added — it counts toward this period's posted total.");
      onChanged();
    },
    onError: (e) => setMsg(String(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = Number(amount);
    if (amount.trim() === "" || Number.isNaN(value) || value === 0) {
      setMsg("Enter an amount: positive for credit received, negative for a clawback. $0 doesn't count.");
      return;
    }
    add.mutate();
  };
  return (
    <form onSubmit={submit} className="rounded-lg bg-[var(--bg)] px-3 py-3" aria-label={`Record manual credit use for ${c.name}`}>
      <div className="mb-2 text-sm font-medium">Used some of this off-statement? Record it</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Amount $ (negative = clawback)</span>
          <input
            aria-label="Manual credit amount in dollars"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="50 or -50"
            className={`${MONO} w-24 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Date</span>
          <input
            aria-label="Manual credit date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm"
          />
        </label>
        <label className="block min-w-32 flex-1">
          <span className="mb-1 block text-xs text-[var(--dim)]">Note (optional)</span>
          <input
            aria-label="Manual credit note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Used at Dell.com"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          aria-label={`Add manual entry to ${c.name}`}
          disabled={add.isPending}
          className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {msg && <p className="mt-2 text-sm text-[var(--dim)]">{msg}</p>}
    </form>
  );
}

function EditCreditForm({
  credit: c,
  siblings,
  onChanged,
  onClose,
}: {
  credit: Credit;
  siblings: Credit[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(c.name);
  const [amount, setAmount] = useState(String(c.amount));
  const [period, setPeriod] = useState<Period>(c.period);
  const [anchorMonth, setAnchorMonth] = useState(c.anchorMonth != null ? String(c.anchorMonth) : "");
  const [anchorDay, setAnchorDay] = useState(c.anchorDay != null ? String(c.anchorDay) : "");
  const [pattern, setPattern] = useState(c.matchPattern);
  const [note, setNote] = useState(c.note);
  const [msg, setMsg] = useState<string | null>(null);
  const anchored = period === "annual" || period === "semiannual";
  const save = useMutation({
    mutationFn: () =>
      api.updateCredit({
        id: c.id,
        name: name.trim(),
        amount: Number(amount),
        period,
        // The anchor is a pair: both fields, or neither (cleared). The
        // submit handler rejects a half-filled pair before we get here.
        anchorMonth: anchored && anchorMonth !== "" ? Number(anchorMonth) : null,
        anchorDay: anchored && anchorDay !== "" ? Number(anchorDay) : null,
        matchPattern: pattern.trim().toLowerCase(),
        note: note.trim(),
      }),
    onSuccess: () => {
      onChanged();
      onClose();
    },
    onError: (e) => setMsg(String(e)),
  });
  const del = useMutation({
    mutationFn: () => api.deleteCredit({ id: c.id }),
    onSuccess: onChanged,
    onError: (e) => setMsg(String(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === "" || !(Number(amount) >= 0)) {
      setMsg("Name is required and amount must be $0 or more.");
      return;
    }
    if (anchored && (anchorMonth === "") !== (anchorDay === "")) {
      setMsg("Anchor month and day are a pair — fill in both, or clear both (blank = calendar cycle).");
      return;
    }
    save.mutate();
  };
  void siblings;
  return (
    <form onSubmit={submit} className="mt-3 rounded-lg border border-[var(--border)] px-3 py-3" aria-label={`Settings for ${c.name}`}>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Credit name</span>
          <input aria-label="Credit name" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Amount per period $</span>
          <input aria-label="Credit amount per period" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${MONO} w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Period</span>
          <select aria-label="Credit period" value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm">
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="semiannual">Semiannual (6-month halves)</option>
            <option value="annual">Annual</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Plaid posting match (substring)</span>
          <input aria-label="Plaid posting match substring" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. lululemon" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm" />
        </label>
        {anchored && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--dim)]">Anniversary anchor month (blank = calendar cycle)</span>
              <input aria-label="Anniversary anchor month" inputMode="numeric" value={anchorMonth} onChange={(e) => setAnchorMonth(e.target.value)} placeholder="e.g. 5 for May" className={`${MONO} w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--dim)]">Anniversary anchor day (set both, or neither)</span>
              <input aria-label="Anniversary anchor day" inputMode="numeric" value={anchorDay} onChange={(e) => setAnchorDay(e.target.value)} placeholder="e.g. 1" className={`${MONO} w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm`} />
            </label>
          </>
        )}
      </div>
      <label className="mt-2 block">
        <span className="mb-1 block text-xs text-[var(--dim)]">Note</span>
        <input aria-label="Credit note" value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm" />
      </label>
      {msg && <p className="mt-2 text-sm text-[var(--bad)]">{msg}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" aria-label="Save credit settings" disabled={save.isPending} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          Save
        </button>
        <button
          type="button"
          aria-label={`Delete ${c.name} permanently`}
          disabled={del.isPending}
          onClick={() => del.mutate()}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--bad)]"
        >
          Delete credit
        </button>
      </div>
    </form>
  );
}

function UnassignedSection({ data, onChanged }: { data: Dashboard; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const assign = useMutation({
    mutationFn: (v: { postingId: number; creditId: number }) => api.assignPosting(v),
    onSuccess: onChanged,
  });
  if (data.unassigned.length === 0) return null;
  return (
    <section aria-label="Unassigned credit postings" className="mt-5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        aria-label="Toggle unassigned postings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-base font-medium">Unassigned postings ({data.unassignedCount})</span>
        <span className="text-sm text-[var(--dim)]">{open ? "Hide" : "Review"}</span>
      </button>
      {open && (
        <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {data.unassigned.map((p) => {
            // Only stored credits are assignable targets: a synthesized
            // (negative-id) entry has no row a posting can point at —
            // it materializes only when the user acts on the credit
            // itself, never from this dropdown.
            const options = data.credits.filter((c) => c.accountId === p.accountId && c.id > 0);
            return (
              <li key={p.id} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm">
                    <span className={`${MONO} text-[var(--dim)]`}>{p.date}</span> {p.name}
                    {p.postedDate !== p.date && (
                      <span className="text-[var(--dim)]"> · posted {p.postedDate}</span>
                    )}
                  </span>
                  <span className={MONO}>{money(p.amount, p.currency)}</span>
                </div>
                <div className="mt-1 text-xs text-[var(--dim)]">
                  {cardLabel(p.owner, p.accountName, p.mask, p.fifthDigit)}
                  <OwnerBadge owner={p.owner} />
                </div>
                {options.length > 0 ? (
                  <label className="mt-2 block">
                    <span className="sr-only">Assign posting {p.name} to a credit</span>
                    <select
                      aria-label={`Assign posting ${p.name} ${p.date} to a credit`}
                      defaultValue=""
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (v > 0) assign.mutate({ postingId: p.id, creditId: v });
                      }}
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm"
                    >
                      <option value="">Assign to a credit…</option>
                      {options.map((c) => (
                        <option key={c.id} value={c.id}>
                          {prefixFor(c)} · {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="mt-1 text-sm text-[var(--dim)]">No credits tracked on this card yet — add one under Cards below.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function LoginLabelsForm({
  labels,
  onChanged,
}: {
  labels: [string, string];
  onChanged: () => void;
}) {
  const [aLabel, setALabel] = useState(labels[0]);
  const [bLabel, setBLabel] = useState(labels[1]);
  const [msg, setMsg] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.setOwnerLabels({ aLabel: aLabel.trim(), bLabel: bLabel.trim() }),
    onSuccess: () => {
      setMsg("Saved.");
      onChanged();
    },
    onError: (e) => setMsg(String(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (aLabel.trim() === "" || bLabel.trim() === "") {
      setMsg("Both login labels are required.");
      return;
    }
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="border-b border-[var(--border)] px-4 py-3" aria-label="Login labels">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
        Login labels
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">First login</span>
          <input
            aria-label="Label for the first login"
            value={aLabel}
            onChange={(e) => setALabel(e.target.value)}
            className="w-36 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Second login</span>
          <input
            aria-label="Label for the second login"
            value={bLabel}
            onChange={(e) => setBLabel(e.target.value)}
            className="w-36 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          aria-label="Save login labels"
          disabled={save.isPending}
          className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Save labels
        </button>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">
        Labels shown on each card for the two logins (for example, two people in a household).
      </p>
      {msg && <p className="mt-2 text-sm text-[var(--dim)]">{msg}</p>}
    </form>
  );
}

// Display settings: which credit families this dashboard hides. The
// toggle list and the current hidden/shown state come from the
// getPreferences action (the effective preference — the stored list, or
// the built-in defaults when nothing was ever saved); flipping a toggle
// writes the complete new list back through setExcludedCredits, the same
// stored preference (meta `excludedCredits`) the assistant edits from
// chat. There is no separate storage: once the user saves a selection
// here it is authoritative, including "nothing hidden".
function DisplaySettingsSection({ onChanged }: { onChanged: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: () => api.getPreferences({}) });
  const save = useMutation({
    mutationFn: (excludedCredits: string[]) => api.setExcludedCredits({ excludedCredits }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["preferences"] });
      onChanged();
    },
    onError: (e) => setError(String(e)),
  });

  const families = prefs.data?.hideableFamilies ?? [];
  const hiddenCount = families.filter((f) => f.hidden).length;

  const toggle = (family: { pattern: string; label: string; hidden: boolean }) => {
    if (!prefs.data || save.isPending) return;
    const current = prefs.data.excludedCredits;
    // An entry hides this family when the family's credit name contains
    // it (the server's substring rule), so both the short pattern
    // ("chatgpt") and a full credit name stored from chat count.
    const hidesFamily = (entry: string) =>
      family.label.toLowerCase().includes(entry.toLowerCase());
    const next = family.hidden
      ? current.filter((e) => !hidesFamily(e))
      : current.some(hidesFamily)
        ? current
        : [...current, family.pattern];
    if (next !== current) save.mutate(next);
  };

  return (
    <section aria-label="Display settings" className="mt-5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        aria-label="Toggle display settings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-base font-medium">
          Display settings{prefs.data && hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
        </span>
        <span className="text-sm text-[var(--dim)]">{open ? "Hide" : "Manage"}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <p className="text-sm text-[var(--dim)]">
            Choose which credit families appear here. Hidden credits never count in any total; they
            are still listed under “Hidden by preference” in the Agent Markdown. Your selection is
            saved as your own preference — the built-in defaults only apply until you change
            something here (or ask your assistant in chat, which edits the same preference).
          </p>
          {prefs.isPending && <p className="mt-3 text-sm text-[var(--dim)]">Loading…</p>}
          {prefs.error && (
            <p role="alert" className="mt-3 text-sm text-[var(--bad)]">
              Couldn't load display settings: {String(prefs.error)}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-[var(--bad)]">
              Couldn't save display settings: {error}
            </p>
          )}
          {prefs.data && (
            <ul className="mt-1 divide-y divide-[var(--border)]">
              {families.map((f) => (
                <li key={f.pattern} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="text-sm">{f.label}</span>
                  <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm">
                    <span className="text-[var(--dim)]">{f.hidden ? "Hidden" : "Shown"}</span>
                    <input
                      type="checkbox"
                      aria-label={`Show ${f.label}`}
                      checked={!f.hidden}
                      disabled={save.isPending}
                      onChange={() => toggle(f)}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
          {prefs.data && <TimezoneControl current={prefs.data.timezone} onChanged={onChanged} />}
        </div>
      )}
    </section>
  );
}

/**
 * Per-account display prefix (nickname): the short label credit rows
 * carry (UA, UABus, …). User-owned — Plaid re-imports never overwrite
 * it; it is stored on the account via updateAccount.
 */
function NicknameForm({
  accountId,
  accountLabel,
  nickname,
  onChanged,
}: {
  accountId: number;
  accountLabel: string;
  nickname: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(nickname);
  const [msg, setMsg] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.updateAccount({ accountId, nickname: value.trim() }),
    onSuccess: () => {
      setOpen(false);
      onChanged();
    },
    onError: (e) => setMsg(String(e)),
  });
  if (!open) {
    return (
      <button
        type="button"
        aria-label={`${nickname ? "Change" : "Set"} display prefix for ${accountLabel}`}
        onClick={() => setOpen(true)}
        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
      >
        {nickname ? "Change prefix" : "Set prefix"}
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="flex flex-wrap items-center gap-2"
      aria-label={`Display prefix for ${accountLabel}`}
    >
      <input
        aria-label={`Display prefix for ${accountLabel}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. UA"
        maxLength={24}
        className="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
      />
      <button
        type="submit"
        aria-label="Save display prefix"
        disabled={save.isPending}
        className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        Save prefix
      </button>
      <button
        type="button"
        aria-label="Cancel editing display prefix"
        onClick={() => setOpen(false)}
        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
      >
        Cancel
      </button>
      {msg && <span className="text-sm text-[var(--bad)]">{msg}</span>}
    </form>
  );
}

/**
 * Fifth-digit recorder for same-ending cards: two cards of one product
 * can share the last four digits; the digit just before them — visible
 * in the issuer's app as part of the five-digit ending — tells them
 * apart. User-owned like the nickname: stored on the account via
 * updateAccount, and imports never overwrite it.
 */
function FifthDigitForm({
  accountId,
  accountLabel,
  fifthDigit,
  onChanged,
}: {
  accountId: number;
  accountLabel: string;
  fifthDigit: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(fifthDigit);
  const [msg, setMsg] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.updateAccount({ accountId, fifthDigit: value.trim() }),
    onSuccess: () => {
      setOpen(false);
      onChanged();
    },
    onError: (e) => setMsg(String(e)),
  });
  if (!open) {
    return (
      <button
        type="button"
        aria-label={`${fifthDigit ? "Change" : "Record"} fifth digit for ${accountLabel}`}
        onClick={() => setOpen(true)}
        className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
      >
        {fifthDigit ? "Change fifth digit" : "Record fifth digit"}
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = value.trim();
        if (v !== "" && !/^[0-9]$/.test(v)) {
          setMsg("Enter the single digit before the last four — or leave it empty to clear.");
          return;
        }
        save.mutate();
      }}
      className="flex flex-wrap items-center gap-2"
      aria-label={`Fifth digit for ${accountLabel}`}
    >
      <input
        aria-label={`Fifth digit for ${accountLabel}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. 4"
        inputMode="numeric"
        maxLength={1}
        className="w-16 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
      />
      <button
        type="submit"
        aria-label="Save fifth digit"
        disabled={save.isPending}
        className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        Save digit
      </button>
      <button
        type="button"
        aria-label="Cancel editing fifth digit"
        onClick={() => setOpen(false)}
        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
      >
        Cancel
      </button>
      {msg && <span className="text-sm text-[var(--bad)]">{msg}</span>}
    </form>
  );
}

const TIMEZONE_CHOICES = [
  "America/Los_Angeles",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/**
 * The timezone "today" and every period boundary are computed in.
 * Stored server-side (meta `timezone`); America/Los_Angeles until set.
 */
function TimezoneControl({ current, onChanged }: { current: string; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (timezone: string) => api.setTimezone({ timezone }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["preferences"] });
      onChanged();
    },
    onError: (e) => setError(String(e)),
  });
  const choices = TIMEZONE_CHOICES.includes(current)
    ? TIMEZONE_CHOICES
    : [current, ...TIMEZONE_CHOICES];
  return (
    <div className="mt-4 border-t border-[var(--border)] pt-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
        Timezone
      </div>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[var(--dim)]">“Today” and period boundaries use</span>
        <select
          aria-label="Dashboard timezone"
          value={current}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm"
        >
          {choices.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="mt-2 text-sm text-[var(--bad)]">
          Couldn't save the timezone: {error}
        </p>
      )}
    </div>
  );
}

function AccountsSection({ data, onChanged }: { data: Dashboard; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const setIgnored = useMutation({
    mutationFn: (v: { accountId: number; ignored: boolean }) => api.setAccountIgnored(v),
    onSuccess: onChanged,
  });
  const inactive = data.credits.filter((c) => !c.active);
  const reactivate = useMutation({
    mutationFn: (id: number) => api.updateCredit({ id, active: true }),
    onSuccess: onChanged,
  });
  // Same-ending peers (the server heuristic's grouping, here on owner
  // labels): another tracked account of the same owner with the same
  // product and the same effective ending. Those are the cards a user
  // cannot tell apart at a glance — each gets a disambiguation block
  // with its stored-transaction evidence and a fifth-digit input. A
  // different owner's same-ending card is never a peer: the owner
  // label already distinguishes it.
  const sameEndingPeers = (a: Dashboard["accounts"][number]) =>
    a.ignored || a.mask === ""
      ? []
      : data.accounts.filter(
          (x) =>
            x.id !== a.id &&
            !x.ignored &&
            (x.owner ?? null) === (a.owner ?? null) &&
            x.name.trim().toLowerCase() === a.name.trim().toLowerCase() &&
            endingOf(x.mask, x.fifthDigit) === endingOf(a.mask, a.fifthDigit),
        );
  // Cards grouped by issuer, then by login (master account) within each
  // issuer — "Alex's Amex login" and "Alex's Chase login" are separate
  // sections. The group labels come from the dashboard data (the
  // login-label settings), never from hardcoded names.
  const cardGroups: { label: string; accounts: Dashboard["accounts"] }[] = [];
  const issuers = [...new Set(data.accounts.map((a) => a.issuer))].sort(
    (x, y) => (x === "Amex" ? 0 : 1) - (y === "Amex" ? 0 : 1),
  );
  for (const issuer of issuers) {
    for (const lbl of data.ownerLabels) {
      const list = data.accounts.filter((a) => a.issuer === issuer && a.owner === lbl);
      if (list.length > 0) cardGroups.push({ label: `${lbl}'s ${issuer} login`, accounts: list });
    }
    const unidentified = data.accounts.filter(
      (a) => a.issuer === issuer && (a.owner == null || !data.ownerLabels.includes(a.owner as string)),
    );
    if (unidentified.length > 0) {
      cardGroups.push({ label: `${issuer} login not identified yet`, accounts: unidentified });
    }
  }
  return (
    <section aria-label="Cards" className="mt-5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        aria-label="Toggle cards list"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-base font-medium">Cards ({data.accounts.filter((a) => !a.ignored).length} tracked)</span>
        <span className="text-sm text-[var(--dim)]">{open ? "Hide" : "Manage"}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)]">
          <LoginLabelsForm key={data.ownerLabels.join("|")} labels={data.ownerLabels} onChanged={onChanged} />
          {cardGroups.map((grp) => (
            <div key={grp.label}>
              <div className="border-b border-[var(--border)] bg-[var(--bg)] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
                {grp.label} ({grp.accounts.filter((a) => !a.ignored).length} tracked)
              </div>
              <ul className="divide-y divide-[var(--border)]">
                {grp.accounts.map((a) => {
                  const peers = sameEndingPeers(a);
                  return (
              <li key={a.id} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {cardLabel(a.owner, a.name, a.mask, a.fifthDigit)}
                      <OwnerBadge owner={a.owner} />
                    </span>
                    <span className="text-xs text-[var(--dim)]">
                      {a.ignored
                        ? "Ignored — treated as a duplicate record of the same account"
                        : a.hasCatalog
                          ? "Credits tracked"
                          : "No statement credits in the catalog"}
                      {(a.nickname !== "" || a.defaultName !== "") &&
                        ` · shown as "${a.nickname !== "" ? a.nickname : a.defaultName}"`}
                    </span>
                  </span>
                  <span className={`${MONO} text-sm text-[var(--dim)]`}>
                    {a.balance != null ? money(a.balance, a.currency ?? "USD") : ""}
                  </span>
                </div>
                {a.suspectedDuplicate && (
                  <p className="mt-1 text-sm font-medium text-[var(--warn)]">
                    Possible duplicate of{" "}
                    {a.duplicateSuspectIds
                      .map((id) => data.accounts.find((x) => x.id === id))
                      .filter((x): x is NonNullable<typeof x> => x != null)
                      .map((x) => cardLabel(x.owner, x.name, x.mask, x.fifthDigit))
                      .join("; ")}
                    {" "}— both records are counted in every total until you mark one as a
                    duplicate below. If they are genuinely separate cards, no action is needed.
                    {peers.length > 0 &&
                      " If they are separate cards that share an ending, record each card's fifth digit below — cards whose five-digit endings differ stop being flagged."}
                  </p>
                )}
                {peers.length > 0 && (
                  <div className="mt-2 rounded-lg bg-[var(--bg)] px-3 py-3">
                    <p className="text-sm font-medium text-[var(--warn)]">
                      Same ending as{" "}
                      {peers.map((x) => cardLabel(x.owner, x.name, x.mask, x.fifthDigit)).join("; ")}
                    </p>
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      Cards of one product can share the last four digits. The digit just before
                      them tells them apart — your issuer's app shows the five-digit ending (in
                      the Amex app, it is the ending shown on the card). Record this card's fifth
                      digit and cards whose endings differ stop being flagged as possible
                      duplicates.
                    </p>
                    {a.disambiguation &&
                      (a.disambiguation.annualFeePosting != null ||
                        a.disambiguation.recentPostings.length > 0) && (
                        <div className="mt-2 text-sm text-[var(--dim)]">
                          <p>What this record shows, to help you recognize the physical card:</p>
                          <ul className="mt-1 space-y-0.5">
                            {a.disambiguation.annualFeePosting && (
                              <li>
                                Annual fee ·{" "}
                                <span className={MONO}>{fmtDay(a.disambiguation.annualFeePosting.date)}</span>{" "}
                                {a.disambiguation.annualFeePosting.name} ·{" "}
                                {money(a.disambiguation.annualFeePosting.amount, a.currency ?? "USD")}
                              </li>
                            )}
                            {a.disambiguation.recentPostings.map((p, i) => (
                              <li key={i}>
                                <span className={MONO}>{fmtDay(p.date)}</span> {p.name} ·{" "}
                                {money(p.amount, a.currency ?? "USD")}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    <div className="mt-2">
                      <FifthDigitForm
                        key={`${a.id}:${a.fifthDigit}`}
                        accountId={a.id}
                        accountLabel={cardLabel(a.owner, a.name, a.mask, a.fifthDigit)}
                        fifthDigit={a.fifthDigit}
                        onChanged={onChanged}
                      />
                    </div>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-label={`${a.ignored ? "Un-ignore" : "Ignore"} card ${cardLabel(a.owner, a.name, a.mask, a.fifthDigit)}`}
                    onClick={() => setIgnored.mutate({ accountId: a.id, ignored: !a.ignored })}
                    className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
                  >
                    {a.ignored ? "Un-ignore" : "Ignore as duplicate"}
                  </button>
                  {!a.ignored && <AddCreditForm accountId={a.id} accountLabel={cardLabel(a.owner, a.name, a.mask, a.fifthDigit)} onChanged={onChanged} />}
                  {!a.ignored && (
                    <NicknameForm
                      key={`${a.id}:${a.nickname}`}
                      accountId={a.id}
                      accountLabel={cardLabel(a.owner, a.name, a.mask, a.fifthDigit)}
                      nickname={a.nickname}
                      onChanged={onChanged}
                    />
                  )}
                </div>
              </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {inactive.length > 0 && (
            <div className="border-t border-[var(--border)] px-4 py-3">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--dim)]">Stopped tracking</div>
              <ul className="space-y-2">
                {inactive.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                    <span>
                      <PrefixChip label={prefixFor(c)} />
                      {c.name} <span className="text-[var(--dim)]">· {cardLabel(c.owner, c.accountName, c.mask, c.fifthDigit)}</span>
                      <OwnerBadge owner={c.owner} />
                    </span>
                    <button
                      type="button"
                      aria-label={`Resume tracking ${c.name}`}
                      onClick={() => reactivate.mutate(c.id)}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
                    >
                      Resume
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AddCreditForm({
  accountId,
  accountLabel,
  onChanged,
}: {
  accountId: number;
  accountLabel: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState<Period>("quarterly");
  const [pattern, setPattern] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.addCredit({
        accountId,
        name: name.trim(),
        amount: Number(amount),
        period,
        note: "",
        matchPattern: pattern.trim().toLowerCase(),
      }),
    onSuccess: () => {
      setOpen(false);
      setName("");
      setAmount("");
      setPattern("");
      onChanged();
    },
    onError: (e) => setMsg(String(e)),
  });
  if (!open) {
    return (
      <button
        type="button"
        aria-label={`Add a credit to ${accountLabel}`}
        onClick={() => setOpen(true)}
        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
      >
        Add credit
      </button>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === "" || !(Number(amount) > 0)) {
      setMsg("Name and an amount above $0 are required.");
      return;
    }
    add.mutate();
  };
  return (
    <form onSubmit={submit} className="mt-1 w-full rounded-lg bg-[var(--bg)] px-3 py-3" aria-label={`Add a credit to ${accountLabel}`}>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Credit name</span>
          <input aria-label="New credit name" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Amount per period $</span>
          <input aria-label="New credit amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${MONO} w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Period</span>
          <select aria-label="New credit period" value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm">
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="semiannual">Semiannual</option>
            <option value="annual">Annual</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">Plaid posting match (optional)</span>
          <input aria-label="New credit Plaid match substring" value={pattern} onChange={(e) => setPattern(e.target.value)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm" />
        </label>
      </div>
      {msg && <p className="mt-2 text-sm text-[var(--bad)]">{msg}</p>}
      <div className="mt-3 flex gap-2">
        <button type="submit" aria-label="Save new credit" disabled={add.isPending} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          Save credit
        </button>
        <button type="button" aria-label="Cancel adding a credit" onClick={() => setOpen(false)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
