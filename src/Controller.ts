import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { canonicalDirectory } from './config.js';
import { defined } from './defined.js';
import { GitBranches } from './GitBranches.js';
import { PromptEditor } from './PromptEditor.js';
import { SHORTCUTS, shortcutVisibleRows } from './shortcuts.js';
import { copyTerminalText } from './terminal/clipboard.js';
import { shellProfile } from './terminal/directory.js';
import {
  editorProfile,
  fileCandidates,
  fileLinkAt,
  resolveTextFile,
} from './terminal/files.js';
import {
  encodeKey,
  encodeMouse,
  encodePaste,
  NO_MODS,
} from './terminal/input.js';
import { TerminalSelection } from './terminal/TerminalSelection.js';
import { getTheme, THEMES } from './themes.js';
import { promptWidth, searchVisibleRows, inside, layout } from './ui/layout.js';
import type { AgentDefinition, Config, Place, Profile } from './model.js';
import type {
  Session,
  TerminalModes,
  TerminalTextCell,
  TerminalTextPosition,
} from './terminal/contracts.js';
import type { FileLink } from './terminal/files.js';
import type { InputEvent } from './terminal/input.js';
import type { SessionManager } from './terminal/SessionManager.js';
import type { Theme } from './themes.js';
import type { Rect } from './ui/layout.js';
import type {
  TreeRow,
  Modal,
  Menu,
  Settings,
  ShortcutHelp,
  Prompt,
  Search,
} from './ui/state.js';

type SearchResult = TreeRow & { name: string; placeName: string };

type Persistence = {
  save(config: Config): Promise<void>;
  flush(): Promise<void>;
};

type FileHover = {
  session: Session;
  x: number;
  y: number;
  text: string;
  link: FileLink;
  file: string | null;
};

export class Controller {
  public cols = 100;
  public rows = 30;
  public focus: 'sidebar' | 'terminal' = 'sidebar';
  public treeIndex = 0;
  public treeOffset = 0;
  public collapsed: Set<string> = new Set<string>();
  public modal: Modal | null = null;
  public busy = false;
  public closing = false;
  public message = '';
  public prefixUntil = 0;
  public tabHits: { rect: Rect; agentId: string }[] = [];
  public modalHits: { rect: Rect; index: number }[] = [];
  private _prefixTimer: ReturnType<typeof setTimeout> | null = null;
  private _fileClick = false;
  private _sidebarDrag: number | null = null;
  private _pointerEvent: Extract<InputEvent, { kind: 'mouse' }> | null = null;
  private readonly _editorSources = new Map<string, string>();
  private _fileHover: FileHover | null = null;
  private readonly _promptDrafts = new Map<string, PromptEditor>();
  private _selection: { session: Session; value: TerminalSelection } | null =
    null;
  public constructor(
    public readonly config: Config,
    public readonly sessions: SessionManager,
    private readonly _store: Persistence,
    private readonly _changed: () => void,
    private readonly _exit: () => Promise<void>,
    public readonly git: GitBranches = new GitBranches(_changed),
    private readonly _copyText: (text: string) => void = copyTerminalText,
  ) {
    for (const p of config.places) {
      for (const agent of p.agents) {
        sessions.ensure(agent);
      }
    }

    sessions.onDirectoryChange((id, directory) => {
      const place = config.places.find((p) =>
        p.agents.some((a) => a.id === id && a.kind === 'shell'),
      );
      if (!place) {
        return;
      }

      place.directory = directory;
      if (place.autoName) {
        place.name = basename(directory) || directory;
      }

      this.git.update();
      this._persist();
      this._changed();
    });
    sessions.onExit((id) => {
      if (this.closing) {
        return;
      }

      this._forgetAgent(id);
      void sessions.remove(id).catch((error: unknown) => {
        this.message = `Close failed: ${String(error)}`;
        this._changed();
      });
    });

    this._syncTreeIndex();
    this.sessions.resize(this.geometry.terminal.w, this.geometry.terminal.h);
  }
  public get geometry(): ReturnType<typeof layout> {
    return layout(this.cols, this.rows, this.config.sidebarWidth);
  }
  public get pointerShape(): '' | 'ew-resize' {
    if (this.closing || this.modal || this.geometry.small) {
      return '';
    }

    const event = this._pointerEvent;
    const hovering = event && !event.buttons && this._onDivider(event);

    return this._sidebarDrag !== null || hovering ? 'ew-resize' : '';
  }
  public get place(): Place | undefined {
    return this.config.places.find((p) => p.id === this.config.activePlaceId);
  }
  public get agent(): AgentDefinition | undefined {
    const place = this.place;

    return place?.agents.find((a) => a.id === place.activeAgentId);
  }
  public get session(): Session | undefined {
    const agent = this.agent;

    return agent ? this.sessions.sessions.get(agent.id) : undefined;
  }
  public get prefix(): boolean {
    return this.prefixUntil > Date.now();
  }
  public get theme(): Theme {
    return getTheme(
      this.modal?.kind === 'settings' ? this.modal.theme : this.config.theme,
    );
  }

  public get hoveredFileCells(): TerminalTextCell[] {
    const hover = this._fileHover;
    if (
      !hover?.file ||
      hover.session !== this.session ||
      this.modal ||
      this.closing
    ) {
      return [];
    }

    const position = hover.session.screen.textAt(hover.x, hover.y);
    if (position?.text !== hover.text) {
      return [];
    }

    return position.cells.filter(
      (cell) =>
        cell.index < hover.link.end &&
        cell.index + cell.length > hover.link.start,
    );
  }

