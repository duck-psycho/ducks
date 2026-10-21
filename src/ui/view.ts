import { getIconChar } from '@rezi-ui/core';
import { defined } from '../defined.js';
import { SHORTCUTS, shortcutVisibleRows } from '../shortcuts.js';
import { Frame } from './Frame.js';
import { promptWidth, searchVisibleRows } from './layout.js';
import { graphemes, textWidth } from './text.js';
import type { Controller } from '../Controller.js';
import type { Modal, TreeRow } from './state.js';
import type { AgentDefinition, AgentActivity, Place } from '../model.js';
import type { layout } from './layout.js';
import type { CellStyle } from '../terminal/contracts.js';

function agentStatus(
  c: Controller,
  agent: AgentDefinition,
): AgentActivity | null {
  return c.sessions.sessions.get(agent.id)?.activity ?? null;
}

function processName(c: Controller, agent: AgentDefinition): string {
  return c.sessions.sessions.get(agent.id)?.processName ?? agent.name;
}

export function renderFrame(controller: Controller): Frame {
  const c = controller;
  const theme = c.theme;
  const colors = theme.colors;
  const baseStyle = { fg: colors.fg, bg: colors.bg };
  const statusColor: Record<AgentActivity, number> = {
    working: colors.yellow,
    idle: colors.green,
    waiting: colors.red,
  };

  const frame = new Frame(c.cols, c.rows, baseStyle);

  c.tabHits = [];
  c.modalHits = [];
  if (c.geometry.small) {
    frame.text(2, 2, 'Increase terminal to at least 80 × 24', {
      ...baseStyle,
      fg: colors.yellow,
    });
    frame.text(2, 4, `Current: ${c.cols} × ${c.rows} · Terminals stay open`);
    frame.text(2, 6, 'Ctrl+B q to quit');

    return frame;
  }

  const geometry = c.geometry;
  const context: FrameContext = {
    c,
    frame,
    geometry,
    colors,
    baseStyle,
    statusColor,
  };

  renderSidebar(context);
  renderTabs(context);
  renderTerminal(context);
  renderNotice(context);
  if (c.modal) {
    renderModal(frame, c);
  }

  return frame;
}

function renderModal(frame: Frame, controller: Controller): void {
  const modal = controller.modal;
  if (!modal) {
    return;
  }

  const colors = controller.theme.colors;
  const width =
    modal.kind === 'prompt'
      ? promptWidth(frame.cols)
      : Math.min(74, frame.cols - 8);
  const height = Math.min(frame.rows - 4, modalHeight(modal));
  const x = Math.floor((frame.cols - width) / 2),
    y = Math.floor((frame.rows - height) / 2);
  const style: CellStyle = { fg: colors.fg, bg: colors.sidebar };

  frame.fill({ x, y, w: width, h: height }, style);
  frame.text(x, y, '┌' + '─'.repeat(width - 2) + '┐', {
    ...style,
    fg: colors.accent,
  });
  frame.text(x, y + height - 1, '└' + '─'.repeat(width - 2) + '┘', {
    ...style,
    fg: colors.accent,
  });

  for (let row = y + 1; row < y + height - 1; row++) {
    frame.text(x, row, '│', { ...style, fg: colors.accent });
    frame.text(x + width - 1, row, '│', { ...style, fg: colors.accent });
  }

  frame.text(x + 2, y + 1, modal.title, { ...style, bold: true }, width - 4);
  if (modal.kind === 'prompt') {
    renderPromptModal(frame, controller, modal, x, y, width, height, style);

    return;
  }

  if (modal.kind === 'help') {
    renderHelpModal(frame, controller, modal, x, y, width, height, style);

    return;
  }

  if (modal.kind === 'settings') {
    renderSettingsModal(frame, controller, x, y, width, height, style);

    return;
  }

  if (modal.kind === 'search') {
    renderSearchModal(frame, controller, modal, x, y, width, height, style);

    return;
  }

  renderMenuModal(frame, controller, modal, x, y, width, height, style);
}

type FrameContext = {
  c: Controller;
  frame: Frame;
  geometry: ReturnType<typeof layout>;
  colors: Controller['theme']['colors'];
  baseStyle: CellStyle;
  statusColor: Record<AgentActivity, number>;
};

