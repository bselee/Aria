/**
 * @file    src/lib/purchasing/input-class.ts
 * @purpose Single source of truth for classifying purchasing lines as BIG_INPUT
 *          or SMALL, and for mapping slack days to an action tier per class.
 *
 *          Bill's rule (2026-08-24): small products can carry 30-45 even 60
 *          days of slack and are safe to automate, but large inputs /
 *          truckloads / expensive items must be carefully monitored because a
 *          stockout stops production ("no biscuits!"). Big inputs therefore
 *          trigger earlier (ACT below 25d slack instead of 14d) and are never
 *          auto-drafted. Pure TS: no DB, no network, no imports — the caller
 *          computes freightConstrained (from the freight-units config built in
 *          parallel) and passes it in as a boolean.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    none
 * @env     none
 */

/** Classification of one purchasing line. */
export type InputClass = "BIG_INPUT" | "SMALL";

/** Dollar line value at or above which a line is BIG_INPUT. */
export const BIG_LINE_DOLLARS = 4000;
/** Suggested qty at or above which a line is BIG_INPUT. */
export const BIG_SUGGESTED_QTY = 10000;
/** Daily rate at or above which a line is BIG_INPUT. */
export const BIG_DAILY_RATE = 50;

/** Slack (days) thresholds for SMALL lines. */
export const SMALL_ACT_SLACK = 14;
export const SMALL_PLAN_SLACK = 30;
/** Slack (days) thresholds for BIG_INPUT lines. */
export const BIG_ACT_SLACK = 25;
export const BIG_PLAN_SLACK = 45;

/** Slack (days) tiers. */
export type SlackTier = "ACT" | "PLAN" | "WATCH";

/** Inputs needed to classify one purchasing line. */
export interface LineInput {
    sku: string;
    lineDollars: number;
    suggestedQty: number;
    dailyRate: number;
    /** Computed by the caller from the freight-units config; not imported here. */
    freightConstrained?: boolean;
}

/** Result of classifying a line. */
export interface Classification {
    class: InputClass;
    why: string;
}

/**
 * Classify a line as BIG_INPUT or SMALL.
 *
 * BIG_INPUT when lineDollars >= 4000 OR suggestedQty >= 10000 OR
 * dailyRate >= 50 OR freightConstrained === true. Otherwise SMALL.
 */
export function classifyLine(input: LineInput): Classification {
    if (input.freightConstrained === true) {
        return {
            class: "BIG_INPUT",
            why: `Freight-constrained (${input.sku}) needs full-freight handling even at low dollars, qty, or rate.`,
        };
    }
    if (input.lineDollars >= BIG_LINE_DOLLARS) {
        return {
            class: "BIG_INPUT",
            why: `Line value $${input.lineDollars.toLocaleString("en-US")} is at or above the $${BIG_LINE_DOLLARS.toLocaleString("en-US")} big-input threshold.`,
        };
    }
    if (input.suggestedQty >= BIG_SUGGESTED_QTY) {
        return {
            class: "BIG_INPUT",
            why: `Suggested qty ${input.suggestedQty.toLocaleString("en-US")} is at or above the ${BIG_SUGGESTED_QTY.toLocaleString("en-US")} truckload-scale threshold.`,
        };
    }
    if (input.dailyRate >= BIG_DAILY_RATE) {
        return {
            class: "BIG_INPUT",
            why: `Daily rate ${input.dailyRate.toLocaleString("en-US")} is at or above the ${BIG_DAILY_RATE.toLocaleString("en-US")} units/day threshold, so a stockout would stop production fast.`,
        };
    }
    return {
        class: "SMALL",
        why: `Line (${input.sku}) is below every big-input threshold, so it is safe to carry longer slack and automate.`,
    };
}

/**
 * Map slack days to an action tier for the given input class.
 *
 * SMALL:     slack < 14 -> ACT, slack < 30 -> PLAN, else WATCH.
 * BIG_INPUT: slack < 25 -> ACT, slack < 45 -> PLAN, else WATCH.
 * null slack -> ACT: missing data is not permission to relax.
 */
export function slackTier(slackDays: number | null, inputClass: InputClass): SlackTier {
    if (slackDays === null) {
        return "ACT";
    }
    if (inputClass === "BIG_INPUT") {
        if (slackDays < BIG_ACT_SLACK) return "ACT";
        if (slackDays < BIG_PLAN_SLACK) return "PLAN";
        return "WATCH";
    }
    if (slackDays < SMALL_ACT_SLACK) return "ACT";
    if (slackDays < SMALL_PLAN_SLACK) return "PLAN";
    return "WATCH";
}

/**
 * Whether the autonomous drafter may draft a line of the given class.
 * True only for SMALL — BIG_INPUT is NEVER auto-drafted regardless of dollars:
 * production risk needs human eyes.
 */
export function mayAutonomyDraft(inputClass: InputClass): boolean {
    return inputClass === "SMALL";
}
