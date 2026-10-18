import type { PtyProcess } from '../src/terminal/contracts.js';
export class FakePty implements PtyProcess {
  public readonly pid = 2147483000;
  public writes: string[] = [];
  public write(data: string): void {
    this.writes.push(data);
  }
  public pause(): void {
    /* Test stub. */
  }
  public resume(): void {
    /* Test stub. */
  }
  public resize(): void {
    /* Test stub. */
  }
  public onData(handler: (data: string) => void): { dispose(): void } {
    this._data = handler;

    return {
      dispose: () => {
        this._data = () => {
          /* Test stub. */
        };
      },
    };
  }
  public onExit(
    handler: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void } {
    this._exited = handler;

    return {
      dispose: () => {
        this._exited = () => {
          /* Test stub. */
        };
      },
    };
  }
  public output(data: string): void {
    this._data(data);
  }
  public exit(exitCode = 0): void {
    this._exited({ exitCode });
  }
  private _data: (data: string) => void = () => {
    /* Test stub. */
  };
  private _exited: (event: { exitCode: number; signal?: number }) => void =
    () => {
      /* Test stub. */
    };
}
