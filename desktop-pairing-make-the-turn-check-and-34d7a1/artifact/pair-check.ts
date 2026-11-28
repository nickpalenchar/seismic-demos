// Drives the real desktop shell (a debug build from a checkout) through a pairing abandoned while the
// shell asks the address: "Mac Studio" is a scratch Seismic behind a proxy whose `/api/projects`
// answers after 5 s. Steps, from the module in the shell's pages (SEISMIC_APP_CHECK):
//   1. on This Mac's page: connect to Mac Studio, and 1.5 s later, while the shell still asks the
//      address, switch to "Fast C";
//   2. the window should stay on Fast C, never go to Mac Studio's /pair, and keep nothing;
//   3. on Fast C: connect to Mac Studio again with no switch (a wrong code): the window goes to /pair,
//      and the shell, seeing the pairing it started, brings back the connect form with "wrong".
//
//   bun pair-check.ts <checkout> [--log <file>]

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const checkout = process.argv[2]!;
const logFile = process.argv.includes('--log') ? process.argv[process.argv.indexOf('--log') + 1] : undefined;
const PROGRAM = `${checkout}/desktop/target/checkout/debug/seismic`;
const here = import.meta.dirname;
const DELAY = 8000;
type Staged = { url: string; port: number; home: string };
const stage = (file: string, ...more: string[]): Staged => JSON.parse(execFileSync('bun', [`${checkout}/scripts/scratch-seismic.ts`, `${here}/${file}`, ...more], { encoding: 'utf8' }).trim().split('\n').at(-1)!);
const stop = (s: Staged) => execFileSync('bun', [`${checkout}/scripts/scratch-seismic.ts`, '--stop', String(s.port)], { encoding: 'utf8' });
const t0 = Date.now();
const log = (line: string) => {
  const l = `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${line}`;
  console.log(l);
  if (logFile) appendFileSync(logFile, `${l}\n`);
};
if (logFile) writeFileSync(logFile, '');

const laptop = stage('local.json', '--dir', `/tmp/seismic-pair-turn-laptop-${process.pid}`);
const studio = stage('remote.json');
// the shell starts the laptop's server itself, under itself
stop(laptop);