function renderSidebar(context: FrameContext): void {
  const { c, frame, geometry, colors, baseStyle } = context;
  const sidebarWidth = geometry.sidebar.w;

  frame.fill(
    { x: 0, y: 0, w: sidebarWidth, h: c.rows },
    { fg: colors.fg, bg: colors.sidebar },
  );
  frame.text(1, 0, '◆ Ducks', {
    fg: colors.accent,
    bg: colors.sidebar,
    bold: true,
  });

  for (let y = 0; y < c.rows; y++) {
    frame.text(sidebarWidth, y, '│', { ...baseStyle, fg: colors.line });
  }

  const tree = c.tree();
  for (
    let i = c.treeOffset;
    i < Math.min(tree.length, c.treeOffset + geometry.sidebar.h);
    i++
  ) {
    renderTreeRow(context, tree, i);
  }

  if (!tree.length) {
    frame.text(
      2,
      geometry.sidebar.y,
      'Ctrl+B s · Add Place',
      { fg: colors.muted, bg: colors.sidebar },
      sidebarWidth - 4,
    );
  }
}

function renderTabs(context: FrameContext): void {
  const { c, frame, geometry, colors, baseStyle } = context;
  const place = c.place;
  const agents = place?.agents ?? [];
  // Keep the active tab in view when the tab strip overflows.
  const activeIndex = agents.findIndex((a) => a.id === place?.activeAgentId);

  const widths = new Map<AgentDefinition, number>();

  const widthOf = (agent: AgentDefinition) => {
    let width = widths.get(agent);
    if (width === undefined) {
      width = Math.min(22, Math.max(10, textWidth(processName(c, agent)) + 2));
      widths.set(agent, width);
    }

    return width;
  };

  let first = Math.max(0, activeIndex);
  let used = agents[first] ? widthOf(defined(agents[first])) + 1 : 0;
  while (first > 0) {
    const width = widthOf(defined(agents[first - 1])) + 1;
    if (used + width > geometry.tabs.w) {
      break;
    }

    used += width;
    first--;
  }

  let x = geometry.tabs.x;
  if (first > 0) {
    frame.text(x, geometry.tabs.y, '‹', { ...baseStyle, fg: colors.muted });
    x += 2;
  }

  for (let i = first; i < agents.length; i++) {
    const agent = defined(agents[i]);
    const width = Math.min(widthOf(agent), c.cols - x - 1);
    if (width < 6) {
      break;
    }

    renderTab(context, agent, x, width);
    x += width + 1;
  }
}

function renderNotice(context: FrameContext): void {
  const { c, frame, geometry, colors } = context;
  const message = c.closing ? 'Closing terminals…' : c.message;
  if (!message) {
    return;
  }

  const style = { fg: colors.yellow, bg: colors.sidebar };
  frame.fill({ x: 0, y: c.rows - 1, w: geometry.sidebar.w, h: 1 }, style);
  frame.text(1, c.rows - 1, message, style, geometry.sidebar.w - 2);
}

function renderPromptModal(
  frame: Frame,
  controller: Controller,
  modal: Extract<Modal, { kind: 'prompt' }>,
  x: number,
  y: number,
  width: number,
  height: number,
  style: CellStyle,
): void {
  const colors = controller.theme.colors;
  frame.text(
    x + 2,
    y + 2,
    `To: ${modal.target}`,
    { ...style, fg: colors.accent },
    width - 4,
  );

  const area = { x: x + 2, y: y + 4, w: width - 4, h: height - 6 };
  const fieldStyle = { ...style, bg: colors.bg };

  frame.fill(area, fieldStyle);

  const editor = modal.editor,
    layout = editor.layout(area.w);
  editor.offset = Math.max(
    0,
    Math.min(editor.offset, Math.max(0, layout.rows.length - area.h)),
  );
  if (layout.row < editor.offset) {
    editor.offset = layout.row;
  }

  if (layout.row >= editor.offset + area.h) {
    editor.offset = layout.row - area.h + 1;
  }

  for (
    let i = editor.offset;
    i < Math.min(layout.rows.length, editor.offset + area.h);
    i++
  ) {
    frame.text(
      area.x,
      area.y + i - editor.offset,
      defined(layout.rows[i]).text,
      fieldStyle,
      area.w,
    );
  }

  const cursorX = area.x + layout.column,
    cursorY = area.y + layout.row - editor.offset;
  renderCursor(frame, cursorX, cursorY);

  frame.text(
    x + 2,
    y + height - 2,
    'Enter · New line  Ctrl/Alt+Enter · Send  Esc · Keep draft',
    { ...style, fg: colors.muted },
    width - 4,
  );
}

function renderCursor(frame: Frame, x: number, y: number): void {
  const cursor = frame.cells[y]?.[x];
  if (cursor) {
    const cells = cursor.width === 2 ? 2 : 1;
    for (let i = 0; i < cells; i++) {
      const cell = defined(defined(frame.cells[y])[x + i]);
      defined(frame.cells[y])[x + i] = {
        ...cell,
        style: { ...cell.style, inverse: true },
      };
    }
  }
}

