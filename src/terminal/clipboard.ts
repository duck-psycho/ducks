/** OSC 52 delegates clipboard access to the host terminal, including over SSH. */
export function copyTerminalText(text: string): void {
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
}
