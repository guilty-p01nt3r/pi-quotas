import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySeverityColor,
  assessWindow,
  DEFAULT_PACE_TOLERANCE_PERCENT,
  formatTimeRemaining,
  getPacePercent,
  getPaceSeverity,
  getProjectedPercent,
  getSeverityColor,
  safePercent,
  type QuotaWindow,
} from "./quotas-severity.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FROZEN_NOW = new Date("2026-05-13T12:00:00.000Z");

function makeWindow(
  overrides: Partial<QuotaWindow> & Pick<QuotaWindow, "usedPercent">,
): QuotaWindow {
  const windowSeconds = overrides.windowSeconds ?? 3600;
  const resetsAt =
    overrides.resetsAt ?? new Date(Date.now() + windowSeconds * 500);
  return {
    provider: "anthropic",
    label: "Test Window",
    resetsAt,
    windowSeconds,
    usedValue: 0,
    limitValue: 100,
    ...overrides,
  };
}

describe("safePercent", () => {
  it("returns 0 for zero/invalid limit", () => {
    expect(safePercent(50, 0)).toBe(0);
    expect(safePercent(50, -1)).toBe(0);
    expect(safePercent(50, NaN)).toBe(0);
    expect(safePercent(NaN, 100)).toBe(0);
  });

  it("computes correct percentage", () => {
    expect(safePercent(50, 100)).toBe(50);
    expect(safePercent(75, 100)).toBe(75);
    expect(safePercent(1, 3)).toBeCloseTo(33.33);
  });
});

describe("getPacePercent", () => {
  it("returns null for zero window", () => {
    const w = makeWindow({ usedPercent: 50, windowSeconds: 0 });
    expect(getPacePercent(w)).toBeNull();
  });

  it("returns ~50 for a window 50% elapsed", () => {
    const w = makeWindow({
      usedPercent: 50,
      windowSeconds: 3600,
      resetsAt: new Date(Date.now() + 1800 * 1000),
    });
    const pace = getPacePercent(w);
    expect(pace).not.toBeNull();
    expect(pace!).toBeCloseTo(50, 0);
  });
});

describe("getProjectedPercent", () => {
  it("returns usedPercent when no pace", () => {
    expect(getProjectedPercent(42, null)).toBe(42);
  });

  it("projects based on pace", () => {
    expect(getProjectedPercent(50, 25)).toBe(200);
  });

  it("clamps tiny pace to the minimum", () => {
    expect(getProjectedPercent(5, 1)).toBe(100);
  });
});

describe("getPaceSeverity", () => {
  it("bands usage around the pace estimate", () => {
    expect(getPaceSeverity(40, 42.857, 10)).toBe("none");
    expect(getPaceSeverity(42.857, 42.857, 10)).toBe("none");
    expect(getPaceSeverity(42.858, 42.857, 10)).toBe("warning");
    expect(getPaceSeverity(52.857, 42.857, 10)).toBe("warning");
    expect(getPaceSeverity(52.858, 42.857, 10)).toBe("high");
  });

  it("uses the default tolerance when omitted", () => {
    expect(getPaceSeverity(20, 10)).toBe("warning");
    expect(getPaceSeverity(20.001, 10)).toBe("high");
  });

  it("clamps out-of-range tolerances", () => {
    expect(getPaceSeverity(11, 10, -5)).toBe("high");
    expect(getPaceSeverity(55, 10, 999)).toBe("warning");
    expect(getPaceSeverity(65, 10, 999)).toBe("high");
  });
});

