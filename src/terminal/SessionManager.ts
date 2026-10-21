import { defined } from '../defined.js';
import { ActivityTracker } from './ActivityTracker.js';
import {
  identifyAgent,
  processNameFromArgv,
  readForegroundProcess,
} from './agents.js';
import { readProcessDirectory } from './directory.js';
import { pipeOutput } from './output.js';
import {
  readSessionGroups,
  signalGroup,
  stopProcessGroups,
} from './processes.js';
import { ThreadNameTracker } from './ThreadNameTracker.js';
import type { AgentDefinition, Place, Profile } from '../model.js';
import type { ForegroundAgent, ForegroundProcessReader } from './agents.js';
import type { ScreenFactory, Session, SpawnPty } from './contracts.js';
import type { DirectoryReader } from './directory.js';
import type { ProcessGroupReader, SignalGroup } from './processes.js';

export class SessionManager {
  public readonly sessions: Map<string, Session> = new Map<string, Session>();
  private readonly _stopping = new Map<string, Promise<void>>();
  private _shuttingDown = false;
  private readonly _output = new Map<string, { dispose(): void }>();
  private readonly _directories = new Map<
    string,
    {
      directory: string;
      timer: ReturnType<typeof setInterval>;
      checking: Promise<void> | null;
    }
  >();
  private readonly _activities = new Map<
    string,
    {
      tracker: ActivityTracker;
      thread: ThreadNameTracker;
      place: Place;
      agent: ForegroundAgent | null;
      processName: string;
      fallbackName: string;
      timer: ReturnType<typeof setInterval>;
      checking: Promise<void> | null;
    }
  >();
  private _cols = 80;
  private _rows = 24;
  private readonly _initialDirectories = new Map<string, string>();
  public constructor(
    private readonly _spawn: SpawnPty,
    private readonly _createScreen: ScreenFactory,
    private readonly _changed: () => void,
    private readonly _signal: SignalGroup = signalGroup,
    private readonly _graceMs = 2000,
    private readonly _readDirectory: DirectoryReader = readProcessDirectory,
    private readonly _readProcess: ForegroundProcessReader = readForegroundProcess,
    private readonly _readGroups: ProcessGroupReader = readSessionGroups,
  ) {}

  public onDirectoryChange(
    handler: (id: string, directory: string) => void,
  ): void {
    this._directoryChanged = handler;
  }
  public onExit(handler: (id: string) => void): void {
    this._processExited = handler;
  }

  public async currentDirectory(id: string, fallback: string): Promise<string> {
    const child = this.sessions.get(id)?.process;
    if (child) {
      try {
        const directory = await this._readDirectory(child.pid);
        // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
        if (directory && !/[\x00-\x1f\x7f]/u.test(directory)) {
          return directory;
        }
      } catch {
        /* Fall back to the last known directory if the process exits. */
      }
    }

    return (
      this._directories.get(id)?.directory ??
      this._initialDirectories.get(id) ??
      fallback
    );
  }

  public refreshDirectory(id: string): Promise<void> {
    const tracking = this._directories.get(id),
      child = this.sessions.get(id)?.process;
    if (!tracking || !child) {
      return Promise.resolve();
    }

    if (tracking.checking) {
      return tracking.checking;
    }

    const operation = (async () => {
      try {
        const directory = await this._readDirectory(child.pid);
        if (
          this._directories.get(id) !== tracking ||
          this.sessions.get(id)?.process !== child
        ) {
          return;
        }

        if (
          directory &&
          directory !== tracking.directory &&
          // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
          !/[\x00-\x1f\x7f]/u.test(directory)
        ) {
          tracking.directory = directory;
          this._directoryChanged(id, directory);
        }
      } catch {
        /* A process may exit while its directory is being read. */
      } finally {
        tracking.checking = null;
      }
    })();

    tracking.checking = operation;

    return operation;
  }