function renderSearchModal(
  frame: Frame,
  controller: Controller,
  modal: Extract<Modal, { kind: 'search' }>,
  x: number,
  y: number,
  width: number,
  height: number,
  style: CellStyle,
): void {
  const colors = controller.theme.colors;
  const field = { x: x + 2, y: y + 3, w: width - 4, h: 1 };
  const fieldStyle = { ...style, bg: colors.bg };

  frame.fill(field, fieldStyle);

  let start = 0,
    column = textWidth(modal.editor.text.slice(0, modal.editor.cursor));
  for (const glyph of graphemes(
    modal.editor.text.slice(0, modal.editor.cursor),
  )) {
    if (column < field.w - 1) {
      break;
    }

    start += glyph.length;
    column -= textWidth(glyph);
  }

  if (modal.editor.text) {
    frame.text(
      field.x,
      field.y,
      modal.editor.text.slice(start),
      fieldStyle,
      field.w,
    );
  } else {
    frame.text(
      field.x,
      field.y,
      'Search by name…',
      { ...fieldStyle, fg: colors.muted },
      field.w,
    );
  }

  renderCursor(frame, field.x + column, field.y);

  const results = controller.searchResults();
  const visible = searchVisibleRows(frame.rows);
  const offset = Math.max(0, modal.selected - visible + 1);
  for (const [index, result] of results
    .slice(offset, offset + visible)
    .entries()) {
    const selected = offset + index === modal.selected;
    const rowStyle = {
      ...style,
      bg: selected ? colors.selected : style.bg,
      fg: selected ? colors.accent : colors.fg,
    };

    const row = y + 5 + index;

    frame.fill({ x: x + 2, y: row, w: width - 4, h: 1 }, rowStyle);

    const label = result.agentId
      ? `Agent · ${result.name} — ${result.placeName}`
      : `place · ${result.name}`;
    frame.text(x + 2, row, label, rowStyle, width - 4);
  }

  if (!results.length) {
    frame.text(x + 2, y + 5, 'No matches', { ...style, fg: colors.muted });
  }

  frame.text(
    x + width - 16,
    y + 1,
    `${results.length ? modal.selected + 1 : 0}/${results.length}`,
    { ...style, fg: colors.muted },
    14,
  );
  frame.text(
    x + 2,
    y + height - 2,
    '↑/↓ · Select  Enter · Open  Esc · Cancel',
    { ...style, fg: colors.muted },
    width - 4,
  );
}

function renderHelpModal(
  frame: Frame,
  controller: Controller,
  modal: Extract<Modal, { kind: 'help' }>,
  x: number,
  y: number,
  width: number,
  height: number,
  style: CellStyle,
): void {
  const colors = controller.theme.colors;
  const visible = shortcutVisibleRows(frame.rows);
  const start = Math.min(modal.offset, SHORTCUTS.length - visible);
  if (visible < SHORTCUTS.length) {
    frame.text(
      x + width - 13,
      y + 1,
      `${start + 1}–${start + visible}/${SHORTCUTS.length}`,
      { ...style, fg: colors.muted },
      11,
    );
  }

  for (let i = start; i < start + visible; i++) {
    const shortcut = defined(SHORTCUTS[i]);
    const row = y + 3 + i - start;
    if (!shortcut.keys) {
      frame.text(
        x + 2,
        row,
        shortcut.description,
        { ...style, fg: colors.accent, bold: true },
        width - 4,
      );
    } else {
      frame.text(x + 2, row, shortcut.keys, { ...style, bold: true }, 24);
      frame.text(x + 27, row, shortcut.description, style, width - 29);
    }
  }

  frame.text(
    x + 2,
    y + height - 2,
    'Esc/Enter · Close',
    { ...style, fg: colors.muted },
    width - 4,
  );
}