describe("assessWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function weeklyWindow(
    usedPercent: number,
    overrides: Partial<QuotaWindow> = {},
  ): QuotaWindow {
    return makeWindow({
      provider: "opencode-go",
      label: "Weekly",
      usedPercent,
      usedValue: usedPercent,
      showPace: true,
      windowSeconds: 7 * 24 * 3600,
      // 3 of 7 days elapsed -> pace = 42.857...
      resetsAt: new Date(FROZEN_NOW.getTime() + 4 * DAY_MS),
      ...overrides,
    });
  }

  it("keeps usage green at or under the pace estimate", () => {
    const pace = getPacePercent(weeklyWindow(0));
    expect(pace).not.toBeNull();
    expect(assessWindow(weeklyWindow(pace!)).severity).toBe("none");
    expect(assessWindow(weeklyWindow(pace! - 5)).severity).toBe("none");
  });

  it("turns yellow within the tolerance and orange beyond it", () => {
    const pace = getPacePercent(weeklyWindow(0))!;
    expect(assessWindow(weeklyWindow(pace + 0.001)).severity).toBe("warning");
    expect(assessWindow(weeklyWindow(pace + 5)).severity).toBe("warning");
    expect(assessWindow(weeklyWindow(pace + 10)).severity).toBe("warning");
    expect(assessWindow(weeklyWindow(pace + 10.001)).severity).toBe("high");
  });

  it("exposes the pace estimate and tolerance on the assessment", () => {
    const assessment = assessWindow(weeklyWindow(50));
    expect(assessment.paceThresholdPercent).toBeCloseTo(42.857, 2);
    expect(assessment.tolerancePercent).toBe(DEFAULT_PACE_TOLERANCE_PERCENT);
    expect(assessment.projectedPercent).toBeCloseTo((50 / 42.857) * 100, 0);

    const custom = assessWindow(weeklyWindow(50), {
      paceTolerancePercent: 25,
    });
    expect(custom.tolerancePercent).toBe(25);
  });

  it("honors a custom tolerance", () => {
    const pace = getPacePercent(weeklyWindow(0))!;
    const over = weeklyWindow(pace + 20);
    expect(assessWindow(over).severity).toBe("high");
    expect(assessWindow(over, { paceTolerancePercent: 20 }).severity).toBe(
      "warning",
    );
    expect(assessWindow(over, { paceTolerancePercent: 0 }).severity).toBe(
      "high",
    );

    const barely = weeklyWindow(pace + 1);
    expect(assessWindow(barely, { paceTolerancePercent: 0 }).severity).toBe(
      "high",
    );
    expect(assessWindow(barely).severity).toBe("warning");
  });

  it("clamps the pace estimate to the minimum at window start", () => {
    const fresh = weeklyWindow(0, {
      resetsAt: new Date(FROZEN_NOW.getTime() + 7 * DAY_MS),
    });
    expect(getPacePercent(fresh)).toBe(0);
    expect(assessWindow(fresh).paceThresholdPercent).toBe(5);

    expect(assessWindow({ ...fresh, usedPercent: 4 }).severity).toBe("none");
    expect(assessWindow({ ...fresh, usedPercent: 5 }).severity).toBe("none");
    expect(assessWindow({ ...fresh, usedPercent: 5.5 }).severity).toBe(
      "warning",
    );
    expect(assessWindow({ ...fresh, usedPercent: 15 }).severity).toBe(
      "warning",
    );
    expect(assessWindow({ ...fresh, usedPercent: 15.5 }).severity).toBe("high");
  });

  it("normalizes pace with paceScale (Synthetic weekly credits)", () => {
    const syntheticWindow = makeWindow({
      provider: "synthetic",
      label: "Credits / week",
      usedPercent: 8,
      windowSeconds: 24 * 3600,
      resetsAt: new Date(FROZEN_NOW.getTime() + 12 * 3600 * 1000),
      showPace: true,
      paceScale: 1 / 7,
    });

    // Raw pace is 50%, normalized to 50 / 7 = 7.142857.
    expect(assessWindow(syntheticWindow).paceThresholdPercent).toBeCloseTo(
      50 / 7,
      5,
    );
    expect(assessWindow({ ...syntheticWindow, usedPercent: 7 }).severity).toBe(
      "none",
    );
    expect(assessWindow({ ...syntheticWindow, usedPercent: 8 }).severity).toBe(
      "warning",
    );
    expect(assessWindow({ ...syntheticWindow, usedPercent: 17 }).severity).toBe(
      "warning",
    );
    expect(assessWindow({ ...syntheticWindow, usedPercent: 18 }).severity).toBe(
      "high",
    );
  });

  it("keeps absolute usage floors even when pace says green", () => {
    const lateWindow = weeklyWindow(85, {
      resetsAt: new Date(FROZEN_NOW.getTime() + 0.5 * DAY_MS),
    });
    expect(assessWindow(lateWindow).severity).toBe("warning");
    expect(assessWindow({ ...lateWindow, usedPercent: 92 }).severity).toBe(
      "high",
    );
    expect(assessWindow({ ...lateWindow, usedPercent: 100 }).severity).toBe(
      "critical",
    );
  });

  it("keeps limited windows critical regardless of pace", () => {
    const limited = assessWindow(
      makeWindow({ usedPercent: 5, showPace: false, limited: true }),
    );
    expect(limited.severity).toBe("critical");
  });

  it("falls back to absolute severity for windows without pace", () => {
    const base: Partial<QuotaWindow> = {
      showPace: false,
      windowSeconds: 0,
      resetsAt: new Date(0),
    };

    const none = assessWindow(makeWindow({ usedPercent: 50, ...base }));
    expect(none.severity).toBe("none");
    expect(none.paceThresholdPercent).toBeNull();
    expect(assessWindow(makeWindow({ usedPercent: 82, ...base })).severity).toBe(
      "warning",
    );
    expect(assessWindow(makeWindow({ usedPercent: 92, ...base })).severity).toBe(
      "high",
    );
    expect(
      assessWindow(makeWindow({ usedPercent: 100, ...base })).severity,
    ).toBe("critical");
  });
});