  public refreshActivity(id: string): Promise<void> {
    const tracking = this._activities.get(id),
      child = this.sessions.get(id)?.process;
    if (!tracking || !child) {
      return Promise.resolve();
    }

    if (tracking.checking) {
      return tracking.checking;
    }

    const operation = (async () => {
      try {
        const observed = await this._readProcess(child);
        if (
          this._activities.get(id) !== tracking ||
          this.sessions.get(id)?.process !== child
        ) {
          return;
        }

        if (observed !== undefined) {
          tracking.agent = observed?.agent ?? null;
          tracking.processName = observed?.name ?? tracking.fallbackName;
        }

        this._updateActivity(id);
      } catch {
        /* Observation failure must never interrupt a terminal. */
      } finally {
        tracking.checking = null;
      }
    })();

    tracking.checking = operation;

    return operation;
  }

  public ensure(agent: AgentDefinition): Session {
    let session = this.sessions.get(agent.id);
    if (!session) {
      session = {
        id: agent.id,
        screen: this._createScreen(this._cols, this._rows),
        status: 'stopped',
        error: null,
        process: null,
        stopRequested: false,
        shutdownSignal: 'SIGTERM',
        activity: null,
        threadName: null,
        processName: null,
      };
      this.sessions.set(agent.id, session);
    }

    return session;
  }

  public start(agent: AgentDefinition, place: Place, profile: Profile): void {
    if (this._shuttingDown || this._stopping.has(agent.id)) {
      return;
    }

    let session = this.ensure(agent);
    if (session.process) {
      return;
    }

    session.screen.dispose();
    session = {
      ...session,
      screen: this._createScreen(this._cols, this._rows),
      status: 'starting',
      error: null,
      stopRequested: false,
      activity: null,
      threadName: null,
      processName: processNameFromArgv([profile.executable, ...profile.args]),
      shutdownSignal: profile.id === 'shell' ? 'SIGHUP' : 'SIGTERM',
    };
    this.sessions.set(agent.id, session);
    this._changed();

    const current = session;

    try {
      const child = this._spawn(
        profile,
        place.directory,
        this._cols,
        this._rows,
      );

      this._initialDirectories.set(agent.id, place.directory);
      current.process = child;

      const tracker = new ActivityTracker();
      const name =
        profile.id === 'shell'
          ? null
          : identifyAgent([profile.executable, ...profile.args]);

      const timer = setInterval(() => {
        void this.refreshActivity(agent.id);
      }, 300);
      timer.unref();
      this._activities.set(agent.id, {
        tracker,
        thread: new ThreadNameTracker(),
        place,
        processName: defined(current.processName),
        fallbackName: defined(current.processName),
        agent: name ? { id: `${child.pid}:${name}`, name } : null,
        timer,
        checking: null,
      });

      this._updateActivity(agent.id);
      void this.refreshActivity(agent.id);

      if (agent.kind === 'shell') {
        const timer = setInterval(() => {
          void this.refreshDirectory(agent.id);
        }, 400);
        timer.unref();
        this._directories.set(agent.id, {
          directory: place.directory,
          timer,
          checking: null,
        });
      }

      current.screen.onResponse((data) => {
        if (current.process === child) {
          child.write(data);
        }
      });
      current.screen.onRefresh?.(() => {
        if (current.process === child) {
          this._changed();
        }
      });

      const dataSubscription = pipeOutput(
        child,
        current.screen,
        () => {
          tracker.output();
        },
        () => {
          this._updateActivity(agent.id);
          this._changed();
        },
      );

      this._output.set(agent.id, dataSubscription);

      const exitSubscription = child.onExit(({ exitCode }) => {
        this._untrackDirectory(agent.id);
        this._untrackActivity(agent.id);

        current.process = null;
        current.status = exitCode === 0 ? 'exited' : 'error';
        if (current.stopRequested) {
          current.status = 'stopped';
        }

        if (!current.stopRequested && exitCode !== 0) {
          current.error = `Process exited with code ${exitCode}`;
        }

        dataSubscription.dispose();
        this._output.delete(agent.id);
        exitSubscription.dispose();

        if (!current.stopRequested && !this._shuttingDown) {
          this._processExited(agent.id);
        }

        this._changed();
      });

      current.status = 'running';
    } catch (error) {
      current.status = 'error';
      current.error = `Cannot start ${profile.executable}: ${error instanceof Error ? error.message : String(error)}`;
    }

    this._changed();
  }

