/**
 * @file    calendar.ts
 * @purpose Connects to Google Calendar to fetch scheduled production builds
 * @author  Aria
 * @created 2026-02-24
 * @deps    googleapis
 * @env     GOOGLE_APPLICATION_CREDENTIALS - path to service account JSON
 */

import { google, calendar_v3 } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import { getAuthenticatedCalendarClient } from './calendar-auth';

// Define the calendars we care about
export const CALENDAR_IDS = {
    SOIL: 'gabriel.wilson@buildasoil.com',
    MFG: 'manufacturing@buildasoil.com'
};

export interface CalendarEvent {
    id: string;
    title: string;
    description: string;
    startDate: string; // YYYY-MM-DD
    endDate: string;
    calendarId: string;
}

export class CalendarClient {
    private calendar: calendar_v3.Calendar | null = null;

    constructor() {
        // The constructor is now empty as authentication is handled by init()
    }

    /**
     * Helper to initialize the client dynamically with OAuth2,
     * since constructor cannot be async.
     */
    private async init() {
        if (this.calendar) return;
        const authClient = await getAuthenticatedCalendarClient();
        this.calendar = google.calendar({ version: 'v3', auth: authClient as any });
    }

    /**
     * Fetch events from a specific calendar within a time range.
     * @param calendarId The email address / ID of the calendar
     * @param daysOut How many days Out to look (default 30)
     */
    async getUpcomingEvents(calendarId: string, daysOut: number = 30): Promise<CalendarEvent[]> {
        await this.init();

        const now = new Date();
        const timeMin = now.toISOString();

        const futureDate = new Date(now);
        futureDate.setDate(now.getDate() + daysOut);
        const timeMax = futureDate.toISOString();

        try {
            const response = await this.calendar!.events.list({
                calendarId,
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 100, // Should be enough for 30 days
            });

            const events = response.data.items || [];

            return events.map(event => {
                // Handle all-day events vs timed events
                const start = event.start?.date || event.start?.dateTime;
                const end = event.end?.date || event.end?.dateTime;

                return {
                    id: event.id || 'unknown',
                    title: event.summary || 'Untitled Event',
                    description: event.description || '',
                    startDate: start ? start.split('T')[0] : '', // Normalize to YYYY-MM-DD
                    endDate: end ? end.split('T')[0] : '',
                    calendarId,
                };
            }).filter(e => e.startDate !== ''); // Filter out any bizarre empty events

        } catch (err: any) {
            console.error(`❌ Failed to fetch events for calendar ${calendarId}:`, err.message);
            throw err;
        }
    }

    /**
     * Fetch upcoming events from all configured production calendars
     */
    async getAllUpcomingBuilds(daysOut: number = 30): Promise<CalendarEvent[]> {
        console.log(`fetching events for the next ${daysOut} days...`);
        const soilEvents = await this.getUpcomingEvents(CALENDAR_IDS.SOIL, daysOut);
        const mfgEvents = await this.getUpcomingEvents(CALENDAR_IDS.MFG, daysOut);

        // Merge and sort chronologically
        const allEvents = [...soilEvents, ...mfgEvents];
        allEvents.sort((a, b) => a.startDate.localeCompare(b.startDate));

        return allEvents;
    }
}
