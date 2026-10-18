import { basename } from 'node:path';
import { defined } from '../defined.js';
import type { ForegroundAgent } from './agents.js';

/** Keep the last known thread name through temporary status-only titles. */
export class ThreadNameTracker {
  private _agentId: string | null = null;
  private _name: string | null = null;
  private _lastTitle = '';
  private _staleTitle: string | null = null;
  private _awaitingTitleChange = false;

  public static fromTitle(
    agent: ForegroundAgent,
    title: string,
    directory: string,
  ): string | null {
    const decorated = title
      // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
      .replace(/[\x00-\x1f\x7f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    let name = decorated
      .replace(/^(?:[●✳✻✽✢✶*\u2800-\u28ff\u25d0-\u25d3]\s*)+/u, '')
      .replace(
        /^(?:\[\s*[!.]\s*\]\s*)?Action Required(?:\s*[|:—–-]\s*|\s*$)/iu,
        '',
      )
      .trim();
    const prefixed =
      /^(?:codex|claude(?: code)?|thread|session)\s*[:—–-]\s*/iu.test(name);

    name = name.replace(
      /^(?:codex|claude(?: code)?|thread|session)\s*[:—–-]\s*/iu,
      '',
    );

    // eslint-disable-next-line sonarjs/super-linear-regex -- Parse the whitespace-delimited separator in OSC thread titles.
    const parts = name.split(/\s+\|\s+/u);
    // Codex's default is activity + thread-name | project-name. A single
    // undecorated segment can be just the project, not an actual named thread.
    if (agent.name === 'Codex' && parts.length < 2 && !prefixed) {
      return null;
    }

    if (parts.length > 1) {
      name = defined(parts[0]).trim();
    }

    const generic =
      // eslint-disable-next-line sonarjs/regex-complexity -- Recognize supported generic agent and status titles.
      /^(?:codex|claude(?: code)?|gemini|opencode|cursor(?: agent)?|copilot|droid|amp|grok|pi|hermes|kimi|kiro(?: cli)?)(?:\s+v?\d[\w.-]*)?$/iu;
    if (
      !name ||
      generic.test(name) ||
      // eslint-disable-next-line sonarjs/regex-complexity -- Recognize supported generic agent and status titles.
      /^(?:action required|working|idle|waiting(?: for input)?|thinking|processing|generating(?: title)?|untitled(?: thread)?|new (?:thread|session)|tasks \d+\/\d+|v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/iu.test(
        name,
      )
    ) {
      return null;
    }

    if (projectTitle(name, directory)) {
      return null;
    }

    return name;
  }

  public update(
    agent: ForegroundAgent | null,
    title: string,
    directory: string,
  ): string | null {
    if (!agent) {
      if (this._agentId) {
        this._staleTitle = this._lastTitle;
      }

      if (title !== this._staleTitle) {
        this._staleTitle = null;
      }

      this._agentId = null;
      this._name = null;
      this._lastTitle = title;
      this._awaitingTitleChange = false;

      return null;
    }

    if (agent.id !== this._agentId) {
      // Do not inherit an old agent/shell title when a new foreground job starts.
      this._awaitingTitleChange =
        Boolean(title) &&
        (title === this._staleTitle ||
          (this._agentId !== null && title === this._lastTitle));
      this._agentId = agent.id;
      this._name = null;
    }

    if (title !== this._lastTitle) {
      this._awaitingTitleChange = false;
    }

    this._lastTitle = title;
    if (!this._awaitingTitleChange) {
      this._updateName(agent, title, directory);
    }

    return this._name;
  }

  private _updateName(
    agent: ForegroundAgent,
    title: string,
    directory: string,
  ): void {
    const next = ThreadNameTracker.fromTitle(agent, title, directory);
    if (next) {
      this._name = next;
    } else {
      const statusOnly =
        // eslint-disable-next-line sonarjs/super-linear-regex -- Recognize temporary OSC status titles without clearing the thread name.
        /^(?:[●✳✻✽✢✶*\u2800-\u28ff\u25d0-\u25d3]\s*)*(?:(?:\[\s*[!.]\s*\]\s*)?Action Required)?\s*$/iu.test(
          title,
        );
      if (!statusOnly || !title.trim()) {
        this._name = null;
      }
    }
  }
}

function projectTitle(name: string, directory: string): boolean {
  return (
    name.toLowerCase() === basename(directory).toLowerCase() ||
    name === directory ||
    /^(?:\/|~\/)/u.test(name)
  );
}
