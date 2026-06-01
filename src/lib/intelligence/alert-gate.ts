/**
 * Alert Gate — Business hours filter for automated Telegram notifications.
 *
 * Problem: Bot sends alerts 24/7, including weekends and nights.
 * Solution: Centralized gate that checks business hours before sending.
 *
 * Usage:
 *   import { businessHoursAlert, criticalAlert } from '../alert-gate';
 *
 *   // For routine alerts (cron results, summaries, status updates)
 *   await businessHoursAlert(this.bot, chatId, "PO received...", { parse_mode: "Markdown" });
 *
 *   // For critical system failures (crash loops, data corruption)
 *   await criticalAlert(this.bot, chatId, "CRITICAL: Bot crash detected...");
 *
 * Business Hours: Monday-Friday, 7AM-5PM America/Denver
 * Outside hours: Messages are silently dropped (logged for audit).
 */

import { Telegraf } from 'telegraf';

/**
 * Check if current time is within business hours.
 * @param timezone - IANA timezone string (default: America/Denver)
 * @returns true if Mon-Fri 7AM-5PM in the given timezone
 */
export function isBusinessHours(timezone: string = 'America/Denver'): boolean {
  const now = new Date();

  // Get day of week and hour in the target timezone
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

  // Business hours: 7AM-5PM (17:00)
  return hour >= 7 && hour < 17;
}

/**
 * Send alert only during business hours (Mon-Fri 7AM-5PM).
 * Outside hours: message is logged but not sent.
 *
 * @param bot - Telegraf instance
 * @param chatId - Telegram chat ID
 * @param message - Message text
 * @param options - Telegram send options (parse_mode, etc.)
 * @returns Message object if sent, null if gated
 */
export async function businessHoursAlert(
  bot: Telegraf,
  chatId: string,
  message: string,
  options?: { parse_mode?: 'Markdown' | 'HTML' }
): Promise<any | null> {
  if (!isBusinessHours()) {
    const preview = message.slice(0, 80).replace(/\n/g, ' ');
    console.log(`[alert-gate] 🔇 Gated (outside business hours): "${preview}..."`);
    return null;
  }

  try {
    return await bot.telegram.sendMessage(chatId, message, options);
  } catch (err: any) {
    console.warn(`[alert-gate] Send failed:`, err.message);
    return null;
  }
}

/**
 * Send critical alert immediately, regardless of business hours.
 * Use for: crash loops, data corruption, security incidents.
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
 * Check if a specific day is a weekday (Mon-Fri).
 * @param date - Date to check (default: now)
 * @param timezone - IANA timezone string
 * @returns true if weekday
 */
export function isWeekday(date: Date = new Date(), timezone: string = 'America/Denver'): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });

  const weekday = formatter.format(date);
  return weekday !== 'Sat' && weekday !== 'Sun';
}