  public get terminalSelection(): TerminalSelection | null {
    return this._selection?.session === this.session && !this.modal
      ? (this._selection?.value ?? null)
      : null;
  }

  public tree(): TreeRow[] {
    return this.config.places.flatMap((p) => [
      { placeId: p.id, agentId: null },
      ...(this.collapsed.has(p.id)
        ? []
        : p.agents.map((a) => ({ placeId: p.id, agentId: a.id }))),
    ]);
  }
  public agentName(agent: AgentDefinition): string {
    const session = this.sessions.sessions.get(agent.id);

    return session?.threadName ?? session?.processName ?? agent.name;
  }
  public searchResults(): SearchResult[] {
    const modal = this.modal;
    if (modal?.kind !== 'search') {
      return [];
    }

    const query = modal.editor.text.trim().normalize('NFC').toLowerCase();
    const results = this.config.places.flatMap((place) =>
      [
        {
          placeId: place.id,
          agentId: null,
          name: place.name,
          placeName: place.name,
        },
        ...place.agents.map((agent) => ({
          placeId: place.id,
          agentId: agent.id,
          name: this.agentName(agent),
          placeName: place.name,
        })),
      ].filter((result) =>
        result.name.normalize('NFC').toLowerCase().includes(query),
      ),
    );

    modal.selected = Math.max(0, Math.min(modal.selected, results.length - 1));

    return results;
  }
  public selectPlace(id: string): void {
    if (!this.config.places.some((p) => p.id === id)) {
      return;
    }

    this._clearFileHover();
    this._clearSelection();

    this.config.activePlaceId = id;

    this._syncTreeIndex();
    this._persist();
    this._changed();
  }
  public selectAgent(placeId: string, agentId: string): void {
    const place = this.config.places.find((p) => p.id === placeId);
    if (!place?.agents.some((a) => a.id === agentId)) {
      return;
    }

    this._clearFileHover();
    this._clearSelection();

    this.config.activePlaceId = placeId;
    place.activeAgentId = agentId;
    this.collapsed.delete(placeId);

    this._syncTreeIndex();
    this._persist();
    this._changed();
  }

  public async addPlace(directory: string, name?: string): Promise<Place> {
    const canonical = await canonicalDirectory(directory);
    const place = this.config.places.find((p) => p.directory === canonical);
    if (!place) {
      return this.createPlace(canonical, name);
    }

    this.selectPlace(place.id);

    return place;
  }

  public async createPlace(
    directory: string = process.cwd(),
    name?: string,
  ): Promise<Place> {
    const canonical = await canonicalDirectory(directory);
    const profile = this._getShellProfile();
    const customName = name?.trim() ?? '';
    const agent = {
      id: randomUUID(),
      name: 'Shell',
      profileId: profile.id,
      kind: 'shell' as const,
    };
    const place: Place = {
      id: randomUUID(),
      name: customName || basename(canonical) || canonical,
      directory: canonical,
      agents: [agent],
      activeAgentId: agent.id,
      autoName: !customName,
    };

    this.config.places.push(place);
    this.modal = null;
    this.git.update();

    this.selectAgent(place.id, agent.id);
    this.sessions.start(agent, place, profile);
    this.focus = 'terminal';
    this._changed();

    return place;
  }
  public restoreTerminals(): void {
    if (this.closing || !this.config.places.some((p) => p.agents.length)) {
      return;
    }

    const profile = this._getShellProfile();
    let migrated = false;
    for (const place of this.config.places) {
      if (
        place.agents.length &&
        !place.agents.some((a) => a.kind === 'shell')
      ) {
        defined(place.agents[0]).kind = 'shell';
        migrated = true;
      }

      for (const agent of place.agents) {
        if (agent.profileId !== profile.id) {
          agent.profileId = profile.id;
          migrated = true;
        }

        this.sessions.start(agent, place, profile);
      }
    }

    this.focus = this.agent ? 'terminal' : 'sidebar';
    if (migrated) {
      this._persist();
    }

    this._changed();
  }
  public async quit(): Promise<void> {
    if (this.closing) {
      return;
    }

    this.closing = true;
    this.modal = null;
    this.message = 'Closing terminals…';
    this._changed();

    this.git.dispose();
    if (this._prefixTimer) {
      clearTimeout(this._prefixTimer);
    }

    try {
      await this.sessions.shutdown();
      await this._store.save(this.config);
      await this._store.flush();
    } finally {
      await this._exit();
    }
  }

  public handle(event: InputEvent): void {
    const pointerShape = this.pointerShape;
    if (event.kind === 'mouse') {
      this._pointerEvent = event;
    } else if (
      event.kind === 'resize' ||
      (event.kind === 'key' && event.key === 'focusout')
    ) {
      this._pointerEvent = null;
    }

    this._handle(event);
    if (this.pointerShape !== pointerShape) {
      this._changed();
    }
  }

