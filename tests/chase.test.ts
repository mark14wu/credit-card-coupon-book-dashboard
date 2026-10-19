import { describe, expect, test } from "bun:test";
import { addDays, Actions, periodBounds } from "../server/src/actions";
import * as schema from "../server/src/schema";
import { createTestDb, fakeCtx, todayLA } from "./helpers";
import {
  ALEX_HYATT_BIZ,
  ALEX_IHG_PREMIER,
  ALEX_RITZ,
  ALEX_SAPPHIRE,
} from "./fixtures/sample";

// End-to-end coverage for the Chase side of the catalog: fictional Chase
// accounts import, get issuer "Chase", seed their catalog credits —
// including the anniversary-anchored annual cycles — and pick up usage
// from real-shaped Chase posting names. All ids/masks/amounts invented.

const MAY_1 = { month: 5, day: 1 };

async function importChase(db: ReturnType<typeof createTestDb>) {
  const today = todayLA();
  const anniversary = periodBounds("annual", today, MAY_1);
  const calendarYear = periodBounds("annual", today);
  return Actions.importSnapshot.handler(fakeCtx(db), {
    complete: true,
    windowStart: calendarYear.start,
    windowEnd: today,
    accounts: [ALEX_SAPPHIRE, ALEX_HYATT_BIZ, ALEX_IHG_PREMIER, ALEX_RITZ],
    postings: [
      {
        txnId: "fake-txn-chase-hotel",
        accountPlaidId: ALEX_SAPPHIRE.plaidAccountId,
        date: anniversary.start,
        name: "ANNUAL HOTEL CREDIT",
        amount: 50,
      },
      {
        txnId: "fake-txn-chase-hyatt-1",
        accountPlaidId: ALEX_HYATT_BIZ.plaidAccountId,
        date: anniversary.start,
        name: "CREDIT ADJUSTMENT",
        amount: 50,
      },
      {
        txnId: "fake-txn-chase-hyatt-2",
        accountPlaidId: ALEX_HYATT_BIZ.plaidAccountId,
        date: addDays(anniversary.start, 30),
        name: "CREDIT ADJUSTMENT",
        amount: 50,
      },
      {
        txnId: "fake-txn-chase-ritz",
        accountPlaidId: ALEX_RITZ.plaidAccountId,
        date: calendarYear.start,
        name: "TRAVEL CREDIT",
        amount: 120,
      },
    ],
  } as any);
}

describe("Chase import — issuer, catalog seeding, anchored periods", () => {
  test("Chase accounts are stored with issuer Chase and seed their catalog credits", async () => {
    const db = createTestDb();
    await importChase(db);

    const accounts = await db.select().from(schema.accounts);
    expect(accounts).toHaveLength(4);
    expect(accounts.every((a) => a.issuer === "Chase")).toBe(true);

    const credits = await db.select().from(schema.credits);
    const byName = new Map(credits.map((c) => [c.name, c]));
    expect(byName.get("Annual Hotel Credit")).toEqual(
      expect.objectContaining({ amount: 100, period: "annual", anchorMonth: 5, anchorDay: 1 }),
    );
    expect(byName.get("Hyatt Credit")).toEqual(
      expect.objectContaining({ amount: 100, period: "annual", anchorMonth: 5, anchorDay: 1 }),
    );
    expect(byName.get("Airline Credit")).toEqual(
      expect.objectContaining({ amount: 100, period: "annual", anchorMonth: null }),
    );
    // No TravelBank row: that IHG benefit is a deposit to the holder's
    // United TravelBank account, not a statement credit, so it is not seeded.
    expect(byName.has("United TravelBank Credit")).toBe(false);
    expect(byName.get("Travel Credit")).toEqual(
      expect.objectContaining({ amount: 300, period: "annual" }),
    );
  });

  test("dashboard runs Sapphire/Hyatt on the anniversary year and auto-maps Chase posting names", async () => {
    const db = createTestDb();
    await importChase(db);
    const dash: any = await Actions.getDashboard.handler(fakeCtx(db), {});
    const today = todayLA();
    const anniversary = periodBounds("annual", today, MAY_1);

    const sapphire = dash.accounts.find((a: any) => a.mask === "6666");
    expect(sapphire.issuer).toBe("Chase");

    const hotel = dash.credits.find((c: any) => c.name === "Annual Hotel Credit");
    expect(hotel.periodStart).toBe(anniversary.start);
    expect(hotel.periodEnd).toBe(anniversary.end);
    expect(hotel.periodLabel).toBe(anniversary.label);
    expect(hotel.anchorMonth).toBe(5);
    expect(hotel.anchorDay).toBe(1);
    // The $50 posting is the pre-refresh credit the holder already used;
    // under the $100 cap (2026 refresh) the other $50 remains this year.
    expect(hotel.currentUsed).toBe(50);
    expect(hotel.currentRemaining).toBe(50);
    // The next period start is surfaced for the renews display.
    expect(hotel.nextPeriodStart).toBe(addDays(anniversary.end, 1));

    // Both $50 "CREDIT ADJUSTMENT" postings landed on the Hyatt credit.
    const hyatt = dash.credits.find((c: any) => c.name === "Hyatt Credit");
    expect(hyatt.periodStart).toBe(anniversary.start);
    expect(hyatt.currentUsed).toBe(100);
    expect(hyatt.currentRemaining).toBe(0);
    expect(hyatt.currentPostings).toHaveLength(2);

    // Ritz runs on the calendar year.
    const ritz = dash.credits.find((c: any) => c.name === "Travel Credit");
    expect(ritz.periodStart).toBe(periodBounds("annual", today).start);
    expect(ritz.currentUsed).toBe(120);
    expect(ritz.currentRemaining).toBe(180);

    // Nothing leaked into Unassigned.
    expect(dash.unassigned).toHaveLength(0);
  });
});

