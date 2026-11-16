import type { AccessScope, Office, Permission, TaskId } from "./model";
import type { AgentLoad } from "./agentState";
import type { StandingView } from "./standing";

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
  /** The service address. Null for an Anthropic provider at Anthropic itself. */
  baseUrl: string | null;
  defaultModel: string;
  hasKey: boolean;
  /** The last characters of the stored key, to recognise it by. */
  keyHint: string | null;
  /** A key is stored but can no longer be decrypted, so it must be re-entered. */
  keyUnreadable: boolean;
  /** Whether an agent can use this provider as it stands. */
  usable: boolean;
  /**
   * Null for a provider that belongs to the office. For one brought in from
   * an account: "you" when it is the viewer's own, else the owner's name.
   */
  sharedBy: string | null;
  /** Whether this viewer may give it to an agent. */
  selectable: boolean;
}

/** A system connected to a room. The API key itself is never included. */
export interface SystemView {
  id: string;
  name: string;
  /** When to use the system and how, as agents are told. */
  description: string;
  /** What can be done in it, as the system lists it. */
  operations: string[];
  /** The room it is operated from. */
  roomId: string;
  /** Further rooms whose readers are shown its records. */
  shownIn: string[];
  baseUrl: string;
  /** Each action an agent takes here waits for a person's approval. */
  needsApproval: boolean;
  hasKey: boolean;
  keyHint: string | null;
  /** A key is stored but can no longer be decrypted, so it must be re-entered. */
  keyUnreadable: boolean;
}

/** One line of a direct conversation between the viewer and someone else. */
export interface DirectLine {
  id: number;
  /** The other participant in the conversation. */
  withId: string;
  fromMe: boolean;
  body: string;
  at: number;
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
  /** The providers that belong to the viewer's own account, usable in any of their offices. */
  ownProviders: ProviderView[];
  /** Whether this account may keep providers of its own. Demo access may not. */
  ownProvidersEditable: boolean;
  /** The viewer's direct conversations, with people and with agents. */
  directs: DirectLine[];
  /** What the viewer has not opened yet. */
  unread: {
    /** Per other participant, the number of their messages not yet opened. */
    directs: Record<string, number>;
    /** Ids of notes in task threads addressed to the viewer and not yet opened. */
    notes: string[];
  };
  /** Connected systems with their addresses, for people who manage rooms. */
  systems: SystemView[];
  /** Whether this viewer may connect, change or disconnect systems here. */
  systemsEditable: boolean;
  /** Requests the office files by itself, for people who manage the office. */
  standing: StandingView[];
  /** Whether this viewer may set up standing work here. */
  standingEditable: boolean;
  /** The signed-in account, as distinct from the seat in this office. */
  account: { email: string; displayName: string; isDemo: boolean };
  /** Every office this account has a seat in. */
  offices: { officeId: string; name: string; canRemove: boolean; isDemo: boolean; active: boolean }[];
  /** True in the shared demo office, where some settings are locked. */
  isDemoOffice: boolean;
  /** True while agents are carrying work forward in the background. */
  agentsAtWork: boolean;
  /**
   * For each agent with work in hand: the task it is on, whether only to
   * answer a note there, and the tasks waiting behind it in the order it
   * will take them.
   */
  agentLoad: AgentLoad;
  accessTokens: TokenView[];
  /** Sign-in accounts. Empty unless the viewer manages people. */
  accounts: { participantId: string; email: string; hasPassword: boolean }[];
}
