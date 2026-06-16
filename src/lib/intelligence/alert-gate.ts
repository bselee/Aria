/**
 * @file    src/lib/intelligence/alert-gate.ts
 * @purpose Business hours + BuildASoil holiday filter for automated Telegram
 *          notifications.
 *
 * Problem: Bot sends alerts 24/7 including weekends, nights and holidays.
 * Solution: Centralised gate. All automated Telegram sends must check
 *           isBusinessHours() or isBusinessDay() before calling Telegram.
 *
 * Usage:
 *   import { isBusinessHours } from './alert-gate';
 *   if (!isBusinessHours()) return; // silently drop
 *   await bot.telegram.sendMessage(chatId, msg);
 *
 * Business hours: Monday–Friday, 8 AM–5 PM America/Denver
 * Holidays:       BuildASoil 2026 paid holidays (see HOLIDAYS_2026).
 * Outside hours:  Messages are silently logged — no Telegram.
 *
 * TRUE emergency bypass: only crash-loop-detector.ts and supervisor-agent.ts
 * should use criticalAlert(). Every other path uses the gate.
 */

import { Telegraf } from 'telegraf';

/**
 * BuildASoil 2026 paid holidays (from HR system).
 * Format: MM-DD. If Jan 01 falls on a weekend the observed holiday date
 * from payroll is listed here.
 */
const HOLIDAYS_2026: string[] = [
  '01-01', // New Year's Day
  '02-16', // Presidents' Day
  '05-25', // Memorial Day
  '07-03', // Independence Day (observed — falls on Fri for Jul 4 on Sat)
  '09-07', // Labor Day
  '10-12', // Columbus Day / Indigenous Peoples' Day
  '11-26', // Thanksgiving
  '12-25', // Christmas Day
];

const TZ = 'America/Denver';

/** Format a Date in Denver time as MM-DD for holiday lookup. */
function holidayKey(date: Date, timezone: string = TZ): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date);
}

/** true if today is a BuildASoil paid holiday. */
export function isBuildASoilHoliday(date: Date = new Date(), timezone: string = TZ): boolean {
  return HOLIDAYS_2026.includes(holidayKey(date, timezone));
}

/**
 * Check if current time is within business hours.
 * @param timezone - IANA timezone string (default: America/Denver)
 * @returns true if Mon–Fri 8 AM–5 PM in the given timezone AND not a holiday.
 */
export function isBusinessHours(timezone: string = TZ): boolean {
  const now = new Date();

  // Holiday check (fast path — gate before hour/day lookups)
  if (isBuildASoilHoliday(now, timezone)) {
    return false;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value;
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');

  // Weekend check
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }

  // Business hours: 8 AM - 5 PM (17:00)
  return hour >= 8 && hour < 17;
}

/**
 * Former Telegram alert gated by business hours. Replaced with console.log
 * as part of the alert-gate migration. All non-critical alerts now log to
 * console and/or write to Supabase tables instead of sending Telegram messages.
 *
 * Only crash-loop-detector (criticalAlert) and Bill.com forward failures
 * (criticalAlert) still send Telegram at any time.
 *
 * @returns null (always — no Telegram sent)
 */
export async function businessHoursAlert(
  _bot: Telegraf,
  _chatId: string,
  message: string,
  _options?: { parse_mode?: 'Markdown' | 'HTML' }
): Promise<null> {
  const preview = message.slice(0, 120).replace(/\n/g, ' ');
  console.log(`[alert-gate] (was businessHoursAlert): "${preview}..."`);
  return null;
}

/**
 * Send critical alert immediately, regardless of business hours.
 * USE ONLY FOR: crash loops, data corruption, security incidents.
 *
 * Every other automated alert (cron summaries, stuck invoices, JIT triggers,
 * overdue POs, etc.) must use isBusinessHours() or businessHoursAlert().
 *
 * @param bot - Telegraf instance
 * @param chatId - Telegram chat ID
 * @param message - Message text
 * @param options - Telegram send options
 * @returns Message object if sent, null on failure
 */
export async function criticalAlert(
  bot: Telegraf,
  chatId: string,
  message: string,
  options?: { parse_mode?: 'Markdown' | 'HTML' }
): Promise<any | null> {
  try {
    return await bot.telegram.sendMessage(chatId, message, options);
  } catch (err: any) {
    console.warn(`[alert-gate] Critical send failed:`, err.message);
    return null;
  }
}

/**
 * Check if a specific day is a weekday (Mon-Fri) AND not a holiday.
 * @param date - Date to check (default: now)
 * @param timezone - IANA timezone string
 * @returns true if weekday and not a BuildASoil holiday
 */
export function isWeekday(date: Date = new Date(), timezone: string = TZ): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });

  const weekday = formatter.format(date);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }
  return !isBuildASoilHoliday(date, timezone);
}