  public write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session?.process || session.stopRequested) {
      return;
    }

    session.screen.scrollToBottom();
    this._activities.get(id)?.tracker.input(data, session.screen);
    session.process.write(data);
    this._updateActivity(id);
    this._changed();
  }

  public resize(cols: number, rows: number): void {
    cols = Math.max(2, cols);
    rows = Math.max(1, rows);
    if (cols === this._cols && rows === this._rows) {
      return;
    }

    this._cols = cols;
    this._rows = rows;

    for (const session of this.sessions.values()) {
      session.screen.resize(cols, rows);
      session.process?.resize(cols, rows);
    }

    this._changed();
  }

  public stop(id: string): Promise<void> {
    const existing = this._stopping.get(id);
    if (existing) {
      return existing;
    }

    const session = this.sessions.get(id);
    if (!session?.process) {
      return Promise.resolve();
    }

    const child = session.process;
    this._untrackDirectory(id);
    this._untrackActivity(id);
    session.stopRequested = true;

    // Drain the PTY without rendering shell/job diagnostics during teardown.
    this._output.get(id)?.dispose();
    this._output.delete(id);

    const operation = (async () => {
      await stopProcessGroups(
        child.pid,
        session.shutdownSignal,
        this._graceMs,
        this._signal,
        this._readGroups,
      );

      if (session.process === child) {
        session.process = null;
        session.status = 'stopped';
      }

      this._changed();
    })().finally(() => this._stopping.delete(id));

    this._stopping.set(id, operation);

    return operation;
  }

  public async remove(id: string): Promise<void> {
    await this.stop(id);

    this.sessions.get(id)?.screen.dispose();
    this.sessions.delete(id);
    this._initialDirectories.delete(id);
    this._changed();
  }

  public async shutdown(): Promise<void> {
    this._shuttingDown = true;

    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.stop(id)),
    );
    for (const session of this.sessions.values()) {
      session.screen.dispose();
    }

    this.sessions.clear();
    this._initialDirectories.clear();

    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      throw failure.reason;
    }
  }
  private _directoryChanged: (id: string, directory: string) => void = () => {
    /* No callback registered. */
  };
  private _processExited: (id: string) => void = () => {
    /* No callback registered. */
  };

  private _untrackDirectory(id: string): void {
    const tracking = this._directories.get(id);
    if (tracking) {
      clearInterval(tracking.timer);
    }

    this._directories.delete(id);
  }

  private _updateActivity(id: string): void {
    const tracking = this._activities.get(id),
      session = this.sessions.get(id);
    if (!tracking || !session?.process || session.stopRequested) {
      return;
    }

    const next = tracking.tracker.evaluate(tracking.agent, session.screen);
    const threadName = tracking.thread.update(
      tracking.agent,
      session.screen.title,
      tracking.place.directory,
    );
    if (
      next !== session.activity ||
      threadName !== session.threadName ||
      tracking.processName !== session.processName
    ) {
      session.activity = next;
      session.threadName = threadName;
      session.processName = tracking.processName;
      this._changed();
    }
  }

  private _untrackActivity(id: string): void {
    const tracking = this._activities.get(id);
    if (tracking) {
      clearInterval(tracking.timer);
    }

    this._activities.delete(id);

    const session = this.sessions.get(id);
    if (session) {
      session.activity = null;
      session.threadName = null;
      session.processName = null;
    }
  }
}
