# Fan-Out Patterns (Workflow tool)

Load when authoring a fan-out. Concrete, copy-adaptable shapes. Default to `pipeline()`; reach for a
barrier (`parallel()` between stages) only when a stage needs the whole set.

## Pipeline — the default (no barrier between stages)

Each item flows through all stages independently; item A can be at stage 3 while B is at stage 1.
Wall-clock ≈ the slowest single item's chain, not the sum of slowest-per-stage.

```js
export const meta = { name: 'cover-modules', description: 'test every untested module',
  phases: [{title:'Find gap'},{title:'Write'},{title:'Verify'}] }

const items = args.items                                   // scouted inline, passed in
const results = await pipeline(items,
  (item)            => agent(`Find the untested behavior in ${item}. Return {behavior}`,
                             {phase:'Find gap', schema: GAP}),
  (gap, item)       => agent(`Write one test for: ${gap.behavior} in ${item}.`,
                             {phase:'Write', schema: TEST, isolation:'worktree'}),
  (test, item)      => agent(`Mutation-check the test for ${item}: break the code, it must fail.`,
                             {phase:'Verify', schema: VERDICT}).then(v => ({item, test, ok: v.canFail})),
)
const covered = results.filter(Boolean)                    // dead items → null; keep the count
return { covered, failed: results.length - covered.length }
```

Every stage callback gets `(prevResult, originalItem, index)` — use `originalItem`/`index` to label work
in later stages without threading it through returns. A stage that throws drops THAT item to `null` and
skips its remaining stages (the other items are unaffected).

## Barrier — only when a stage needs the full set

Justified for: dedup/merge across all items before expensive downstream work, or an early-exit on total
count ("0 findings → skip verification entirely"). NOT justified by "I need to flatten/map first" (do that
inside a pipeline stage).

```js
const all = (await parallel(items.map(it => () => agent(findPrompt(it), {schema: FINDINGS}))))
  .filter(Boolean).flatMap(r => r.findings)
const deduped = dedupeByFileLine(all)                      // <-- genuinely needs ALL at once
if (!deduped.length) return { findings: [] }               // early-exit the whole verify phase
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT})))
```

`parallel()` is a barrier: it awaits all thunks. A thunk that throws resolves to `null` (the call never
rejects) — always `.filter(Boolean)` before using results, and note how many you filtered.

## Concurrency cap — bound simultaneity, not total

The runtime caps concurrent agents at ~min(16, cores−2). For heavy (worktree) items, set a tighter cap so
a wide list doesn't trip API rate limits or exhaust disk. You still pass ALL items; only how many run at
once is bounded (excess queue). A simple gate:

```js
const CAP = 4
async function mapCapped(items, fn) {
  const out = []; let i = 0
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) } }
  await Promise.all(Array.from({length: Math.min(CAP, items.length)}, worker))
  return out
}
```

(Inside a Workflow, `pipeline`/`parallel` already schedule under the global cap; use an explicit gate only
when you need a tighter per-phase limit than the default.)

## Per-item loop-until-dry (fan-out × converge-loop)

Each item gets its own bounded convergence loop; the fan-out runs those loops concurrently.

```js
const MAX_ROUNDS = 6                                        // every loop needs a HARD iteration cap
await parallel(items.map(item => () => (async () => {
  const seen = new Set(); let dry = 0, rounds = 0
  // stop on: 2 dry rounds (done) OR the round cap OR budget floor — a bare `while (dry < 2)` is a runaway.
  while (dry < 2 && rounds++ < MAX_ROUNDS && (!budget.total || budget.remaining() > 50_000)) {
    const found = await agent(`Find next issue in ${item}, excluding ${[...seen]}. {items}`, {schema:F})
    if (!found || !found.items?.length) { dry++; continue }  // null = agent died → a dry round, never a crash (found.items would throw)
    const fresh = found.items.filter(x => !seen.has(x.id))
    if (!fresh.length) { dry++; continue }
    dry = 0; fresh.forEach(x => seen.add(x.id))
    // SEQUENTIAL: every fix for ONE item shares that item's write scope — running them in parallel would
    // race the same files (worktree isolation can't help; the edits must land together). Items stay parallel.
    for (const x of fresh) await agent(`Fix ${x.desc} in ${item}.`)
  }
  return { item, resolved: seen.size, exhausted: rounds >= MAX_ROUNDS }
})()))
```

## Map-reduce

Map produces per-item partials; reduce merges over the full covered set (in the coordinator, or a final
agent for a semantic merge).

```js
const partials = (await pipeline(items, mapStage)).filter(Boolean)
const merged = reduceLocally(partials)                     // dedup/sum/concat — plain code where possible
// or, for a judgment merge: await agent(`Synthesize these ${partials.length} partial reports: …`)
return { merged, covered: partials.length, failed: items.length - partials.length }
```

## Lighter equivalent — single-message Agent batch

For a modest list where a Workflow is overkill: issue N `Agent(...)` calls in ONE assistant message —
they run in the background by default (so, concurrently); add `isolation:'worktree'` for writers. (There
is no `run_in_background` on the Agent tool — that is a Bash-tool parameter; Agent backgrounding is the
default.) Same rules — prove independence, isolate writers, aggregate every lane (including failures).
Beyond ~a dozen items or multi-stage per item, prefer the Workflow for the caps + accounting.

## The invariant across all shapes

`items discovered` must equal `covered + failed + dropped` in the final report. If those don't add up,
something was silently lost — find it before reporting.