describe("Chase import — seeded anchor confirmation state", () => {
  test("the Sapphire catalog anchor (May 1) seeds unconfirmed and surfaces in the dashboard payload", async () => {
    const db = createTestDb();
    await importChase(db);
    const stored = (await db.select().from(schema.credits)).find(
      (c) => c.name === "Annual Hotel Credit",
    )!;
    expect(stored.anchorMonth).toBe(5);
    expect(stored.anchorConfirmed).toBe(0);

    const dash: any = await Actions.getDashboard.handler(fakeCtx(db), {});
    const hotel = dash.credits.find((c: any) => c.name === "Annual Hotel Credit");
    expect(hotel.anchorConfirmed).toBe(false);
    // The Ritz travel credit has no anchor: nothing to confirm.
    const ritz = dash.credits.find((c: any) => c.name === "Travel Credit");
    expect(ritz.anchorConfirmed).toBe(true);

    // Confirming via updateCredit flips the stored flag.
    await Actions.updateCredit.handler(fakeCtx(db), {
      id: stored.id,
      anchorConfirmed: true,
    });
    const after = (await db.select().from(schema.credits)).find(
      (c) => c.id === stored.id,
    )!;
    expect(after.anchorConfirmed).toBe(1);
  });
});

describe("Chase accounts — catalog default display names", () => {
  test("dashboard and markdown label Chase credits with the catalog defaults, no nickname needed", async () => {
    const db = createTestDb();
    await importChase(db);

    const dash: any = await Actions.getDashboard.handler(fakeCtx(db), {});
    const byMask = new Map(dash.credits.map((c: any) => [c.mask, c]));
    expect(byMask.get("6666").accountDefaultName).toBe("CSP");
    expect(byMask.get("7777").accountDefaultName).toBe("HyattBus");
    expect(byMask.get("8888").accountDefaultName).toBe("IHG-Premier");
    expect(byMask.get("9999").accountDefaultName).toBe("Ritz");
    const acctByMask = new Map(dash.accounts.map((a: any) => [a.mask, a]));
    expect(acctByMask.get("6666").defaultName).toBe("CSP");

    const md: string = ((await Actions.getAgentMarkdown.handler(fakeCtx(db), {})) as any).markdown;
    expect(md).toContain("· CSP");
    expect(md).toContain("· HyattBus");
    expect(md).toContain("· IHG-Premier");
    expect(md).toContain("### Travel Credit — Login 1 9999 · Ritz");
    expect(md).toContain('shown as "CSP"');
  });

  test("a user-set nickname still wins over the catalog default", async () => {
    const db = createTestDb();
    await importChase(db);
    const dash: any = await Actions.getDashboard.handler(fakeCtx(db), {});
    const ritz = dash.accounts.find((a: any) => a.mask === "9999");
    await Actions.updateAccount.handler(fakeCtx(db), {
      accountId: ritz.id,
      nickname: "RitzCustom",
    });
    const md: string = ((await Actions.getAgentMarkdown.handler(fakeCtx(db), {})) as any).markdown;
    expect(md).toContain("### Travel Credit — Login 1 9999 · RitzCustom");
    expect(md).toContain('shown as "RitzCustom"');
  });
});
