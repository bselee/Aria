/**
 * @file    constants.ts
 * @purpose Shared numeric constants for the Aria ordering pipeline.
 *          Single source of truth for default values so fallbacks don't
 *          silently drift across modules.
 * @author  Hermia
 * @created 2026-07-14
 */

/** Default vendor lead time (calendar days) used when no real data is available.
 *  Set to 21 days per Bill's directive — conservative enough to prevent
 *  late-order stockouts on unknown vendors.
 *
 *  Import this everywhere a lead-time fallback is needed. The central resolver
 *  (lead-time-service.ts) also uses this value, so changing it here changes
 *  every fallback path in the ordering pipeline. */
export const DEFAULT_LEAD_TIME_DAYS = 21;