function renderSettingsModal(
  frame: Frame,
  controller: Controller,
  x: number,
  y: number,
  width: number,
  height: number,
  style: CellStyle,
): void {
  const colors = controller.theme.colors;
  const theme = controller.theme;
  const fieldX = x + 10,
    fieldWidth = width - 12,
    row = y + 3;
  const fieldStyle = { ...style, bg: colors.selected, fg: colors.accent };

  frame.text(x + 2, row, 'Theme', style);
  frame.fill({ x: fieldX, y: row, w: fieldWidth, h: 1 }, fieldStyle);
  frame.text(fieldX + 1, row, '‹', fieldStyle, 1);
  frame.text(
    fieldX + 4,
    row,
    `${theme.name} · ${theme.appearance}`,
    fieldStyle,
    fieldWidth - 8,
  );
  frame.text(fieldX + fieldWidth - 2, row, '›', fieldStyle, 1);

  controller.modalHits.push(
    { rect: { x: fieldX, y: row, w: 3, h: 1 }, index: -1 },
    { rect: { x: fieldX + fieldWidth - 3, y: row, w: 3, h: 1 }, index: 1 },
  );

  frame.text(
    x + 2,
    y + height - 2,
    '←/→ · Preview    Enter · Save    Esc · Cancel',
    { ...style, fg: colors.muted },
    width - 4,
  );
}

function renderTreeRow(
  context: FrameContext,
  tree: TreeRow[],
  i: number,
): void {
  const { c, frame, geometry, colors, statusColor } = context;
  const sidebarWidth = geometry.sidebar.w;
  const row = defined(tree[i]);
  const place = defined(c.config.places.find((p) => p.id === row.placeId));

  const y = geometry.sidebar.y + i - c.treeOffset;
  const selected = i === c.treeIndex;
  const bg = selected ? colors.selected : colors.sidebar;

  frame.fill({ x: 0, y, w: sidebarWidth, h: 1 }, { fg: colors.fg, bg });
  if (!row.agentId) {
    renderPlaceRow(context, place, y, bg, selected);
  } else {
    const agent = defined(place.agents.find((a) => a.id === row.agentId));
    const status = agentStatus(c, agent);

    frame.text(2, y, '›', { fg: colors.muted, bg });
    frame.text(
      4,
      y,
      c.agentName(agent),
      { fg: status ? statusColor[status] : colors.fg, bg },
      sidebarWidth - 5,
    );
  }
}

function renderTerminal(context: FrameContext): void {
  const { c, frame, geometry, colors, baseStyle } = context;
  const session = c.session;
  if (session) {
    const snapshot = renderTerminalContent(context);
    if (!session.process) {
      const label = session.error ?? '';
      frame.text(
        geometry.terminal.x,
        c.rows - 1,
        label,
        { ...baseStyle, fg: session.error ? colors.red : colors.muted },
        geometry.terminal.w,
      );
    } else if (snapshot.scrollOffset) {
      frame.text(
        geometry.terminal.x,
        c.rows - 1,
        `History: ${snapshot.scrollOffset} lines up · Shift+PgDn to return`,
        { ...baseStyle, fg: colors.yellow },
        geometry.terminal.w,
      );
    }
  } else {
    const title = c.place
      ? 'No terminals in this Place'
      : 'Open a shell, then cd to your project';
    const hint = c.place
      ? 'Ctrl+B a · Open a new terminal'
      : 'Ctrl+B s · Open your first Place';
    const area = geometry.terminal;
    const y = area.y + Math.floor((area.h - 3) / 2);

    const centeredX = (text: string) =>
      area.x + Math.floor(Math.max(0, area.w - textWidth(text)) / 2);

    frame.text(
      centeredX(title),
      y,
      title,
      { ...baseStyle, bold: true },
      area.w,
    );
    frame.text(
      centeredX(hint),
      y + 2,
      hint,
      { ...baseStyle, fg: colors.muted },
      area.w,
    );
  }
}

function renderTerminalContent(context: FrameContext) {
  const { c, frame, geometry } = context;
  const session = defined(c.session);
  const selection = c.terminalSelection;
  const snapshot =
    selection?.snapshot ?? session.screen.snapshot(false, c.theme);

  frame.terminal(
    geometry.terminal,
    snapshot,
    c.focus === 'terminal' &&
      !c.modal &&
      !selection &&
      Boolean(session.process),
  );
  renderFileHover(context);
  renderSelection(context);

  return snapshot;
}

function renderSelection(context: FrameContext): void {
  const { c, frame, geometry, colors } = context;
  const selection = c.terminalSelection;
  if (!selection) {
    return;
  }

  for (let y = 0; y < geometry.terminal.h; y++) {
    const row = frame.cells[geometry.terminal.y + y];
    if (!row) {
      continue;
    }

    for (let x = 0; x < geometry.terminal.w; x++) {
      const col = geometry.terminal.x + x;
      const cell = row[col];
      if (cell && selection.contains(x, y)) {
        row[col] = {
          ...cell,
          style: {
            ...cell.style,
            fg: colors.bg,
            bg: colors.accent,
            inverse: false,
          },
        };
      }
    }
  }
}

