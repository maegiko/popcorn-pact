/**
 * Renders an ISO timestamp as a local date/time for a planned watch time.
 * `Intl.DateTimeFormat` with the device's own locale, rather than hand-rolled
 * locale logic, is what keeps this stable across locales without upkeep.
 */
export function formatPlannedFor(plannedFor: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(plannedFor));
}

/**
 * A sensible starting point for a fresh planned time: an hour from now,
 * rounded up to the next half hour, so the picker doesn't open on an odd
 * minute like 3:47.
 */
export function defaultPlannedTime(): Date {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() <= 30 ? 30 : 60, 0, 0);
  return date;
}
