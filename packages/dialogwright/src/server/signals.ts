/**
 * A repeat of a stop signal this soon after the first is the same stop, delivered again: a terminal's
 * Ctrl-C, and a service manager that signals every process of the service, reach pnpm, tsx and the
 * server at once, and pnpm and tsx each pass a signal on too (tsx drops a copy its child already had,
 * on a 30 ms wait). A person's second Ctrl-C comes later than this; it exits at once. The server
 * (index.ts main) and pnpm start (start.ts) both count stops this way.
 */
export const SIGNAL_REPEAT_MS = 1_000;
