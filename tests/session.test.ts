import { describe, expect, it } from 'vitest';
import { type ServerEvent, Session } from '../src/server/session.ts';
import { waitFor } from './helpers.ts';

describe('Session', () => {
  it('marks the agent present on requests and expires it after the timeout', async () => {
    const session = new Session(50);
    const events: ServerEvent[] = [];
    session.subscribe((e) => events.push(e));
    session.touchAgent('claude-code');
    session.touchAgent();
    expect(session.agent).toMatchObject({ connected: true, clientName: 'claude-code' });
    expect(events).toHaveLength(1);
    await waitFor(() => !session.agent.connected);
    expect(events.map((e) => e.event === 'agent' && e.data.connected)).toEqual([true, false]);
    expect(session.agent.clientName).toBe('claude-code');
    session.close();
  });

  it('validates and defaults the UI state', () => {
    const session = new Session();
    expect(session.setUi({ selectedElementIds: ['a'] })).toEqual({ perspective: 'structure', selectedElementIds: ['a'], selectedRelationIds: [] });
    expect(() => session.setUi({ perspective: 'sideways' })).toThrow();
  });
});
