import { detectActivity } from './activity-rules.js';
import type { ActivityEvidence } from './activity-rules.js';
import type { AgentActivity } from '../model.js';
import type { ForegroundAgent } from './agents.js';
import type { TerminalScreen } from './contracts.js';

type Evidence = ActivityEvidence & { key: string };

function evidence(screen: TerminalScreen, agent: string): Evidence {
  const text = screen.text();
  const input = { text, title: screen.title, progress: screen.progress ?? '' };

  return {
    ...detectActivity(agent, input),
    key: input.title + '\n' + input.progress + '\n' + text,
  };
}

/** Agent awareness is independent of the shell's process lifecycle. */
export class ActivityTracker {
  private _agentId: string | null = null;
  private _agentName = '';
  private _lastOutput = -Infinity;
  private _submitted = -Infinity;
  private _submittedScreen = '';
  private _state: AgentActivity | null = null;

  public output(now: number = Date.now()): void {
    this._lastOutput = now;
  }

  public input(
    data: string,
    screen: TerminalScreen,
    now: number = Date.now(),
  ): void {
    // Bracketed paste edits the prompt; it does not submit a turn.
    // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
    const keys = data.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/gu, '');
    // eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
    if (this._agentId && /[\r\n\x03]/u.test(keys)) {
      this._submitted = now;
      this._submittedScreen = evidence(screen, this._agentName).key;
      this._state = 'working';
    }
  }

  public evaluate(
    agent: ForegroundAgent | null,
    screen: TerminalScreen,
    now: number = Date.now(),
  ): AgentActivity | null {
    const agentId = agent?.id ?? null;
    if (agentId !== this._agentId) {
      this._agentId = agentId;
      this._agentName = agent?.name ?? '';
      this._submitted = -Infinity;
      this._submittedScreen = '';
      this._state = null;
    }

    if (!agent) {
      this._state = null;

      return this._state;
    }

    const signal = evidence(screen, agent.name);
    if (signal.preserve) {
      return this._state ?? 'idle';
    }

    // Avoid classifying the old approval/prompt as live immediately after Enter.
    if (this._submitting(signal, now)) {
      this._state = 'working';

      return this._state;
    }

    if (signal.state) {
      this._state = signal.state;

      return this._state;
    }

    this._state = now - this._lastOutput < 1500 ? 'working' : 'idle';

    return this._state;
  }
  private _submitting(signal: Evidence, now: number): boolean {
    const { key } = signal;
    if (signal.state === 'waiting' && key !== this._submittedScreen) {
      return false;
    }

    return (
      now - this._submitted < 500 ||
      (key === this._submittedScreen && now - this._submitted < 3000)
    );
  }
}