describe("formatTimeRemaining", () => {
  it("separates adjacent time units", () => {
    expect(formatTimeRemaining(new Date(Date.now() + (2 * 60 + 19) * 60_000))).toBe("2h 19m");
    expect(formatTimeRemaining(new Date(Date.now() + (26 * 60 + 19) * 60_000))).toBe("1d 2h 19m");
  });
});

describe("getSeverityColor", () => {
  it("maps severity levels to the green/yellow/orange/red palette", () => {
    expect(getSeverityColor("none")).toBe("success");
    expect(getSeverityColor("warning")).toBe("warning");
    expect(getSeverityColor("high")).toBe("orange");
    expect(getSeverityColor("critical")).toBe("error");
  });
});

describe("applySeverityColor", () => {
  function fakeTheme() {
    return {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      getColorMode: () => "truecolor" as const,
    };
  }

  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  it("maps non-orange palette entries to theme colors", () => {
    const theme = fakeTheme();
    expect(applySeverityColor(theme, "success", "x")).toBe(
      "[success]x[/success]",
    );
    expect(applySeverityColor(theme, "warning", "x")).toBe(
      "[warning]x[/warning]",
    );
    expect(applySeverityColor(theme, "error", "x")).toBe("[error]x[/error]");
  });

  it("emits orange directly for truecolor and 256-color terminals", () => {
    expect(applySeverityColor(fakeTheme(), "orange", "x")).toBe(
      "\x1b[38;2;255;140;0mx\x1b[39m",
    );

    const theme256 = { ...fakeTheme(), getColorMode: () => "256color" as const };
    expect(applySeverityColor(theme256, "orange", "x")).toBe(
      "\x1b[38;5;208mx\x1b[39m",
    );
  });

  it("falls back to truecolor when the theme does not report a mode", () => {
    const plainTheme = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    };
    expect(applySeverityColor(plainTheme, "orange", "x")).toBe(
      "\x1b[38;2;255;140;0mx\x1b[39m",
    );
  });

  it("respects NO_COLOR", () => {
    process.env.NO_COLOR = "1";
    expect(applySeverityColor(fakeTheme(), "orange", "x")).toBe("x");
  });
});
