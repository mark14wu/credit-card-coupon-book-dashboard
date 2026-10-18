import { describe, expect, test } from "bun:test";
import { addDays, dateInTimeZone, daysBetween, isValidCalendarDate, laDateOf, periodBounds } from "../server/src/actions";

describe("periodBounds — monthly", () => {
  test("mid-month date gives the calendar month", () => {
    expect(periodBounds("monthly", "2026-03-15")).toEqual({
      start: "2026-03-01",
      end: "2026-03-31",
      key: "2026-03",
      label: "March 2026",
    });
  });

  test("February in a non-leap year ends on the 28th", () => {
    const b = periodBounds("monthly", "2026-02-10");
    expect(b.start).toBe("2026-02-01");
    expect(b.end).toBe("2026-02-28");
    expect(b.label).toBe("February 2026");
  });

  test("February in a leap year ends on the 29th", () => {
    expect(periodBounds("monthly", "2024-02-03").end).toBe("2024-02-29");
  });

  test("December ends on the 31st", () => {
    expect(periodBounds("monthly", "2026-12-25").end).toBe("2026-12-31");
  });
});

describe("periodBounds — quarterly", () => {
  test("Q1 runs Jan 1 to Mar 31", () => {
    expect(periodBounds("quarterly", "2026-01-15")).toEqual({
      start: "2026-01-01",
      end: "2026-03-31",
      key: "2026-Q1",
      label: "Q1 2026",
    });
  });

  test("Q2 runs Apr 1 to Jun 30", () => {
    const b = periodBounds("quarterly", "2026-05-20");
    expect(b.start).toBe("2026-04-01");
    expect(b.end).toBe("2026-06-30");
    expect(b.key).toBe("2026-Q2");
    expect(b.label).toBe("Q2 2026");
  });

  test("first and last day of Q3 land in the same window", () => {
    expect(periodBounds("quarterly", "2026-07-01").key).toBe("2026-Q3");
    const b = periodBounds("quarterly", "2026-09-30");
    expect(b.start).toBe("2026-07-01");
    expect(b.end).toBe("2026-09-30");
  });

  test("Q4 ends Dec 31", () => {
    const b = periodBounds("quarterly", "2026-11-30");
    expect(b.start).toBe("2026-10-01");
    expect(b.end).toBe("2026-12-31");
    expect(b.key).toBe("2026-Q4");
  });
});

describe("periodBounds — semiannual", () => {
  test("first half runs Jan 1 to Jun 30", () => {
    expect(periodBounds("semiannual", "2026-03-01")).toEqual({
      start: "2026-01-01",
      end: "2026-06-30",
      key: "2026-H1",
      label: "Jan–Jun 2026",
    });
  });

  test("second half runs Jul 1 to Dec 31", () => {
    expect(periodBounds("semiannual", "2026-09-15")).toEqual({
      start: "2026-07-01",
      end: "2026-12-31",
      key: "2026-H2",
      label: "Jul–Dec 2026",
    });
  });

  test("Jun 30 and Jul 1 fall in different halves", () => {
    expect(periodBounds("semiannual", "2026-06-30").key).toBe("2026-H1");
    expect(periodBounds("semiannual", "2026-07-01").key).toBe("2026-H2");
  });
});

describe("periodBounds — annual", () => {
  test("without an anchor, annual is the calendar year", () => {
    expect(periodBounds("annual", "2026-08-19")).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
      key: "2026",
      label: "2026",
    });
  });

  test("a null anchor behaves like no anchor", () => {
    expect(periodBounds("annual", "2026-08-19", null).key).toBe("2026");
  });
});

describe("periodBounds — anniversary-anchored annual", () => {
  const MAY_1 = { month: 5, day: 1 };

  test("a date after the anchor runs anchor-to-anchor into the next year", () => {
    expect(periodBounds("annual", "2026-10-15", MAY_1)).toEqual({
      start: "2026-05-01",
      end: "2027-04-30",
      key: "2026-A0501",
      label: "May 2026 – April 2027",
    });
  });

  test("a date before the anchor belongs to the cycle that started last year", () => {
    expect(periodBounds("annual", "2026-03-10", MAY_1)).toEqual({
      start: "2025-05-01",
      end: "2026-04-30",
      key: "2025-A0501",
      label: "May 2025 – April 2026",
    });
  });

  test("the anchor day itself starts the new cycle; the day before ends the old one", () => {
    expect(periodBounds("annual", "2026-05-01", MAY_1).start).toBe("2026-05-01");
    const before = periodBounds("annual", "2026-04-30", MAY_1);
    expect(before.start).toBe("2025-05-01");
    expect(before.end).toBe("2026-04-30");
  });

  test("the last day of the cycle is inside the same window as the first", () => {
    expect(periodBounds("annual", "2027-04-30", MAY_1).key).toBe("2026-A0501");
  });

  test("a mid-month anchor works too", () => {
    const b = periodBounds("annual", "2026-08-19", { month: 8, day: 15 });
    expect(b.start).toBe("2026-08-15");
    expect(b.end).toBe("2027-08-14");
    expect(periodBounds("annual", "2026-08-14", { month: 8, day: 15 }).start).toBe("2025-08-15");
  });

  test("the anchor is ignored for non-annual periods", () => {
    expect(periodBounds("quarterly", "2026-05-20", MAY_1).key).toBe("2026-Q2");
    expect(periodBounds("monthly", "2026-05-20", MAY_1).key).toBe("2026-05");
  });
});

