import type { TerminalModes } from '../src/terminal/contracts.js';
export const AGENT_FIXTURE = `process.stdin.setRawMode(true); process.stdin.resume();
  const paint = (title, body) => process.stdout.write('\\x1b[2J\\x1b[H\\x1b]0;'+title+'\\x07'+body);
  let thread = null;
  const label = () => thread ? thread + ' | project' : 'Codex';
  const idle = () => paint(label(), 'FIXTURE_READY\\r\\n› \\r\\n');
  idle();
  process.stdin.on('data', data => {
    for (const key of data.toString()) {
      if (key === 'w') paint('⠙ ' + label(), 'Working (4s • esc to interrupt)\\r\\n› \\r\\n');
      if (key === 'a') paint('[ ! ] Action Required | ' + label(), 'Allow command?\\r\\n1. Yes\\r\\n2. No\\r\\nEnter to confirm\\r\\n');
      if (key === 'n') { thread = 'Thread One'; idle(); }
      if (key === 'r') { thread = 'Thread Two'; idle(); }
      if (key === 'i') idle();
      if (key === 'q') process.exit(0);
    }
  });`;
export const MODES: TerminalModes = {
  alternateScreen: false,
  alternateScroll: true,
  applicationCursorKeys: false,
  bracketedPasteMode: false,
  sendFocus: false,
  mouseTrackingMode: 'none',
  mouseEncoding: 'sgr',
};
