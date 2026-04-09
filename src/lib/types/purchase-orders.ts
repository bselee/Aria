// types/purchase-orders.ts
// Shared types for PO lifecycle and evidence

/**
 * Purchase Order Lifecycle States
 * Represents the progression of a PO from creation to fulfillment
 */
export type POLifecycleState =
  | "DRAFT"
  | "COMMITTED"
  | "SENT"
  | "ACKNOWLEDGED"
  | "IN_TRANSIT"
  | "RECEIVED";

/**
 * Evidence entry for email-related events
 */
export interface EmailEvidence {
  /** Discriminant type */
  type: "email";
  /** Gmail message ID */
  emailId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Optional description */
  description?: string;
  /** Email subject line */
  subject?: string;
}

/**
 * Evidence entry for tracking number updates
 */
export interface TrackingEvidence {
  /** Discriminant type */
  type: "tracking";
  /** Array of tracking numbers */
  trackingNumbers: string[];
  /** Source of the tracking info */
  source: "email" | "telegram" | "portal" | "api";
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Optional description */
  description?: string;
}

/**
 * Evidence entry for significant timestamps (acknowledgment, receipt, etc.)
 */
export interface TimestampEvidence {
  /** Discriminant type */
  type: "timestamp";
  /** The specific event type */
  event: "SENT" | "ACKNOWLEDGED" | "RECEIVED" | "IN_TRANSIT";
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Optional description */
  description?: string;
}

/**
 * Union type for all possible evidence entries that can be stored in a PO's evidence record
 */
export type EvidenceEntry = EmailEvidence | TrackingEvidence | TimestampEvidence;

/**
 * The evidence record for a PO - keys are ISO 8601 timestamp strings representing when the evidence was captured,
 * values are the evidence entries themselves
 */
export type POEvidence = Record<string, EvidenceEntry>;

/**
 * Get the valid next states from a given PO lifecycle state
 * @param currentState - The current lifecycle state
 * @returns Array of valid next states
 * @example
 * ```ts
 * getValidNextStates("DRAFT") // ["COMMITTED"]
 * getValidNextStates("SENT") // ["ACKNOWLEDGED", "IN_TRANSIT"]
 * ```
 */
export function getValidNextStates(currentState: POLifecycleState): POLifecycleState[] {
  switch (currentState) {
    case "DRAFT":
      return ["COMMITTED"];
    case "COMMITTED":
      return ["SENT"];
    case "SENT":
      return ["ACKNOWLEDGED", "IN_TRANSIT"];
    case "ACKNOWLEDGED":
      return ["IN_TRANSIT", "RECEIVED"];
    case "IN_TRANSIT":
      return ["RECEIVED"];
    case "RECEIVED":
      return []; // Terminal state
    default:
      return [];
  }
}

/**
 * Validate if a transition from one PO lifecycle state to another is allowed
 * @param from - The starting state
 * @param to - The target state
 * @returns True if the transition is valid, false otherwise
 * @example
 * ```ts
 * isValidTransition("DRAFT", "COMMITTED") // true
 * isValidTransition("DRAFT", "SENT") // false
 * ```
 */
export function isValidTransition(from: POLifecycleState, to: POLifecycleState): boolean {
  return getValidNextStates(from).includes(to);
}