describe("daysBetween / addDays", () => {
  test("same day is zero, next day is one", () => {
    expect(daysBetween("2026-01-01", "2026-01-01")).toBe(0);
    expect(daysBetween("2026-01-01", "2026-01-02")).toBe(1);
    expect(daysBetween("2026-01-02", "2026-01-01")).toBe(-1);
  });

  test("spans month and year boundaries", () => {
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetween("2026-01-31", "2026-03-02")).toBe(30);
  });

  test("addDays rolls over months and years, both directions", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-03-15", 0)).toBe("2026-03-15");
  });

  test("addDays and daysBetween agree", () => {
    expect(daysBetween("2026-04-10", addDays("2026-04-10", 45))).toBe(45);
  });
});

describe("laDateOf", () => {
  test("converts a UTC timestamp to the Los Angeles calendar date", () => {
    // 02:00 UTC is still the previous evening in Los Angeles (UTC-8).
    expect(laDateOf("2026-01-01T02:00:00Z")).toBe("2025-12-31");
    expect(laDateOf("2026-06-15T20:00:00Z")).toBe("2026-06-15");
  });

  test("returns null for unparseable input", () => {
    expect(laDateOf("not a date")).toBe(null);
  });
});

describe("periodBounds — anchored semiannual (cardmember-year halves)", () => {
  // A semiannual credit anchored BY HAND runs on two 6-month halves of
  // the anchored year. No catalog credit is seeded with a semiannual
  // anchor — the Aspire resort credit runs on calendar halves (see the
  // catalog test). With a May 1 anchor the halves are May–Oct and
  // Nov–Apr.
  const MAY1 = { month: 5, day: 1 };

  test("a date in the first anchored half gets May–Oct bounds", () => {
    const b = periodBounds("semiannual", "2026-08-15", MAY1);
    expect(b.start).toBe("2026-05-01");
    expect(b.end).toBe("2026-10-31");
    expect(addDays(b.end, 1)).toBe("2026-11-01");
  });

  test("a date in the second anchored half gets Nov–Apr bounds across the year turn", () => {
    const b = periodBounds("semiannual", "2027-02-10", MAY1);
    expect(b.start).toBe("2026-11-01");
    expect(b.end).toBe("2027-04-30");
    expect(addDays(b.end, 1)).toBe("2027-05-01");
  });

  test("the anchor day itself starts a new half", () => {
    const b = periodBounds("semiannual", "2026-11-01", MAY1);
    expect(b.start).toBe("2026-11-01");
  });

  test("without an anchor, semiannual stays calendar halves (unchanged)", () => {
    const b = periodBounds("semiannual", "2026-08-15");
    expect(b.start).toBe("2026-07-01");
    expect(b.end).toBe("2026-12-31");
  });
});

describe("isValidCalendarDate — strict real dates", () => {
  test("accepts real dates, including leap day", () => {
    expect(isValidCalendarDate("2026-10-16")).toBe(true);
    expect(isValidCalendarDate("2024-02-29")).toBe(true);
  });

  test("rejects impossible dates instead of rolling them over", () => {
    expect(isValidCalendarDate("2026-13-40")).toBe(false);
    expect(isValidCalendarDate("2026-02-30")).toBe(false);
    expect(isValidCalendarDate("2025-02-29")).toBe(false);
    expect(isValidCalendarDate("2026-00-10")).toBe(false);
  });

  test("rejects non-date shapes", () => {
    expect(isValidCalendarDate("2026-1-5")).toBe(false);
    expect(isValidCalendarDate("10/16/2026")).toBe(false);
    expect(isValidCalendarDate("")).toBe(false);
  });
});

describe("dateInTimeZone — the same instant, different calendar days", () => {
  test("a UTC-evening instant is already tomorrow in Auckland but still today in Los Angeles", () => {
    const iso = "2026-01-01T11:30:00Z";
    expect(dateInTimeZone(iso, "Pacific/Auckland")).toBe("2026-01-02");
    expect(dateInTimeZone(iso, "America/Los_Angeles")).toBe("2026-01-01");
  });
});
