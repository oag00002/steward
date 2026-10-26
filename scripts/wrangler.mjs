// Run the project's own copy of Wrangler without a shell (works the same on Windows, macOS and Linux).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

// capture=true returns stdout; otherwise output goes straight to the terminal.
export function wrangler(args, { capture = false, allowFail = false } = {}) {
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (res.status !== 0 && !allowFail) {
    if (capture) process.stderr.write((res.stdout || '') + (res.stderr || ''));
    console.error(`\nwrangler ${args.join(' ')} failed.`);
    process.exit(1);
  }
  return { ok: res.status === 0, out: (res.stdout || '') + (res.stderr || '') };
}

export async function ask(question, { hidden = false } = {}) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
  }
  return new Promise(resolve => rl.question(question, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); }));
}
