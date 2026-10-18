# Ducks

A terminal multiplexer for CLI agents. Organize working directories into Places, run agents in separate tabs, and see their activity status in one interface.

## Requirements

- Linux or macOS, Node.js ≥22.13, and npm.
- An interactive terminal of at least 80×24 cells.
- CLI agents installed and authenticated separately.

Installing `node-pty` may require Python and C++ build tools (Xcode Command Line Tools on macOS).

## Run

From the project directory:

```sh
npm install
npm start -- --place /path/to/project
```

`npm install` builds the application automatically. In the opened shell, run your agent command, such as `codex` or `claude`.

Press `Ctrl+B`, then `a` to open another terminal, `s` to add a Place, `?` for help, or `q` to quit.

To run directly from source during development:

```sh
npm run dev -- --place /path/to/project
```

After changing source files, run `npm run build` before using `npm start` again.
