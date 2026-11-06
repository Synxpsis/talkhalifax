import { describe, expect, it } from "vitest";
import { checkTransitSchedule, scheduleProblem } from "../../src/transit";

const on = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("the Transit schedule check", () => {
  it("is quiet while the schedule has over a week left", () => {
    expect(scheduleProblem("20261129", on("2026-11-06"))).toBeNull();
    expect(scheduleProblem("20261129", on("2026-11-21"))).toBeNull();
  });
  it("warns a week before it ends", () => {
    expect(scheduleProblem("20261129", on("2026-11-22"))).toMatch(/ends 2026-11-29/);
  });
  it("still warns on the last day", () => {
    expect(scheduleProblem("20261129", on("2026-11-29"))).toMatch(/ends 2026-11-29/);
  });
  it("warns differently once it has ended", () => {
    expect(scheduleProblem("20261129", on("2026-12-01"))).toMatch(/ended 2026-11-29/);
  });
  it("warns when the date can't be read", () => {
    expect(scheduleProblem("", on("2026-11-06"))).toMatch(/no end date/);
  });
  it("names what to do", () => {
    expect(scheduleProblem("20261129", on("2026-11-22"))).toMatch(/Transit schedule workflow/);
  });
  it("throws for the cron, so the editor hears", () => {
    expect(() => checkTransitSchedule(on("2030-01-01"))).toThrow(/Transit/);
  });
});
