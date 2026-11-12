import { type AgentPresence, type FocusRequest, type JournalEntry, type Snapshot, UiState } from '../shared/model.ts';

export type ServerEvent =
  | { event: 'snapshot'; data: { snapshot: Snapshot; entry?: JournalEntry } }
  | { event: 'agent'; data: AgentPresence }
  | { event: 'focus'; data: FocusRequest };

const PRESENCE_TIMEOUT_MS = 60_000;

/**
 * Live, unpersisted state shared between the browser and the agent: what the human
 * sees, whether an agent is around, and the browsers listening for events.
 */
export class Session {
  private ui: UiState = UiState.parse({});
  private uiAt?: string;
  private presence: AgentPresence = { connected: false };
  private presenceTimer?: NodeJS.Timeout;
  private listeners = new Set<(event: ServerEvent) => void>();
  private cursor = 0;

  constructor(private presenceTimeoutMs = PRESENCE_TIMEOUT_MS) {}

  get uiState(): UiState {
    return this.ui;
  }

  /** When a browser last reported the UI state (ISO time), or undefined if none has yet. */
  get uiReportedAt(): string | undefined {
    return this.uiAt;
  }

  setUi(input: unknown): UiState {
    this.ui = UiState.parse(input);
    this.uiAt = new Date().toISOString();
    return this.ui;
  }

  /** Store revision up to which the agent has seen the human's changes. */
  get agentCursor(): number {
    return this.cursor;
  }

  /** Moves the cursor forward only, so a slow response cannot hide changes a faster one already covered. */
  advanceAgentCursor(revision: number): void {
    this.cursor = Math.max(this.cursor, revision);
  }

  get agent(): AgentPresence {
    return this.presence;
  }

  /** Marks the agent present; any MCP request counts. */
  touchAgent(clientName?: string): void {
    const changed = !this.presence.connected || (clientName !== undefined && clientName !== this.presence.clientName);
    this.presence = {
      connected: true,
      clientName: clientName ?? this.presence.clientName,
      lastSeenAt: new Date().toISOString(),
    };
    clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => {
      this.presence = { ...this.presence, connected: false };
      this.publish({ event: 'agent', data: this.presence });
    }, this.presenceTimeoutMs);
    this.presenceTimer.unref();
    if (changed) this.publish({ event: 'agent', data: this.presence });
  }

  get browserCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  close(): void {
    clearTimeout(this.presenceTimer);
  }
}
