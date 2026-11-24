// main.ts is mend, the command-line tool SPEC.md (version 1) specifies: one
// patch tool for every AI edit format. A patch comes in as a unified diff
// (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or
// text-editor tool calls as JSON; mend reads whichever it is given, finds the
// lines each edit really belongs on at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to stop with exit 2 and one output line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by one edit to fail it with an error code and a path. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and no
 * empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a path is safe when it is not empty, does not start with
 * /, holds no \, and none of its /-separated segments is empty, . or ... */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One line of a file as a patch names it: its text, whether it is a context
 * line (a line of both the old and the new side), and whether a \ line
 * follows it in the patch body. */
interface PL {
  text: string;
  ctx: boolean;
  noEol: boolean;
}

const pl = (text: string, ctx: boolean): PL => ({ text, ctx, noEol: false });

/** A file's lines, its line break, and whether it ends with one. */
interface FileModel {
  br: string;
  lines: string[];
  eol: boolean;
}

/** SPEC section 3: the break is CRLF when the first line feed follows a
 * carriage return, LF otherwise; the text split at that break, with the last
 * empty piece dropped when the text ends with the break. An empty file has no
 * lines and does not end with a break. */
function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const eol = text.endsWith(br);
  if (eol) lines.pop();
  return { br, lines, eol };
}

/** The file back as text: its own break between its lines, and a final one
 * exactly when it ended with one. A file of no lines is written empty. */
function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.eol ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk; successful moves remembered for the R lines. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  setText(p: string, text: string): void {
    this.now.set(p, text);
  }
  setModel(p: string, m: FileModel): void {
    this.now.set(p, joinFile(m));
  }
}

type Edit = (tree: Tree) => void;

/** SPEC section 4: the first of these that holds, on the patch's lines. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC section 5)
// ---------------------------------------------------------------------------

/** The leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A line as a tier reads it: tier 0 exact, tier 1 without trailing spaces
 * and tabs, tier 2 without leading and trailing spaces and tabs. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Every 0-based position at or after `from` where `oldLines` occurs in
 * `lines` at one tier; occurrences may overlap. */
