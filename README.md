# Ember Mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/pranatakripto95/ember-mend/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/pranatakripto95/ember-mend/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

<!-- SPDX-License-Identifier: MIT -->

mend is one command-line patch tool for every AI edit format, built for the
make.fun [hidden-spec-cli-01-run-20261122](https://make.fun/c/hidden-spec-cli-01-run-20261122)
bounty. `SPEC.md` is the whole contract.

Models write edits in four formats, and each public applier reads only one
of them: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. mend reads
all four, finds the line numbers each edit really belongs on, and writes the
edits — every file changed, or none at all.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file; absent or `-` reads the patch from stdin.
- `--format=unified|search-replace|v4a|json|auto` (default `auto`) picks the
  format; `auto` detects it from the patch text.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Matching

An edit's old lines are found at the first of three tiers where they occur
at least once: exact lines, lines equal once trailing spaces and tabs are
removed, then lines equal once leading and trailing spaces and tabs are
removed. At the third tier, added lines are re-indented to the file's own
indentation. Unified hunks take the occurrence nearest the (possibly wrong)
line number the diff names; SEARCH/REPLACE fails as ambiguous when the old
lines occur more than once; V4A chunks walk forward from a cursor and an
anchor line.

## Exit codes and output

- `0`: the tree is written. One line per changed path (`A`, `D`, `M`, or
  `R old -> new` for a move), then `ok: <n> files`.
- `1`: nothing written. One `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. A failed edit changes nothing, and the edits
  after it still run.
- `2`: nothing written, one line: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines
  hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the
  checks from the env, runs `node main.ts` on each one in a fresh directory,
  and posts what it did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

- `SPEC.md`: the specification.
- `LICENSE`: MIT.
