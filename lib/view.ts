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

/** How an office's agents think. The API key itself is never included. */
export interface AiView {
  runtime: "scripted" | "model";
  provider: "anthropic";
  model: string;
  hasKey: boolean;
  /** The last characters of the stored key, to recognise it by. */
  keyHint: string | null;
  /** A key is stored but can no longer be decrypted, so it must be re-entered. */
  keyUnreadable: boolean;
  /** Whether this viewer may change these settings. */
  editable: boolean;
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
  /** AI provider settings. Null unless the viewer supervises. */
  ai: AiView | null;
  /** The signed-in account, as distinct from the seat in this office. */
  account: { email: string; displayName: string; isDemo: boolean };
  /** Every office this account has a seat in. */
  offices: { officeId: string; name: string; supervises: boolean; isDemo: boolean; active: boolean }[];
  /** True in the shared demo office, where some settings are locked. */
  isDemoOffice: boolean;
  accessTokens: TokenView[];
  /** Sign-in accounts. Empty unless the viewer supervises. */
  accounts: { participantId: string; email: string; hasPassword: boolean }[];
}
