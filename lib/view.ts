import type { AccessScope, Office, TaskId } from "./model";

export interface FeedEntry {
  id: number;
  at: number;
  text: string;
}

export interface TokenView {
  id: string;
  ruleId: string;
  participantId: string;
  /** Null means every room. */
  roomId: string | null;
  scope: AccessScope;
  taskId: string | null;
  reason: string;
  issuedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  /** Why the token would be refused right now, or null when it is usable. */
  problem: string | null;
}

/** Everything the browser receives: the office as this viewer may see it. */
export interface OfficeView {
  office: Office;
  now: number;
  viewer: {
    participantId: string;
    displayName: string;
    title: string;
    email: string;
    supervises: boolean;
  };
  feed: FeedEntry[];
  /** Per task, how many messages this viewer is not allowed to read. */
  hiddenMessages: Record<TaskId, number>;
  /** Whether agents answer from the fixed script or from a live model. */
  runtime: "scripted" | "model";
  accessTokens: TokenView[];
  /** Sign-in accounts. Empty unless the viewer supervises. */
  accounts: { participantId: string; email: string; hasPassword: boolean }[];
}