function occurrences(lines: string[], oldLines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  const want = oldLines.map((l) => normLine(l, tier));
  for (let i = from; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which
 * `oldLines` occurs at least once, with every occurrence at that tier. */
function findOcc(lines: string[], oldLines: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Replace the k matched lines at `pos` by the new side. A context line is
 * written as the file's own matched line, never the patch's. At tier 2 every
 * other line is re-indented: the leading spaces and tabs of the file's first
 * matched line replace those of the old side's first line, on a line that is
 * not empty and not only whitespace and starts with them. */
function spliceLines(file: FileModel, pos: number, oldLen: number, oldLs: PL[], newLs: PL[], tier: number): void {
  const out: string[] = [];
  const f = oldLs.length > 0 ? leadWs(file.lines[pos]!) : '';
  const p = oldLs.length > 0 ? leadWs(oldLs[0]!.text) : '';
  let oi = 0;
  for (const nl of newLs) {
    if (nl.ctx) {
      while (oi < oldLs.length && !oldLs[oi]!.ctx) oi++;
      out.push(file.lines[pos + oi]!);
      oi++;
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  file.lines.splice(pos, oldLen, ...out);
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** The old start line A of `@@ -A[,B] +C[,D] @@`. */
  a: number;
  oldLs: PL[];
  newLs: PL[];
}

interface UniSection {
  /** null is /dev/null: no file on that side. */
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

interface UniBuilder {
  diffOld: string | null;
  diffNew: string | null;
  headOld?: string | null;
  headNew?: string | null;
  renOld?: string;
  renNew?: string;
  newMode: boolean;
  delMode: boolean;
  hunks: Hunk[];
}

function finishSection(b: UniBuilder): UniSection {
  const oldPath = b.headOld !== undefined ? b.headOld : b.renOld !== undefined ? b.renOld : b.diffOld;
  const newPath = b.headNew !== undefined ? b.headNew : b.renNew !== undefined ? b.renNew : b.diffNew;
  return {
    oldPath,
    newPath,
    creation: b.newMode || oldPath === null,
    deletion: b.delMode || newPath === null,
    hunks: b.hunks,
  };
}

/** The path a `--- ` or `+++ ` line names: the text after the four
 * characters, up to the first tab, with surrounding spaces removed;
 * /dev/null means no file, and a leading a/ or b/ is removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk header, or a parse error at its line. */
function parseHunkHeader(line: string, num: number): number {
  const m = HUNK_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${num}`);
  return Number(m[1]);
}

interface RawBody {
  kind: string;
  text: string;
  noEol: boolean;
}

/** A hunk's body, from the line after its header: lines starting with a
 * space (context), - (old), + (new) or \ (a \ line), or empty lines (a
 * context line whose text is empty). It ends at the first other line, at a
 * diff --git line, at a --- line followed by a +++ line, or at the end of
 * the patch; empty lines at the end of a body are not part of it. A \ line
 * marks the body line before it. */
function parseHunkBody(lines: string[], start: number): { oldLs: PL[]; newLs: PL[]; next: number } {
  const raw: RawBody[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1), noEol: false });
      j++;
    } else break;
  }
  while (raw.length > 0 && raw[raw.length - 1]!.kind === ' ' && raw[raw.length - 1]!.text === '') raw.pop();
  for (let k = 0; k < raw.length; k++) {
    if (raw[k]!.kind === '\\' && k > 0) raw[k - 1]!.noEol = true;
  }
  const oldLs: PL[] = [];
  const newLs: PL[] = [];
  for (const b of raw) {
    if (b.kind === ' ') {
      oldLs.push({ text: b.text, ctx: true, noEol: b.noEol });
      newLs.push({ text: b.text, ctx: true, noEol: b.noEol });
    } else if (b.kind === '-') oldLs.push({ text: b.text, ctx: false, noEol: b.noEol });
    else if (b.kind === '+') newLs.push({ text: b.text, ctx: false, noEol: b.noEol });
  }
  return { oldLs, newLs, next: j };
}

/** A `diff --git a/<X> b/<Y>` line's two paths, or a parse error at its line. */
function diffGitPaths(line: string, num: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${num}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new Exit2(`error: parse ${num}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${num}`);
  return [x, y];
}

/** Read a patch as a unified diff: its sections, each one edit. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let b: UniBuilder | null = null;
  const push = (): void => {
    if (b !== null) sections.push(finishSection(b));
    b = null;
  };
  const fresh = (diffOld: string | null, diffNew: string | null): UniBuilder => ({
    diffOld,
    diffNew,
    newMode: false,
    delMode: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const [x, y] = diffGitPaths(l, i + 1);
      push();
      b = fresh(x, y);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (b !== null && b.hunks.length === 0) {
        b.headOld = headerPath(l);
        b.headNew = headerPath(lines[i + 1]!);
      } else {
        push();
        b = fresh(null, null);
        b.headOld = headerPath(l);
        b.headNew = headerPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (b === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (b.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ') && b.renOld === undefined) {
        b.renOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ') && b.renNew === undefined) {
        b.renNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        b.newMode = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        b.delMode = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        const a = parseHunkHeader(l, i + 1);
        const body = parseHunkBody(lines, i + 1);
        b.hunks.push({ a, oldLs: body.oldLs, newLs: body.newLs });
        i = body.next;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l, i + 1);
      const body = parseHunkBody(lines, i + 1);
      b.hunks.push({ a, oldLs: body.oldLs, newLs: body.newLs });
      i = body.next;
      continue;
    }
    i++;
  }
  push();
  return sections.map((sec) => uniEdit(sec, strict));
}

/** Apply a section's hunks in order, each to the result of the ones before
 * it. d is the sum over the hunks applied so far of (new length minus old
 * length). A hunk with old lines takes the occurrence nearest to A - 1 + d,
 * the earlier of two equally near; a hunk with no old lines inserts after
 * the first A + d lines. When a hunk's matched lines run to the end of the
 * file (or the insertion is at the end), the result ends with a line break
 * unless a \ line follows the hunk's last context or + line; otherwise the
 * file's final break stays as it was. */
function applyHunks(file: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.oldLs.length === 0) {
      const at = Math.min(h.a + d, file.lines.length);
      const atEnd = at === file.lines.length;
      const ins = h.newLs.map((nl) => nl.text);
      const noEol = h.newLs.length > 0 ? h.newLs[h.newLs.length - 1]!.noEol : false;
      file.lines.splice(at, 0, ...ins);
      if (atEnd) file.eol = !noEol;
      d += h.newLs.length;
      continue;
    }
    const found = findOcc(file.lines, h.oldLs.map((l) => l.text), strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let bd = Math.abs(pos - target);
    for (const p of found.occ) {
      const dd = Math.abs(p - target);
      if (dd < bd) {
        pos = p;
        bd = dd;
      }
    }
    const touchesEnd = pos + h.oldLs.length === file.lines.length;
    const noEol = h.newLs.length > 0 ? h.newLs[h.newLs.length - 1]!.noEol : false;
    spliceLines(file, pos, h.oldLs.length, h.oldLs, h.newLs, found.tier);
    if (touchesEnd) file.eol = !noEol;
    d += h.newLs.length - h.oldLs.length;
  }
}

/** One unified section as one edit. */
function uniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null && newP === null) return;
    if (sec.creation) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out: string[] = [];
      let lastPlusNoEol = false;
      for (const h of sec.hunks) {
        for (const nl of h.newLs) {
          if (!nl.ctx) {
            out.push(nl.text);
            lastPlusNoEol = nl.noEol;
          }
        }
      }
      tree.setText(np, out.length === 0 ? '' : out.join('\n') + (lastPlusNoEol ? '' : '\n'));
      return;
    }
    if (sec.deletion) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== newP) {
      const op = oldP!;
      const np = newP!;
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const file = splitFile(before);
      applyHunks(file, sec.hunks, strict, op);
      tree.setModel(np, file);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const file = splitFile(before);
    applyHunks(file, sec.hunks, strict, p);
    tree.setModel(p, file);
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

/** One SEARCH/REPLACE block as one edit. Empty old lines create the file;
 * otherwise the old lines must occur at their tier exactly once. */
function srEdit(path: string, oldLs: PL[], newLs: PL[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLs.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.setText(path, newLs.length === 0 ? '' : newLs.map((l) => l.text).join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = splitFile(before);
    const found = findOcc(file.lines, oldLs.map((l) => l.text), strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    spliceLines(file, found.occ[0]!, oldLs.length, oldLs, newLs, found.tier);
    tree.setModel(path, file);
  };
}

/** Read a patch as SEARCH/REPLACE blocks. The path is the nearest line
 * before the SEARCH line, and after the previous block, that is not blank
 * and does not start with three backticks; with no such line the block
 * takes the previous block's path, and the first block with none is a
 * parse error at its SEARCH line. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k >= prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let j = searchLine + 1;
    let sep = -1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      j++;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let k = sep + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLs = lines.slice(searchLine + 1, sep).map((t) => pl(t, false));
    const newLs = lines.slice(sep + 1, k).map((t) => pl(t, false));
    edits.push(srEdit(path, oldLs, newLs, strict));
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  /** null or '' is no anchor. */
  anchor: string | null;
  oldLs: PL[];
  newLs: PL[];
  /** Anchored to the end of the file by a *** End of File line. */
  eof: boolean;
}

function addEdit(path: string, body: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.setText(path, body.length === 0 ? '' : body.join('\n') + '\n');
  };
}

function delEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One Update File section as one edit: its chunks apply in order, with a
 * cursor that starts at line 0. A chunk with an anchor first finds the
 * first line at or after the cursor equal to the anchor at the first tier
 * where one is, and the cursor moves past it. The chunk takes the first
 * occurrence of its old lines at or after the cursor, at the first tier
 * with one; an end-of-file chunk takes only an occurrence that ends at the
 * file's last line. With no old lines the new lines are inserted at the
 * cursor, or at the end of the file for an end-of-file chunk. The cursor
 * then moves to just after the lines written. */
function updEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const file = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundIdx: number | null = null;
        for (const t of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < file.lines.length; k++) {
            if (normLine(file.lines[k]!, t) === normLine(ch.anchor, t)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx !== null) break;
        }
        if (foundIdx === null) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      if (ch.oldLs.length === 0) {
        const at = ch.eof ? file.lines.length : cursor;
        const ins = ch.newLs.map((nl) => nl.text);
        file.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      let found: Found | null = null;
      for (const t of strict ? [0] : [0, 1, 2]) {
        const occ = occurrences(file.lines, ch.oldLs.map((l) => l.text), t, cursor).filter(
          (p) => !ch.eof || p + ch.oldLs.length === file.lines.length,
        );
        if (occ.length > 0) {
          found = { tier: t, occ };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      spliceLines(file, pos, ch.oldLs.length, ch.oldLs, ch.newLs, found.tier);
      cursor = pos + ch.newLs.length;
    }
    if (moveTo !== null) {
      tree.setModel(moveTo, file);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.setModel(path, file);
    }
  };
}

const V4A_SECTION = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Read a patch as a V4A patch. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const body: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (V4A_SECTION(b)) break;
        if (b === '') {
          body.push('');
          i++;
          continue;
        }
        if (b.startsWith('+')) {
          body.push(b.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push(addEdit(path, body));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const b = lines[i]!;
        if (V4A_SECTION(b)) break;
        if (blank(b)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(delEdit(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updLine = i;
      i++;
      while (i < last && blank(lines[i]!)) i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const endChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const b = lines[i]!;
        if (V4A_SECTION(b)) break;
        if (b.startsWith('@@')) {
          endChunk();
          cur = { anchor: b.slice(2).trim(), oldLs: [], newLs: [], eof: false };
          i++;
          continue;
        }
        if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          endChunk();
          i++;
          continue;
        }
        if (b === '' && cur === null && chunks.length > 0) {
          // A blank line after a closed chunk, at the end of the section,
          // is not part of it.
          i++;
          continue;
        }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, oldLs: [], newLs: [], eof: false };
          }
          if (b === '') {
            cur.oldLs.push(pl('', true));
            cur.newLs.push(pl('', true));
          } else if (b[0] === ' ') {
            cur.oldLs.push(pl(b.slice(1), true));
            cur.newLs.push(pl(b.slice(1), true));
          } else if (b[0] === '-') cur.oldLs.push(pl(b.slice(1), false));
          else cur.newLs.push(pl(b.slice(1), false));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk();
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.oldLs.length > 0 && lc.oldLs[lc.oldLs.length - 1]!.ctx && lc.oldLs[lc.oldLs.length - 1]!.text === '') {
          lc.oldLs.pop();
          lc.newLs.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine + 1}`);
      edits.push(updEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. A wrong command or a
 * missing or mistyped key is a parse fault. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.setText(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.setText(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const file = splitFile(before);
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      file.lines.splice(line, 0, ...add);
      tree.setModel(p, file);
    };
  }
  return null;
}

/** Read a patch as JSON edits: one JSON array of edit objects, or JSON
 * Lines with one edit object a line and blank lines ignored. In array form
 * any fault is a parse error at the line where the array starts; in JSON
 * Lines form a line that does not hold one valid edit object is a parse
 * error at that line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const moved = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      moved.add(o);
      moved.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