  private _handle(event: InputEvent): void {
    if (this.closing) {
      return;
    }

    if (event.kind === 'modifiers') {
      if (!event.mods.ctrl) {
        this._clearFileHover();
      }

      return;
    }

    if (event.kind !== 'mouse' || this.modal) {
      this._clearFileHover();
      this._finishSidebarDrag();
    } else if (this._resizeSidebar(event)) {
      return;
    }

    if (this._selectionInput(event)) {
      return;
    }

    if (event.kind === 'resize') {
      this._resize(event);

      return;
    }

    if (this.modal) {
      this._modalInput(event);

      return;
    }

    this._routeInput(event);
  }

  private _clearFileHover(): void {
    const highlighted = Boolean(this._fileHover?.file);
    this._fileHover = null;
    if (highlighted) {
      this._changed();
    }
  }

  private _finishSidebarDrag(): void {
    const original = this._sidebarDrag;
    this._sidebarDrag = null;
    if (original !== null && original !== this.config.sidebarWidth) {
      this._persist();
    }
  }

  private _startSidebarDrag(
    event: Extract<InputEvent, { kind: 'mouse' }>,
  ): boolean {
    const geometry = this.geometry;
    if (
      geometry.small ||
      this._fileClick ||
      event.action !== 3 ||
      event.buttons !== 1 ||
      !this._onDivider(event)
    ) {
      return false;
    }

    this._sidebarDrag = this.config.sidebarWidth;
    this._clearFileHover();
    this._clearSelection();

    return true;
  }

  private _onDivider(event: Extract<InputEvent, { kind: 'mouse' }>): boolean {
    const divider = {
      x: this.geometry.sidebar.w,
      y: 0,
      w: 1,
      h: this.rows,
    };

    return inside(divider, event.x, event.y);
  }

  private _resizeSidebar(
    event: Extract<InputEvent, { kind: 'mouse' }>,
  ): boolean {
    if (this._sidebarDrag === null) {
      return this._startSidebarDrag(event);
    }

    const geometry = this.geometry;
    if ([2, 4].includes(event.action) && event.x !== geometry.sidebar.w) {
      const resized = layout(this.cols, this.rows, event.x);
      if (resized.sidebar.w !== geometry.sidebar.w) {
        this.config.sidebarWidth = resized.sidebar.w;
        this.sessions.resize(resized.terminal.w, resized.terminal.h);
        this.tabHits = [];
        this._changed();
      }
    }

    if (event.action === 4 || (event.action === 1 && !event.buttons)) {
      this._finishSidebarDrag();
    }

    return true;
  }

  private _clearSelection(): void {
    if (!this._selection) {
      return;
    }

    this._selection = null;
    this._changed();
  }

  private _selectionInput(event: InputEvent): boolean {
    const selection = this.terminalSelection;
    if (event.kind === 'mouse') {
      if ([3, 5].includes(event.action)) {
        this._clearSelection();
      }

      return false;
    }

    this._clearSelection();
    if (!selection || selection.empty || event.kind !== 'key') {
      return false;
    }

    if (event.key === 'c' && event.mods.ctrl) {
      if (selection.text) {
        this._copyText(selection.text);
      }

      return true;
    }

    return event.key === 'escape';
  }