const asked: string[] = [];
const proxy = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    asked.push(url.pathname);
    if (url.pathname === '/api/projects') {
      log(`  Mac Studio is asked ${url.pathname} (answers in ${DELAY / 1000} s)`);
      await Bun.sleep(DELAY);
    } else if (url.pathname === '/pair') log(`  Mac Studio is asked /pair${url.search}`);
    const up = await fetch(`http://127.0.0.1:${studio.port}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
    });
    const headers = new Headers(up.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(up.body, { status: up.status, headers });
  },
});
const fast = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    if (new URL(req.url).pathname === '/api/projects') return Response.json([]);
    return new Response('<!doctype html><title>Fast C</title><body style="font:24px system-ui;padding:3em">The Seismic of Fast C</body>', { headers: { 'content-type': 'text/html' } });
  },
});
const studioOrigin = `http://127.0.0.1:${proxy.port}`;
const fastOrigin = `http://127.0.0.1:${fast.port}`;
const list = { active: 'local', list: [{ id: 'local', name: 'This Mac', url: null }, { id: 'c', name: 'Fast C', url: fastOrigin }] };
writeFileSync(`${laptop.home}/app-workspaces.json`, JSON.stringify(list, null, 2));
const nameOf = (o: string) => (o === studioOrigin ? 'Mac Studio' : o === fastOrigin ? 'Fast C' : 'This Mac');

const MODULE = `
const base = new URL(import.meta.url).origin;
const shell = window.__TAURI_INTERNALS__;
const trace = (what) => fetch(base + '/trace', { method: 'POST', body: location.origin + ' ' + what }).catch(() => {});
const report = async (done) => (await fetch(base + '/next', { method: 'POST', body: JSON.stringify({ location: location.href, all: done ? null : await shell.invoke('workspaces').catch(() => null), done }) })).json();
let next = await report(null);
while (next) {
  if (next.wait) { trace('waits'); await new Promise((r) => setTimeout(r, next.wait)); }
  else if (next.cmd === 'connect_workspace') {
    trace('got connect; asking the turn');
    const turn = (await shell.invoke('workspaces')).turn;
    trace('turn ' + turn + '; connecting');
    shell.invoke(next.cmd, { ...next.args, turn }).then(() => trace('connect returned'), (e) => trace('connect failed ' + e));
  }
  else await shell.invoke(next.cmd, next.args).catch(() => {});
  next = await report(next);
}
`;
type Report = { location: string; all: { active: string; turn: number } | null; done: { cmd?: string; args?: Record<string, string>; wait?: number } | null };
const pages: { at: number; name: string; path: string; search: string }[] = [];
let step = 0;
let afterSwitch = 0;
let retriedAt = Infinity;
let pairBeforeRetry = -1;
let settled: (() => void) | undefined;
let savedAfterSwitch: { active: string; list: { id: string; name: string }[] } | undefined;
const finished = new Promise<void>((r) => (settled = r));
const connect = { cmd: 'connect_workspace', args: { name: 'Mac Studio', address: studioOrigin, code: '000000' } };

const harness = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const cors = { 'access-control-allow-origin': '*' };
    const url = new URL(req.url);
    if (url.pathname === '/trace') {
      log(`  [page] ${await req.text()}`);
      return new Response('', { headers: cors });
    }
    if (url.pathname === '/module.js') return new Response(MODULE, { headers: { ...cors, 'content-type': 'text/javascript' } });
    const r = (await req.json()) as Report;
    const at = new URL(r.location);
    const page = nameOf(at.origin);
    if (!r.done) {
      pages.push({ at: Date.now(), name: page, path: at.pathname, search: at.search });
      log(`the window loaded ${page}'s ${at.pathname}${at.search}${r.all ? `; active: ${r.all.active}, turn ${r.all.turn}` : ''}`);
    } else if (r.done.cmd) log(`  the page called ${r.done.cmd}${r.done.args?.id ? ` ${r.done.args.id}` : ''}`);
    let next: unknown = null;
    if (step === 0 && page === 'This Mac' && !at.search && at.pathname !== '/login') {
      step = 1;
      next = connect;
    } else if (step === 1) {
      // the page's timers may be throttled while the window is out of sight: the harness waits
      await Bun.sleep(1500);
      step = 3;
      next = { cmd: 'switch_workspace', args: { id: 'c' } };
    } else if (step === 3 && !r.done && page === 'Fast C') {
      step = 4;
      afterSwitch = Date.now();
      // Mac Studio's answer comes in after this: the page asks again each second until it is out
      next = { wait: 1000 };
    } else if (step === 4 && Date.now() - afterSwitch < DELAY + 3000) {
      next = { wait: 1000 };
    } else if (step === 4) {
      step = 5;
      retriedAt = Date.now();
      pairBeforeRetry = asked.filter((p) => p === '/pair').length;
      savedAfterSwitch = JSON.parse(readFileSync(`${laptop.home}/app-workspaces.json`, 'utf8'));
      log('  (Mac Studio has answered; now a pairing nothing interrupts)');
      next = connect;
    } else if (step === 5 && !r.done && page === 'This Mac' && at.searchParams.get('workspace') === 'connect') {
      step = 6;
      setTimeout(() => settled?.(), 1000);
    }
    return Response.json(next, { headers: cors });
  },
});

const env = {
  ...process.env,
  SEISMIC_HOME: laptop.home,
  SEISMIC_CHECKOUT: checkout,
  SEISMIC_BUN: process.execPath,
  SEISMIC_APP_CHECK: `http://127.0.0.1:${harness.port}/module.js`,
};
log(`shell ${PROGRAM}; Mac Studio at ${studioOrigin}, Fast C at ${fastOrigin}`);
const shell = Bun.spawn([PROGRAM], { env, stdout: Bun.file(`${here}/shell.out`), stderr: Bun.file(`${here}/shell.err`) });

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
try {
  await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('the flow did not finish in 300 s')), 120000))]);
  const between = pages.filter((p) => p.at > afterSwitch && p.at < retriedAt);
  check('after the switch, the window stayed on Fast C (no page loaded until the retry)', afterSwitch > 0 && between.length === 0, between.map((p) => p.name).join(', '));
  check('the abandoned pairing never sent the window to /pair', pairBeforeRetry === 0);
  check('nothing was saved: Fast C active, no Mac Studio on the list', savedAfterSwitch?.active === 'c' && !savedAfterSwitch.list.some((w) => w.name === 'Mac Studio'), JSON.stringify(savedAfterSwitch));
  const last = pages.at(-1)!;
  check('a pairing nothing interrupts went to /pair and came back with "wrong"', asked.includes('/pair') && new URLSearchParams(last.search).get('problem') === 'wrong', last.search);
} catch (e) {
  check(String(e), false, JSON.stringify(pages));
} finally {
  shell.kill();
  try {
    execFileSync('pkill', ['-f', PROGRAM]);
  } catch {}
  harness.stop(true);
  proxy.stop(true);
  fast.stop(true);
  try {
    stop(studio);
  } catch {}
  try {
    execFileSync('pkill', ['-f', `SEISMIC_HOME=${laptop.home}`]);
  } catch {}
}
process.exit(failed ? 1 : 0);
