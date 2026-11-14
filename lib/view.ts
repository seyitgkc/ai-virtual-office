import type { AccessScope, Office, Permission, TaskId } from "./model";

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

export type ProviderKind = "anthropic" | "openai_compatible";

/** One of an office's AI providers. The API key itself is never included. */
export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  /** The service address, for OpenAI-compatible providers. */
  baseUrl: string | null;
  defaultModel: string;
  hasKey: boolean;
  /** The last characters of the stored key, to recognise it by. */
  keyHint: string | null;
  /** A key is stored but can no longer be decrypted, so it must be re-entered. */
  keyUnreadable: boolean;
  /** Whether an agent can use this provider as it stands. */
  usable: boolean;
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
    /** What this person's role lets them do beyond working in rooms. */
    permissions: Permission[];
  };
  feed: FeedEntry[];
  /** Per task, how many messages this viewer is not allowed to read. */
  hiddenMessages: Record<TaskId, number>;
  /** The office's AI providers, for people who manage agents or providers. */
  providers: ProviderView[];
  /** Whether this viewer may add or change providers here. */
  providersEditable: boolean;
  /** The signed-in account, as distinct from the seat in this office. */
  account: { email: string; displayName: string; isDemo: boolean };
  /** Every office this account has a seat in. */
  offices: { officeId: string; name: string; canRemove: boolean; isDemo: boolean; active: boolean }[];
  /** True in the shared demo office, where some settings are locked. */
  isDemoOffice: boolean;
  accessTokens: TokenView[];
  /** Sign-in accounts. Empty unless the viewer manages people. */
  accounts: { participantId: string; email: string; hasPassword: boolean }[];
}