function renderFileHover(context: FrameContext): void {
  const { c, frame, geometry, colors } = context;
  for (const hit of c.hoveredFileCells) {
    for (let offset = 0; offset < hit.width; offset++) {
      const row = frame.cells[geometry.terminal.y + hit.y];
      const x = geometry.terminal.x + hit.x + offset;
      const cell = row?.[x];
      if (cell) {
        row[x] = {
          ...cell,
          style: {
            ...cell.style,
            fg: colors.accent,
            bg: colors.selected,
            underline: true,
          },
        };
      }
    }
  }
}

function renderTab(
  context: FrameContext,
  agent: AgentDefinition,
  x: number,
  width: number,
): void {
  const { c, frame, geometry, colors, statusColor } = context;
  const active = agent.id === c.place?.activeAgentId;
  const status = agentStatus(c, agent);
  const style = {
    fg: active ? colors.accent : colors.muted,
    bg: active ? colors.selected : colors.bg,
    bold: active,
  };

  frame.fill({ x, y: geometry.tabs.y, w: width, h: 1 }, style);

  frame.text(
    x + 1,
    geometry.tabs.y,
    processName(c, agent),
    { ...style, fg: status ? statusColor[status] : style.fg },
    width - 2,
  );
  c.tabHits.push({
    rect: { x, y: geometry.tabs.y, w: width, h: 1 },
    agentId: agent.id,
  });
}

function renderPlaceRow(
  context: FrameContext,
  place: Place,
  y: number,
  bg: number,
  selected: boolean,
): void {
  const { c, frame, geometry, colors } = context;
  const sidebarWidth = geometry.sidebar.w;
  const git = c.git.getStatus(place);
  const branch = git?.branch;
  const dirty = git?.dirty ? ` ${getIconChar('git.modified')}` : '';
  const ahead = git && git.ahead !== 0 ? ` ↑${git.ahead ?? '?'}` : '';
  const indicatorsWidth = textWidth(dirty + ahead);
  const branchWidth = branch
    ? Math.min(
        20,
        textWidth(branch),
        Math.max(1, sidebarWidth - 12 - indicatorsWidth),
      )
    : 0;
  const nameWidth =
    sidebarWidth - 4 - (branch ? branchWidth + indicatorsWidth + 1 : 0);

  const style = {
    fg: selected ? colors.accent : colors.fg,
    bg,
    bold: true,
  };

  frame.text(1, y, c.collapsed.has(place.id) ? '▸' : '▾', style, 1);
  frame.text(3, y, place.name, style, nameWidth);
  if (branch) {
    frame.text(
      3 + nameWidth + 1,
      y,
      branch,
      { fg: colors.muted, bg },
      branchWidth,
    );
    const indicatorX = 3 + nameWidth + 1 + branchWidth;
    frame.text(indicatorX, y, dirty, { fg: colors.yellow, bg });
    frame.text(indicatorX + textWidth(dirty), y, ahead, {
      fg: colors.accent,
      bg,
    });
  }
}

function modalHeight(modal: Modal): number {
  switch (modal.kind) {
    case 'settings':
      return 7;
    case 'help':
      return SHORTCUTS.length + 5;
    case 'prompt':
      return 18;
    case 'search':
      return 20;
    case 'menu':
      return modal.choices.length + 5;
  }
}

function renderMenuModal(
  frame: Frame,
  controller: Controller,
  modal: Extract<Modal, { kind: 'menu' }>,
  x: number,
  y: number,
  width: number,
  height: number,
  style: CellStyle,
): void {
  const colors = controller.theme.colors;
  const visible = height - 4;
  const start = Math.max(0, modal.selected - visible + 1);
  for (
    let i = start;
    i < Math.min(modal.choices.length, start + visible);
    i++
  ) {
    const row = y + 2 + i - start;
    const selected = i === modal.selected;
    const choiceStyle = {
      ...style,
      bg: selected ? colors.selected : colors.sidebar,
      fg: selected ? colors.accent : colors.fg,
    };

    frame.fill({ x: x + 2, y: row, w: width - 4, h: 1 }, choiceStyle);
    frame.text(
      x + 2,
      row,
      `${selected ? '›' : ' '} ${defined(modal.choices[i]).label}`,
      choiceStyle,
      width - 4,
    );
    controller.modalHits.push({
      rect: { x: x + 2, y: row, w: width - 4, h: 1 },
      index: i,
    });
  }

  frame.text(
    x + 2,
    y + height - 2,
    controller.busy
      ? 'Working…'
      : '↑/↓ · Select    Enter · Confirm    Esc · Cancel',
    { ...style, fg: colors.muted },
    width - 4,
  );
}
