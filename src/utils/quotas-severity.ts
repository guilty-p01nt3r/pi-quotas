import type { QuotaWindow } from "../types/quotas.js";
export type { QuotaWindow } from "../types/quotas.js";

export type RiskSeverity = "none" | "warning" | "high" | "critical";

export type SeverityColor = "success" | "warning" | "orange" | "error";

export interface WindowProjection {
  pacePercent: number | null;
  projectedPercent: number;
  usedPercent: number;
}

export interface RiskAssessment extends WindowProjection {
  /**
   * Expected used percent at this moment (the pace estimate), clamped to
   * MIN_PACE_PERCENT so early-window noise cannot flag healthy usage. Null
   * when the window has no pace information.
   */
  paceThresholdPercent: number | null;
  /** Percentage points allowed above the pace estimate before yellow/red apply. */
  tolerancePercent: number;
  severity: RiskSeverity;
}

export interface AssessWindowOptions {
  /** Percentage points above the pace estimate before usage is flagged. Defaults to 10. */
  paceTolerancePercent?: number;
}

const MIN_PACE_PERCENT = 5;
export const DEFAULT_PACE_TOLERANCE_PERCENT = 10;
export const MAX_PACE_TOLERANCE_PERCENT = 50;

const ORANGE_TRUECOLOR = "\x1b[38;2;255;140;0m";
const ORANGE_256COLOR = "\x1b[38;5;208m";
const FOREGROUND_RESET = "\x1b[39m";

export function safePercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

export function getPacePercent(window: QuotaWindow): number | null {
  const totalMs = window.windowSeconds * 1000;
  if (totalMs <= 0) return null;
  const remainingMs = window.resetsAt.getTime() - Date.now();
  const elapsedMs = totalMs - remainingMs;
  return Math.max(0, Math.min(100, (elapsedMs / totalMs) * 100));
}

export function getProjectedPercent(
  usedPercent: number,
  pacePercent: number | null,
): number {
  if (pacePercent === null) return usedPercent;
  const effectivePace = Math.max(MIN_PACE_PERCENT, pacePercent);
  return Math.max(0, (usedPercent / effectivePace) * 100);
}

export function clampPaceTolerance(percent: number | undefined): number {
  if (percent === undefined || !Number.isFinite(percent)) {
    return DEFAULT_PACE_TOLERANCE_PERCENT;
  }
  return Math.max(
    0,
    Math.min(MAX_PACE_TOLERANCE_PERCENT, Math.round(percent)),
  );
}

/**
 * Pace-band severity: green at or under the estimate, yellow within the
 * tolerance above it, and red (high) beyond it.
 */
export function getPaceSeverity(
  usedPercent: number,
  pacePercent: number,
  tolerancePercent = DEFAULT_PACE_TOLERANCE_PERCENT,
): RiskSeverity {
  const tolerance = clampPaceTolerance(tolerancePercent);
  if (usedPercent <= pacePercent) return "none";
  if (usedPercent <= pacePercent + tolerance) return "warning";
  return "high";
}

function absoluteUsageSeverity(
  window: QuotaWindow,
  percent: number,
): RiskSeverity {
  if (window.limited || percent >= 100) return "critical";
  if (percent >= 90) return "high";
  if (percent >= 80) return "warning";
  return "none";
}

function maxSeverity(a: RiskSeverity, b: RiskSeverity): RiskSeverity {
  const order: RiskSeverity[] = ["none", "warning", "high", "critical"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))] ?? "none";
}

export function assessWindow(
  window: QuotaWindow,
  options: AssessWindowOptions = {},
): RiskAssessment {
  const tolerancePercent = clampPaceTolerance(options.paceTolerancePercent);
  const rawPace = window.showPace ? getPacePercent(window) : null;
  const pacePercent =
    rawPace !== null ? rawPace * (window.paceScale ?? 1) : null;
  const projectedPercent = getProjectedPercent(window.usedPercent, pacePercent);
  const absoluteSeverity = absoluteUsageSeverity(window, window.usedPercent);

  const base: WindowProjection = {
    pacePercent,
    projectedPercent,
    usedPercent: window.usedPercent,
  };

  if (pacePercent === null) {
    const severity = absoluteUsageSeverity(window, projectedPercent);

    return {
      ...base,
      paceThresholdPercent: null,
      tolerancePercent,
      severity,
    };
  }

  const paceThresholdPercent = Math.max(MIN_PACE_PERCENT, pacePercent);
  const severity = maxSeverity(
    getPaceSeverity(window.usedPercent, paceThresholdPercent, tolerancePercent),
    absoluteSeverity,
  );

  return {
    ...base,
    paceThresholdPercent,
    tolerancePercent,
    severity,
  };
}

export function formatTimeRemaining(date: Date): string {
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return "now";
  const totalMins = Math.ceil(ms / (1000 * 60));
  const totalHours = Math.floor(totalMins / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const mins = totalMins % 60;

  if (days >= 1) {
    const parts: string[] = [`${days}d`];
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0) parts.push(`${mins}m`);
    return parts.join(" ");
  }
  if (hours >= 1) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const totalSecs = Math.ceil(ms / 1000);
  return totalMins >= 1 ? `${totalMins}m` : `${totalSecs}s`;
}

export function getSeverityColor(severity: RiskSeverity): SeverityColor {
  switch (severity) {
    case "critical":
      return "error";
    case "high":
      return "orange";
    case "warning":
      return "warning";
    default:
      return "success";
  }
}

export interface SeverityThemeLike {
  fg(color: string, text: string): string;
  getColorMode?(): "truecolor" | "256color";
}

/**
 * Apply a severity color. All palette entries except orange map to theme
 * tokens; orange is emitted directly because pi themes do not define an
 * orange token (`theme.fg` throws for unknown colors).
 */
export function applySeverityColor(
  theme: SeverityThemeLike,
  color: SeverityColor,
  text: string,
): string {
  if (color !== "orange") return theme.fg(color, text);
  if (process.env.NO_COLOR) return text;
  const mode = theme.getColorMode?.() ?? "truecolor";
  const ansi = mode === "256color" ? ORANGE_256COLOR : ORANGE_TRUECOLOR;
  return `${ansi}${text}${FOREGROUND_RESET}`;
}
