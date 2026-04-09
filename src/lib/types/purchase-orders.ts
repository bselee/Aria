// types/purchase-orders.ts
// Shared types for PO lifecycle and evidence

// PO Lifecycle States
export type POLifecycleState =
  | "DRAFT"
  | "COMMITTED"
  | "SENT"
  | "ACKNOWLEDGED"
  | "IN_TRANSIT"
  | "RECEIVED";

// Evidence Entry Types
export interface EmailEvidence {
  type: "email";
  emailId: string;
  timestamp: string; // ISO 8601
  description?: string;
  subject?: string;
}

export interface TrackingEvidence {
  type: "tracking";
  trackingNumbers: string[];
  source: "email" | "telegram" | "portal" | "api";
  timestamp: string; // ISO 8601
  description?: string;
}

export interface TimestampEvidence {
  type: "timestamp";
  event: "sent" | "acknowledged" | "received" | "in_transit";
  timestamp: string; // ISO 8601
  description?: string;
}

// Union type for all evidence entries
export type EvidenceEntry = EmailEvidence | TrackingEvidence | TimestampEvidence;

// Evidence as a record of timestamps to entries
export type POEvidence = Record<string, EvidenceEntry>;

// Validation utility for lifecycle state transitions
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

export function isValidTransition(from: POLifecycleState, to: POLifecycleState): boolean {
  return getValidNextStates(from).includes(to);
}