  private _hoverFile(event: Extract<InputEvent, { kind: 'mouse' }>): void {
    const area = this.geometry.terminal;
    const session = this.session,
      place = this.place;
    if (!this._canHoverFile(event, area) || !session || !place) {
      this._clearFileHover();

      return;
    }

    const x = event.x - area.x,
      y = event.y - area.y;
    const position = session.screen.textAt(x, y);
    const link = fileLinkAt(position);
    if (!link || !position) {
      this._clearFileHover();

      return;
    }

    const previous = this._fileHover;
    if (this._sameFileHover(previous, session, position, link)) {
      previous.x = x;
      previous.y = y;
      if (previous.file) {
        this._changed();
      }

      return;
    }

    this._clearFileHover();

    const hover: FileHover = {
      session,
      x,
      y,
      text: position.text,
      link,
      file: null,
    };

    this._fileHover = hover;
    void (async () => {
      try {
        const directory = await this.sessions.currentDirectory(
          session.id,
          place.directory,
        );
        const file = await resolveTextFile(link.candidates, directory);
        if (
          this._fileHover !== hover ||
          this.session !== session ||
          this.closing
        ) {
          return;
        }

        hover.file = file;
        if (file) {
          this._changed();
        }
      } catch {
        /* Unreadable files are not offered as clickable links. */
      }
    })();
  }
  private _syncTreeIndex(): void {
    const rows = this.tree();
    const index = rows.findIndex(
      (r) =>
        r.placeId === this.config.activePlaceId &&
        r.agentId === (this.place?.activeAgentId ?? null),
    );

    this.treeIndex = Math.max(
      0,
      index < 0
        ? rows.findIndex((r) => r.placeId === this.config.activePlaceId)
        : index,
    );
    this._ensureVisible();
  }
  private _ensureVisible(): void {
    const h = this.geometry.sidebar.h;
    this.treeIndex = Math.max(
      0,
      Math.min(this.treeIndex, this.tree().length - 1),
    );
    this.treeOffset = Math.max(
      0,
      Math.min(this.treeOffset, Math.max(0, this.tree().length - h)),
    );
    if (this.treeIndex < this.treeOffset) {
      this.treeOffset = this.treeIndex;
    }

    if (this.treeIndex >= this.treeOffset + h) {
      this.treeOffset = Math.max(0, this.treeIndex - h + 1);
    }
  }
  private _persist(): void {
    void this._store.save(this.config).catch((error: unknown) => {
      this.message = `Save failed: ${String(error)}`;
      this._changed();
    });
  }
  private _activateRow(): void {
    const row = this.tree()[this.treeIndex];
    if (!row) {
      return;
    }

    if (row.agentId) {
      this.selectAgent(row.placeId, row.agentId);
    } else {
      this.config.activePlaceId = row.placeId;
      this._persist();
      this._changed();
    }
  }
  private _moveTree(delta: number): void {
    this.focus = 'sidebar';
    this.treeIndex += delta;
    this._ensureVisible();
    this._activateRow();
    this._changed();
  }
  private _togglePlace(): void {
    const row = this.tree()[this.treeIndex];
    if (!row) {
      return;
    }

    if (this.collapsed.has(row.placeId)) {
      this.collapsed.delete(row.placeId);
    } else {
      this.collapsed.add(row.placeId);
    }

    const index = this.tree().findIndex(
      (r) => r.placeId === row.placeId && r.agentId === null,
    );
    this.treeIndex = Math.max(0, index);
    this._ensureVisible();
    this._changed();
  }
  private _cycleTab(delta: number): void {
    const place = this.place;
    if (!place?.agents.length) {
      return;
    }

    const index = place.agents.findIndex((a) => a.id === place.activeAgentId);
    const next =
      place.agents[(index + delta + place.agents.length) % place.agents.length];
    if (next) {
      this.selectAgent(place.id, next.id);
    }
  }
  private _selectTab(index: number): void {
    const place = this.place;
    const agent = place?.agents[index];
    if (place && agent) {
      this.selectAgent(place.id, agent.id);
    }
  }
  private _menu(title: string, choices: Menu['choices']): void {
    this.modal = { kind: 'menu', title, choices, selected: 0 };
    this._changed();
  }
  private _getShellProfile(): Profile {
    let profile = this.config.profiles.find((p) => p.id === 'shell');
    if (!profile) {
      profile = shellProfile();
      this.config.profiles.push(profile);
    }

    return profile;
  }
  private _openTerminal(): Promise<void> | void {
    const place = this.place;
    if (!place) {
      return this.createPlace().then(() => {
        /* No callback registered. */
      });
    }

    const shell = place.agents.find((a) => a.kind === 'shell');

    const open = () => {
      const profile = this._getShellProfile();
      let number = 2;
      while (place.agents.some((a) => a.name === `Shell ${number}`)) {
        number++;
      }

      const agent = {
        id: randomUUID(),
        name: `Shell ${number}`,
        profileId: profile.id,
      };

      place.agents.push(agent);
      this.modal = null;

      this.selectAgent(place.id, agent.id);
      this.sessions.start(agent, place, profile);
      this.focus = 'terminal';
      this._changed();
    };

    if (shell) {
      return this.sessions.refreshDirectory(shell.id).then(open);
    }

    open();
  }
  private _closeAgent(): Promise<void> | void {
    const place = this.place,
      agent = this.agent;
    if (!place || !agent) {
      return;
    }

    const remove = async () => {
      await this.sessions.remove(agent.id);
      this._forgetAgent(agent.id);
      this.modal = null;
      this._changed();
    };

    if (this.session?.process) {
      this._confirm('Close this terminal?', remove);
    } else {
      return remove();
    }
  }
  private _closePlace(): Promise<void> | void {
    const place = this.place;
    if (!place) {
      return;
    }

    const remove = async () => {
      const focus = this.focus;
      const results = await Promise.allSettled(
        [...place.agents].map(async (agent) => {
          await this.sessions.remove(agent.id);
          this._forgetAgent(agent.id);
        }),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        throw failure.reason;
      }

      const index = this.config.places.findIndex((p) => p.id === place.id);
      if (index < 0) {
        return;
      }

      this.config.places.splice(index, 1);
      this.config.activePlaceId =
        this.config.places[Math.min(index, this.config.places.length - 1)]
          ?.id ?? null;
      this.collapsed.delete(place.id);
      this.focus = focus === 'terminal' && this.agent ? 'terminal' : 'sidebar';
      this.modal = null;

      this._syncTreeIndex();
      this.git.update();
      this._persist();
      this._changed();
    };

    if (
      place.agents.some(
        (agent) => this.sessions.sessions.get(agent.id)?.process,
      )
    ) {
      this._confirm('Close this Place and all its terminals?', remove);
    } else {
      return remove();
    }
  }
  private _forgetAgent(id: string): void {
    this._promptDrafts.delete(id);

    const place = this.config.places.find((p) =>
      p.agents.some((a) => a.id === id),
    );
    if (!place) {
      return;
    }

    const index = place.agents.findIndex((a) => a.id === id);
    place.agents.splice(index, 1);

    const source = this._editorSources.get(id);
    this._editorSources.delete(id);
    if (place.activeAgentId === id) {
      place.activeAgentId =
        place.agents.find((a) => a.id === source)?.id ??
        place.agents[Math.min(index, place.agents.length - 1)]?.id ??
        null;
    }

    if (this.config.activePlaceId === place.id && !place.agents.length) {
      this.focus = 'sidebar';
    }

    this._syncTreeIndex();
    this._persist();
    this._changed();
  }
  private _confirm(title: string, action: () => Promise<void> | void): void {
    this._menu(title, [
      { label: 'Confirm', action },
      {
        label: 'Cancel',
        action: () => {
          this.modal = null;
        },
      },
    ]);
  }
  private _settings(): void {
    this.modal = {
      kind: 'settings',
      title: 'Settings',
      theme: this.config.theme,
    };
    this._changed();
  }
  private _prompt(): void {
    const place = this.place,
      agent = this.agent,
      session = this.session;
    if (!place || !agent || !session?.process) {
      this.message = 'Select a running agent to enter a prompt';

      return;
    }

    const editor = this._promptDrafts.get(agent.id) ?? new PromptEditor();
    this._promptDrafts.set(agent.id, editor);
    this.modal = {
      kind: 'prompt',
      title: 'Prompt',
      target: `${place.name} / ${session.threadName ?? session.processName ?? agent.name}`,
      placeId: place.id,
      agentId: agent.id,
      editor,
    };
  }
  private _sendPrompt(modal: Prompt): void {
    if (!modal.editor.text.trim()) {
      return;
    }

    const session = this.sessions.sessions.get(modal.agentId);
    const place = this.config.places.find(
      (place) => place.id === modal.placeId,
    );
    if (
      !session?.process ||
      session.stopRequested ||
      !place?.agents.some((agent) => agent.id === modal.agentId)
    ) {
      this.message = "The prompt's target agent is no longer running";

      return;
    }

    this.sessions.write(
      modal.agentId,
      encodePaste(modal.editor.text, session.screen.modes),
    );
    this.sessions.write(modal.agentId, '\r');

    this._promptDrafts.delete(modal.agentId);
    this.modal = null;

    this.selectAgent(modal.placeId, modal.agentId);
    this.focus = 'terminal';
  }
  private _cycleTheme(delta: number): void {
    if (this.modal?.kind !== 'settings') {
      return;
    }

    const current = THEMES.findIndex((option) => option.id === this.theme.id);
    this.modal.theme = defined(
      THEMES[(current + delta + THEMES.length) % THEMES.length],
    ).id;
    this._changed();
  }
  private async _perform(action: () => Promise<void> | void): Promise<void> {
    if (this.busy) {
      return;
    }

    let asynchronous = false;

    try {
      const result = action();
      if (result instanceof Promise) {
        asynchronous = true;
        this.busy = true;
        this._changed();
        await result;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.message = message;
    } finally {
      if (asynchronous) {
        this.busy = false;
      }

      this._changed();
    }
  }
  private _command(command: string): void {
    this.prefixUntil = 0;

    const actions: Record<string, () => Promise<void> | void> = {
      p: () => {
        this._prompt();
      },
      f: () => {
        this.modal = {
          kind: 'search',
          title: 'Find place or agent',
          editor: new PromptEditor(),
          selected: 0,
        };
      },
      s: async () => {
        await this.createPlace();
      },
      a: () => this._openTerminal(),
      n: () => {
        this._cycleTab(1);
      },
      b: () => {
        this._cycleTab(-1);
      },
      z: () => this._closeAgent(),
      x: () => this._closePlace(),
      m: () => {
        this._settings();
      },
      q: () => this.quit(),
      '?': () => {
        this.modal = { kind: 'help', title: 'Keyboard shortcuts', offset: 0 };
      },
      up: () => {
        this._moveTree(-1);
      },
      down: () => {
        this._moveTree(1);
      },
      left: () => {
        this.focus = 'sidebar';
        this._togglePlace();
      },
      right: () => {
        this.focus = 'sidebar';
        this._togglePlace();
      },
      enter: () => {
        this.focus = 'terminal';
      },
    };
    const action = /^\d$/u.test(command)
      ? () => {
          this._selectTab(command === '0' ? 9 : Number(command) - 1);
        }
      : actions[command];
    if (action) {
      void this._perform(action);
    }

    this._changed();
  }
  private _modalInput(event: InputEvent): void {
    const modal = this.modal;
    if (!modal || this.busy) {
      return;
    }

    if (modal.kind === 'prompt') {
      this._promptInput(event, modal);

      return;
    }

    if (modal.kind === 'help') {
      this._helpInput(event, modal);

      return;
    }

    if (modal.kind === 'settings') {
      this._settingsInput(event, modal);

      return;
    }

    if (modal.kind === 'search') {
      this._searchInput(event, modal);

      return;
    }

    this._menuInput(event, modal);
  }

  private _searchInput(event: InputEvent, modal: Search): void {
    const previous = modal.editor.text;
    if (event.kind === 'text' || event.kind === 'paste') {
      modal.editor.insert(event.text.replace(/[\r\n\t]+/gu, ' '));
    } else if (event.kind === 'key') {
      this._searchKey(event, modal);
    }

    if (modal.editor.text !== previous) {
      modal.selected = 0;
    }

    this._changed();
  }

  private _searchKey(
    event: Extract<InputEvent, { kind: 'key' }>,
    modal: Search,
  ): void {
    if (event.key === 'escape') {
      this.modal = null;

      return;
    }

    const results = this.searchResults();
    if (event.key === 'enter') {
      const result = results[modal.selected];
      if (!result) {
        return;
      }

      this.modal = null;
      if (result.agentId) {
        this.selectAgent(result.placeId, result.agentId);
      } else {
        this.selectPlace(result.placeId);
      }

      this.focus = this.agent ? 'terminal' : 'sidebar';

      return;
    }

    const delta = searchDelta(event.key, searchVisibleRows(this.rows));
    if (delta) {
      modal.selected = Math.max(
        0,
        Math.min(modal.selected + delta, results.length - 1),
      );
    } else if (!event.mods.alt && !event.mods.meta) {
      modal.editor.key(event.key, this.cols, event.mods.ctrl);
    }
  }

  private _mouse(event: Extract<InputEvent, { kind: 'mouse' }>): void {
    if (this._dragSelection(event)) {
      return;
    }

    if (event.action === 1 && !event.buttons) {
      this._hoverFile(event);
      if (event.mods.ctrl) {
        return;
      }
    } else {
      this._clearFileHover();
    }

    // Consume the matching release even if Ctrl was released or the editor
    // has already become active; it must not receive half a mouse gesture.
    if (this._fileRelease(event)) {
      if (event.action === 4) {
        this._fileClick = false;
      }

      return;
    }

    const geometry = this.geometry;
    if (inside(geometry.sidebar, event.x, event.y)) {
      this._sidebarMouse(event, geometry);

      return;
    }

    if (event.action === 3 && inside(geometry.tabs, event.x, event.y)) {
      this._tabMouse(event);

      return;
    }

    this._terminalMouse(event, geometry);
  }

  private _promptInput(event: InputEvent, modal: Prompt): void {
    if (event.kind === 'text' || event.kind === 'paste') {
      modal.editor.insert(event.text);
    } else if (event.kind === 'key') {
      if (event.key === 'escape') {
        this.modal = null;
      } else if (event.key === 'enter' && (event.mods.ctrl || event.mods.alt)) {
        this._sendPrompt(modal);
      } else if (!event.mods.alt && !event.mods.meta) {
        modal.editor.key(
          event.key,
          promptWidth(this.cols) - 4,
          event.mods.ctrl,
        );
      }
    }

    this._changed();
  }

  private _helpInput(event: InputEvent, modal: ShortcutHelp): void {
    const visible = shortcutVisibleRows(this.rows);
    const maxOffset = SHORTCUTS.length - visible;
    let offset = Math.min(modal.offset, maxOffset);
    if (event.kind === 'key') {
      if (event.key === 'escape' || event.key === 'enter') {
        this.modal = null;
      }

      offset = helpOffset(event.key, offset, visible, maxOffset);
    } else if (event.kind === 'mouse' && event.action === 5) {
      offset += event.wheelY * 3;
    }

    modal.offset = Math.max(0, Math.min(offset, maxOffset));
    this._changed();
  }

  private _settingsInput(event: InputEvent, modal: Settings): void {
    if (event.kind === 'mouse') {
      this._settingsMouse(event);
    } else if (event.kind === 'key') {
      this._settingsKey(event.key, modal);
    }

    this._changed();
  }

  private _settingsKey(key: string, modal: Settings): void {
    if (key === 'left' || key === 'up') {
      this._cycleTheme(-1);
    }

    if (key === 'right' || key === 'down' || key === 'tab') {
      this._cycleTheme(1);
    }

    if (key === 'enter') {
      this.config.theme = modal.theme;
      this.modal = null;
      this._persist();
    }

    if (key === 'escape') {
      this.modal = null;
    }
  }

  private _menuInput(event: InputEvent, modal: Menu): void {
    if (event.kind === 'mouse') {
      this._menuMouse(event, modal);

      return;
    }

    if (event.kind === 'key' && event.key === 'escape') {
      this.modal = null;
      this._changed();

      return;
    }

    if (event.kind === 'key') {
      if (event.key === 'up') {
        modal.selected =
          (modal.selected - 1 + modal.choices.length) % modal.choices.length;
      }

      if (event.key === 'down' || event.key === 'tab') {
        modal.selected = (modal.selected + 1) % modal.choices.length;
      }

      if (event.key === 'enter') {
        void this._perform(defined(modal.choices[modal.selected]).action);
      }
    }

    this._changed();
  }

  private _settingsMouse(event: Extract<InputEvent, { kind: 'mouse' }>): void {
    if (event.action === 3) {
      const hit = this.modalHits.find((h) => inside(h.rect, event.x, event.y));
      if (hit) {
        this._cycleTheme(hit.index);
      }
    }

    if (event.action === 5 && event.wheelY) {
      this._cycleTheme(Math.sign(event.wheelY));
    }
  }

  private _resize(event: Extract<InputEvent, { kind: 'resize' }>): void {
    this.cols = Math.max(1, event.cols);
    this.rows = Math.max(1, event.rows);
    if (this.modal?.kind === 'help') {
      this.modal.offset = Math.min(
        this.modal.offset,
        SHORTCUTS.length - shortcutVisibleRows(this.rows),
      );
    }

    const geometry = this.geometry;
    if (!geometry.small) {
      this.sessions.resize(geometry.terminal.w, geometry.terminal.h);
    }

    this._ensureVisible();
    this._changed();
  }

  private _prefixKey(): void {
    if (this.prefix) {
      this.prefixUntil = 0;
      if (this.agent) {
        this.sessions.write(this.agent.id, '\x02');
      }
    } else {
      this.prefixUntil = Date.now() + 2000;
      if (this._prefixTimer) {
        clearTimeout(this._prefixTimer);
      }

      this._prefixTimer = setTimeout(() => {
        this.prefixUntil = 0;
        this._changed();
      }, 2000);
      this._prefixTimer.unref();
    }

    this._changed();
  }

  private _sidebarInput(event: InputEvent): void {
    if (event.kind === 'key') {
      if (event.key === 'up') {
        this._moveTree(-1);
      }

      if (event.key === 'down') {
        this._moveTree(1);
      }

      if (event.key === 'left' || event.key === 'right') {
        this._togglePlace();
      }

      if (event.key === 'enter' || event.key === 'tab') {
        this.focus = 'terminal';
        this._changed();
      }
    }
  }

  private _terminalInput(
    event: Extract<InputEvent, { kind: 'key' | 'text' | 'paste' }>,
  ): void {
    const session = this.session,
      agent = this.agent;
    if (!session || !agent) {
      return;
    }

    if (event.kind === 'key' && historyKey(event)) {
      session.screen.scroll(
        (event.key === 'pageup' ? 1 : -1) *
          Math.max(1, this.geometry.terminal.h - 1),
      );
      this._changed();

      return;
    }

    let data: string;
    switch (event.kind) {
      case 'text':
        data = event.text;
        break;
      case 'paste':
        data = encodePaste(event.text, session.screen.modes);
        break;
      case 'key':
        data = encodeKey(event.key, event.mods, session.screen.modes);
        break;
    }

    if (data) {
      this.sessions.write(agent.id, data);
    }
  }

  private _routeInput(
    event: Extract<InputEvent, { kind: 'key' | 'text' | 'paste' | 'mouse' }>,
  ): void {
    if (prefixKey(event)) {
      this._prefixKey();

      return;
    }

    if (this.prefix && (event.kind === 'key' || event.kind === 'text')) {
      this._command(
        event.kind === 'key' ? event.key : event.text.toLowerCase(),
      );

      return;
    }

    if (this.geometry.small) {
      return;
    }

    if (event.kind === 'mouse') {
      this._mouse(event);

      return;
    }

    if (this.focus === 'sidebar') {
      this._sidebarInput(event);

      return;
    }

    this._terminalInput(event);
  }

  private _sidebarMouse(
    event: Extract<InputEvent, { kind: 'mouse' }>,
    geometry: ReturnType<typeof layout>,
  ): void {
    if (event.action === 5) {
      this.treeOffset = Math.max(
        0,
        Math.min(
          this.treeOffset + event.wheelY * 3,
          Math.max(0, this.tree().length - geometry.sidebar.h),
        ),
      );
      this._changed();
    }

    if (event.action === 3) {
      this.treeIndex = event.y - geometry.sidebar.y + this.treeOffset;

      const row = this.tree()[this.treeIndex];
      if (!row) {
        return;
      }

      this.focus = 'sidebar';
      if (!row.agentId) {
        this._activateRow();
      } else {
        this.selectAgent(row.placeId, row.agentId);
        this.focus = 'terminal';
      }

      this._changed();
    }
  }

  private _tabMouse(event: Extract<InputEvent, { kind: 'mouse' }>): void {
    const hit = this.tabHits.find((h) => inside(h.rect, event.x, event.y));
    if (hit && this.place) {
      this.selectAgent(this.place.id, hit.agentId);
      this.focus = 'terminal';
    }

    this._changed();
  }

  private _terminalMouse(
    event: Extract<InputEvent, { kind: 'mouse' }>,
    geometry: ReturnType<typeof layout>,
  ): void {
    if (!inside(geometry.terminal, event.x, event.y)) {
      return;
    }

    if (event.action === 3) {
      this.focus = 'terminal';
      this._changed();
    }

    const session = this.session,
      agent = this.agent;
    if (!session || !agent) {
      return;
    }

    if (fileClick(event)) {
      this._openFileAtMouse(event, geometry, session, agent);

      return;
    }

    const modes = session.screen.modes;
    if (selectionClick(event, modes)) {
      this._selection = {
        session,
        value: new TerminalSelection(
          session.screen.snapshot(false, this.theme),
          geometry.terminal.w,
          geometry.terminal.h,
          event.x - geometry.terminal.x,
          event.y - geometry.terminal.y,
        ),
      };
      this._changed();

      return;
    }

    if (alternateWheel(event, modes)) {
      this._alternateWheel(event, agent, modes);

      return;
    }

    if (historyWheel(event, modes)) {
      session.screen.scroll(-event.wheelY * 3);
      this._changed();

      return;
    }

    const data = encodeMouse(
      {
        ...event,
        x: event.x - geometry.terminal.x,
        y: event.y - geometry.terminal.y,
      },
      modes,
    );
    if (data) {
      this.sessions.write(agent.id, data);
    }
  }

  private _dragSelection(
    event: Extract<InputEvent, { kind: 'mouse' }>,
  ): boolean {
    const selection = this.terminalSelection;
    if (!selection) {
      return false;
    }

    if (event.action === 1) {
      return true;
    }

    if (!selection.dragging || ![2, 4].includes(event.action)) {
      return false;
    }

    const area = this.geometry.terminal;
    selection.move(event.x - area.x, event.y - area.y);
    if (event.action === 4) {
      selection.dragging = false;
      if (selection.text) {
        this._copyText(selection.text);
      }

      if (selection.empty) {
        this._selection = null;
      }
    }

    this._changed();

    return true;
  }

  private _openFileAtMouse(
    event: Extract<InputEvent, { kind: 'mouse' }>,
    geometry: ReturnType<typeof layout>,
    session: Session,
    agent: AgentDefinition,
  ): void {
    this._fileClick = true;

    const place = defined(this.place);
    const candidates = fileCandidates(
      session.screen.textAt(
        event.x - geometry.terminal.x,
        event.y - geometry.terminal.y,
      ),
    );
    if (candidates.length) {
      void this._perform(async () => {
        const directory = await this.sessions.currentDirectory(
          agent.id,
          place.directory,
        );
        const file = await resolveTextFile(candidates, directory);
        if (
          !file ||
          this.closing ||
          this.sessions.sessions.get(agent.id) !== session ||
          !place.agents.includes(agent)
        ) {
          return;
        }

        const profile = editorProfile(file);
        const editor = {
          id: randomUUID(),
          name: basename(file),
          profileId: this._getShellProfile().id,
        };

        this._editorSources.set(editor.id, agent.id);
        place.agents.splice(place.agents.indexOf(agent) + 1, 0, editor);
        this.sessions.start(editor, { ...place, directory }, profile);
        this.selectAgent(place.id, editor.id);
        this.focus = 'terminal';
      });
    }

    this._changed();
  }

  private _menuMouse(
    event: Extract<InputEvent, { kind: 'mouse' }>,
    modal: Menu,
  ): void {
    if (event.action === 3) {
      const hit = this.modalHits.find((h) => inside(h.rect, event.x, event.y));
      if (hit) {
        modal.selected = hit.index;
        void this._perform(defined(modal.choices[hit.index]).action);
      }
    }
  }

  private _alternateWheel(
    event: Extract<InputEvent, { kind: 'mouse' }>,
    agent: AgentDefinition,
    modes: TerminalModes,
  ): void {
    // Full-screen programs such as nano have no scrollback. Emulate the
    // outer terminal's wheel-to-arrow behavior when mouse tracking is off.
    if (modes.alternateScroll && event.wheelY) {
      const data = encodeKey(
        event.wheelY < 0 ? 'up' : 'down',
        NO_MODS,
        modes,
      ).repeat(Math.abs(event.wheelY) * 3);
      this.sessions.write(agent.id, data);
    }
  }
  private _canHoverFile(
    event: Extract<InputEvent, { kind: 'mouse' }>,
    area: Rect,
  ): boolean {
    return (
      event.mods.ctrl &&
      Boolean(process.env['EDITOR']?.trim()) &&
      inside(area, event.x, event.y)
    );
  }

  private _sameFileHover(
    previous: FileHover | null,
    session: Session,
    position: TerminalTextPosition,
    link: FileLink,
  ): previous is FileHover {
    return (
      previous?.session === session &&
      previous.text === position.text &&
      previous.link.start === link.start &&
      previous.link.end === link.end
    );
  }

  private _fileRelease(event: Extract<InputEvent, { kind: 'mouse' }>): boolean {
    return this._fileClick && ![3, 5].includes(event.action);
  }
}

function searchDelta(key: string, visible: number): number {
  switch (key) {
    case 'up':
      return -1;
    case 'down':
    case 'tab':
      return 1;
    case 'pageup':
      return -visible;
    case 'pagedown':
      return visible;
    default:
      return 0;
  }
}

function helpOffset(
  key: string,
  offset: number,
  visible: number,
  maxOffset: number,
): number {
  switch (key) {
    case 'up':
      return offset - 1;
    case 'down':
      return offset + 1;
    case 'pageup':
      return offset - visible;
    case 'pagedown':
      return offset + visible;
    case 'home':
      return 0;
    case 'end':
      return maxOffset;
    default:
      return offset;
  }
}

function historyKey(
  event: Extract<InputEvent, { kind: 'key' | 'text' | 'paste' }>,
): boolean {
  return (
    event.kind === 'key' &&
    event.mods.shift &&
    ['pageup', 'pagedown'].includes(event.key)
  );
}

function selectionClick(
  event: Extract<InputEvent, { kind: 'mouse' }>,
  modes: TerminalModes,
): boolean {
  return (
    event.action === 3 &&
    event.buttons === 1 &&
    (modes.mouseTrackingMode === 'none' || event.mods.alt || event.mods.shift)
  );
}

function fileClick(event: Extract<InputEvent, { kind: 'mouse' }>): boolean {
  return event.action === 3 && event.buttons === 1 && event.mods.ctrl;
}

function alternateWheel(
  event: Extract<InputEvent, { kind: 'mouse' }>,
  modes: TerminalModes,
): boolean {
  return (
    event.action === 5 &&
    !event.mods.shift &&
    modes.mouseTrackingMode === 'none' &&
    modes.alternateScreen
  );
}

function historyWheel(
  event: Extract<InputEvent, { kind: 'mouse' }>,
  modes: TerminalModes,
): boolean {
  return (
    event.action === 5 &&
    (modes.mouseTrackingMode === 'none' || event.mods.shift)
  );
}

function prefixKey(event: InputEvent): boolean {
  return event.kind === 'key' && event.key === 'b' && event.mods.ctrl;
}
