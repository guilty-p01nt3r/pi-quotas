# Pace-Relative Quota Colors Implementation Plan

**Goal:** Make quota colors reflect consumption pace instead of fixed usage thresholds: green at or under the time-based estimate, yellow within a tolerance above it, orange beyond, and red once the window is exhausted.

**Architecture:** `assessWindow` in `src/utils/quotas-severity.ts` remains the single source of severity for the footer, `/quotas` dashboard, and quota warnings. The projection thresholds are replaced by a pace band: `getPaceSeverity(usedPercent, max(5, pacePercent), tolerancePercent)`. The tolerance resolves from `QuotasConfig.paceTolerancePercent` (default 10, clamped 0-50) and is read at assess time by each consumer.

**Tech Stack:** TypeScript, Pi extension API, Pi TUI component tests, Vitest, ESLint.

---

### Task 1: Pace band severity

**Files:**
- Modify: `src/utils/quotas-severity.ts`
- Modify: `src/utils/quotas-severity.test.ts`

Replace the interpolated `THRESHOLDS`/`usedFloorPercent`/`*ProjectedPercent` machinery with `getPaceSeverity`. Green when `used <= pace`, yellow when `used <= pace + tolerance`, `high` beyond. Clamp the estimate with the existing `MIN_PACE_PERCENT = 5`. Keep `absoluteUsageSeverity` (80/90/100 and `limited`) as an extra floor and as the fallback for windows without pace. Cover boundaries, clamp, `paceScale`, custom tolerance, and the no-pace fallback with fake timers.

### Task 2: Green/yellow/orange/red palette

**Files:**
- Modify: `src/utils/quotas-severity.ts`
- Modify: `src/extensions/usage-status/format-status.ts`
- Modify: `src/extensions/command-quotas/components/quotas-display.ts`

`getSeverityColor` returns `none -> success`, `warning -> warning`, `high -> orange`, `critical -> error`. Pi themes define no orange token and `theme.fg` throws for unknown colors, so `applySeverityColor` emits orange directly (`\x1b[38;2;255;140;0m` truecolor, `\x1b[38;5;208m` 256-color, `NO_COLOR` respected) and delegates every other color to the theme.

### Task 3: Configurable tolerance

**Files:**
- Modify: `src/config.ts`
- Modify: `src/extensions/usage-status/index.ts`
- Modify: `src/extensions/command-quotas/components/quotas-display.ts`
- Modify: `src/extensions/quota-warnings/index.ts`

Add `paceTolerancePercent` to the config schema, defaults, and the `/quotas:settings` wizard (a numeric row using `ctx.ui.input`). `assessWindow` accepts `{ paceTolerancePercent }`; consumers read it from `configLoader` so no migration is needed for existing config files.

### Task 4: OpenCode Go weekly pace

**Files:**
- Modify: `src/providers/providers.ts`
- Modify: `src/providers/fetch.test.ts`

The weekly window is a full 7-day budget, so it must not apply Synthetic's per-day `paceScale: 1 / 7`; elapsed share of the week is the correct estimate. Synthetic's `Credits / week` keeps its normalization because its reset window is one day of a weekly budget.

### Verification

Run `npm test`, `npm run typecheck`, and `npm run lint`. Manually check `/quotas` and the footer for an OpenCode Go weekly window: green at or under ~42.9% used mid-week, yellow up to ~52.9%, orange beyond, and the pace marker aligned with the green/yellow boundary.
