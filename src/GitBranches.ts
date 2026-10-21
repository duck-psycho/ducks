import { readGitStatus } from './git.js';
import type { GitStatus, GitStatusReader } from './git.js';
import type { Place } from './model.js';
/** Runtime metadata stays out of saved configuration. Reads never block input. */
export class GitBranches {
  private readonly _entries = new Map<
    string,
    {
      directory: string;
      status: GitStatus | undefined;
      pending: Promise<void> | null;
    }
  >();
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _places: (() => ReadonlyArray<Place>) | null = null;
  private _disposed = false;
  public constructor(
    private readonly _changed: () => void,
    private readonly _read: GitStatusReader = readGitStatus,
  ) {}

  public get(place: Place): string | undefined {
    return this.getStatus(place)?.branch;
  }

  public getStatus(place: Place): GitStatus | undefined {
    const entry = this._entries.get(place.id);

    return entry?.directory === place.directory ? entry.status : undefined;
  }

  public async refresh(places: ReadonlyArray<Place>): Promise<void> {
    if (this._disposed) {
      return;
    }

    const ids = new Set(places.map((p) => p.id));
    for (const id of this._entries.keys()) {
      if (!ids.has(id)) {
        this._entries.delete(id);
      }
    }

    await Promise.all(
      places.map((place) => {
        let entry = this._entries.get(place.id);
        if (entry?.directory !== place.directory) {
          const hadBranch = Boolean(entry?.status);
          entry = {
            directory: place.directory,
            status: undefined,
            pending: null,
          };
          this._entries.set(place.id, entry);
          if (hadBranch) {
            this._changed();
          }
        }

        if (entry.pending) {
          return entry.pending;
        }

        const current = entry;
        current.pending = Promise.resolve()
          .then(() => this._read(current.directory))
          .catch((): undefined => undefined)
          .then((status) => {
            if (this._disposed || this._entries.get(place.id) !== current) {
              return;
            }

            if (
              current.status?.branch !== status?.branch ||
              current.status?.dirty !== status?.dirty ||
              current.status?.ahead !== status?.ahead
            ) {
              current.status = status;
              this._changed();
            }
          })
          .finally(() => {
            current.pending = null;
          });

        return current.pending;
      }),
    );
  }

  public update(): void {
    if (this._places) {
      void this.refresh(this._places());
    }
  }

  public watch(places: () => ReadonlyArray<Place>): void {
    if (this._disposed || this._timer) {
      return;
    }

    this._places = places;
    this.update();
    this._timer = setInterval(() => {
      this.update();
    }, 1000);
    this._timer.unref();
  }

  public dispose(): void {
    this._disposed = true;
    if (this._timer) {
      clearInterval(this._timer);
    }

    this._timer = null;
    this._places = null;
    this._entries.clear();
  }
}
