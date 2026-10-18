import claude from './activity-rules/claude.json' with { type: 'json' };
import codex from './activity-rules/codex.json' with { type: 'json' };
import generic from './activity-rules/generic.json' with { type: 'json' };
import type { AgentActivity } from '../model.js';

type Profile = {
  id: string;
  agents: string[];
  prompts: string[];
  patterns: Record<string, string[]>;
};

type Detector = {
  id: string;
  agents: string[];
  prompts: string[];
  has: (feature: string, text: string) => boolean;
};

type ScreenParts = {
  rows: string[];
  conversation: string[];
  controls: string[];
};

type ActivityInput = { text: string; title: string; progress?: string };

export type ActivityEvidence = {
  state: AgentActivity | null;
  preserve: boolean;
};

function createDetector(profile: Profile): Detector {
  const patterns = new Map(
    Object.entries({ ...generic.patterns, ...profile.patterns }).map(
      ([feature, sources]) => [
        feature,
        sources.map((source) => new RegExp(source, 'iu')),
      ],
    ),
  );

  return {
    id: profile.id,
    agents: profile.agents,
    prompts: profile.prompts,
    has: (feature, text) =>
      patterns.get(feature)?.some((pattern) => pattern.test(text)) ?? false,
  };
}

const detectors = [codex, claude].map(createDetector);
const genericDetector = createDetector(generic);

function divider(text: string): boolean {
  const prefix = /^─+/u.exec(text)?.[0];

  return prefix !== undefined && (prefix.length >= 3 || prefix === text);
}

function prompt(text: string, detector: Detector): boolean {
  if (!detector.prompts.some((marker) => text.startsWith(marker))) {
    return false;
  }

  return !detector.has('selectedOption', text);
}

function screenParts(input: ActivityInput, detector: Detector): ScreenParts {
  const rows = input.text
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
  let lastInput = -1;
  for (const [index, row] of rows.entries()) {
    if (prompt(row, detector)) {
      lastInput = index;
    }
  }

  const conversation = rows.filter(
    (row, index) => index !== lastInput && !prompt(row, detector),
  );

  const afterInput = rows.slice(lastInput + 1);
  const border = afterInput.findLastIndex(divider);
  const suffix = afterInput.slice(border + 1);

  // A named divider may be followed by a task counter and marked task rows.
  const auxiliary = suffix.every((row) => detector.has('auxiliary', row));
  const controls =
    border >= 0 && !auxiliary
      ? suffix
      : afterInput.filter((row) => !divider(row));

  return { rows, conversation, controls };
}

function preserveView(parts: ScreenParts, detector: Detector): boolean {
  const recent = parts.rows.slice(-20).join(' ');
  if (detector.has('transcript', recent)) {
    return true;
  }

  return (
    detector.has('modelPicker', recent) &&
    detector.has('modelChoice', recent) &&
    detector.has('cancel', recent)
  );
}

function dialog(parts: ScreenParts, detector: Detector): boolean {
  const text = parts.controls.join(' ');
  if (detector.has('confirm', text) || detector.has('request', text)) {
    return true;
  }

  if (
    detector.has('question', text) &&
    parts.controls.some((row) => detector.has('options', row))
  ) {
    return true;
  }

  if (detector.has('workflow', text) && detector.has('cancel', text)) {
    return true;
  }

  return (
    parts.controls.some((row) => detector.has('elicitation', row)) &&
    detector.has('cancel', text)
  );
}

function codexMenu(parts: ScreenParts, detector: Detector): boolean {
  const text = parts.controls.join(' ');
  const update =
    detector.has('update', text) && detector.has('updateContinue', text);
  const picker =
    detector.has('filePicker', text) &&
    detector.has('filePickerScopes', text) &&
    detector.has('filePickerPlugins', text);

  return (
    update ||
    picker ||
    parts.controls.some((row) => detector.has('options', row))
  );
}

function workingRow(row: string, detector: Detector): boolean {
  const text = row.replace(/^[•◦] /u, '');
  if (detector.has('failedWork', text)) {
    return false;
  }

  if (detector.has('interrupt', text) || detector.has('timer', text)) {
    return true;
  }

  return (
    detector.has('ellipsis', text) &&
    (detector.has('workVerb', text) || detector.has('workSymbol', text))
  );
}

function backgroundWork(parts: ScreenParts, detector: Detector): boolean {
  for (let index = 0; index < parts.conversation.length; index++) {
    const row = parts.conversation[index] ?? '';
    if (!detector.has('workSymbol', row)) {
      continue;
    }

    const status = parts.conversation.slice(index, index + 4).join(' ');
    if (
      detector.has('backgroundCount', status) &&
      detector.has('backgroundState', status)
    ) {
      return true;
    }
  }

  return false;
}

function work(parts: ScreenParts, detector: Detector): boolean {
  const recent = parts.conversation.slice(-12);
  const lastResponse = recent.findLastIndex(
    (row) =>
      detector.has('response', row) && !detector.has('continuation', row),
  );
  const active = recent.slice(Math.max(0, lastResponse));
  if (active.some((row) => workingRow(row, detector))) {
    return true;
  }

  if (backgroundWork(parts, detector)) {
    return true;
  }

  return (
    active.some((row) => detector.has('sideQuestion', row)) &&
    active.some((row) => detector.has('closeOverlay', row))
  );
}

function result(state: AgentActivity | null): ActivityEvidence {
  return { state, preserve: false };
}

function classifyScreen(
  detector: Detector,
  input: ActivityInput,
): ActivityEvidence {
  const parts = screenParts(input, detector);
  if (preserveView(parts, detector)) {
    return { state: null, preserve: true };
  }

  if (dialog(parts, detector)) {
    return result('waiting');
  }

  if (detector.id === 'codex' && codexMenu(parts, detector)) {
    return result('waiting');
  }

  if (work(parts, detector)) {
    return result('working');
  }

  if (detector.has('idleProgress', input.progress ?? '')) {
    return result('idle');
  }

  if (
    parts.rows.some((row) => prompt(row, detector)) ||
    detector.has('titleIdle', input.title)
  ) {
    return result('idle');
  }

  return result(null);
}

/** Classify explicit UI signals; ActivityTracker handles timing and process lifetime. */
export function detectActivity(
  agent: string,
  input: ActivityInput,
): ActivityEvidence {
  const detector =
    detectors.find((candidate) => candidate.agents.includes(agent)) ??
    genericDetector;
  if (detector.has('titleWaiting', input.title)) {
    return result('waiting');
  }

  if (detector.has('titleBusy', input.title)) {
    return result('working');
  }

  return classifyScreen(detector, input);
}
