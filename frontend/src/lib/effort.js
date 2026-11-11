// @ts-check
// Effort names, shared by the composer chip and the run strip so they never drift.

/** @type {Readonly<Record<string, string>>} */
export const EFFORT_LABELS = Object.freeze({
  instant: 'Instant', fast: 'Fast', balanced: 'Balanced', thorough: 'Thorough', deep: 'Deep',
  high: 'High', hour: '1 hour', session: '5 hours'
});
