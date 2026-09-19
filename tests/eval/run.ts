import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import '../../scripts/load-env';
import { providerFromEnv, providerFailureReason } from '../../packages/jev/src';
import { rank } from '../../packages/retrieval/src';
import { CandidateSchema, hash } from '../../packages/contracts/src';
const live = process.argv.includes('--live');
const provider = (() => {
  try {
    return providerFromEnv({ ...process.env, PROVIDER_MODE: live ? 'live' : 'mock' });
  } catch (error) {
    console.error(
      `Evaluation not run: ${(error as Error).message}. No mock results are reported as live.`,
    );
    process.exit(2);
  }
})();
const Task = z.object({
  id: z.string(),
  split: z.enum(['dev', 'held_out']),
  template: z.string(),
  question: z.string(),
  expectedId: z.string().nullable(),
  expectedQuote: z.string().nullable(),
  candidates: z.array(
    z.object({
      kind: z.enum(['passage', 'control']),
      label: z.string(),
      text: z.string().nullable(),
      headingPath: z.array(z.string()),
    }),
  ),
});
const tasks = z.array(Task).parse(JSON.parse(await readFile('tests/eval/tasks.json', 'utf8')));
const rows: Array<{
  id: string;
  split: string;
  template: string;
  answerable: boolean;
  expectedId: string | null;
  selectedId: string | null;
  direct: boolean;
  top1: boolean;
  top3: boolean;
  exact: boolean;
  lexicalTop1: boolean;
  lexicalTop3: boolean;
  falseDirect: boolean;
  latencyMs: number;
  calls: number;
  bytes: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}> = [];
for (const t of tasks) {
  const candidates = t.candidates.map((c, i) =>
    CandidateSchema.parse({
      ...c,
      text: c.text || undefined,
      id: `c${i}`,
      snapshotId: t.id,
      context: '',
      visibility: 'visible',
      actionPolicy: c.kind === 'control' ? 'highlight_only' : 'read_candidate',
      provenance: 'live_dom',
      contentHash: hash(c.text || c.label),
    }),
  );
  const started = performance.now();
  const budget = { calls: 0, bytes: 0, inputTokens: 0, outputTokens: 0 };
  const lexical = rank(t.question, candidates);
  let selection: string | undefined,
    verified = false,
    error: string | undefined;
  try {
    const d = await provider.select(t.question, candidates, AbortSignal.timeout(20000), budget);
    selection = d.candidate?.id;
    verified = d.verified ?? d.support >= 0.85;
  } catch (cause) {
    error = providerFailureReason(cause);
  }
  const alternatives = [selection, ...lexical.map((x) => x.candidate.id)]
    .filter((id, index, array) => id && array.indexOf(id) === index)
    .slice(0, 3);
  rows.push({
    id: t.id,
    split: t.split,
    template: t.template,
    answerable: !!t.expectedId,
    expectedId: t.expectedId,
    selectedId: selection || null,
    direct: verified,
    top1: !!t.expectedId && selection === t.expectedId,
    top3: !!t.expectedId && alternatives.includes(t.expectedId),
    exact:
      !!t.expectedId &&
      selection === t.expectedId &&
      (candidates.find((c) => c.id === selection)?.text ||
        candidates.find((c) => c.id === selection)?.label) === t.expectedQuote,
    lexicalTop1: !!t.expectedId && lexical[0]?.candidate.id === t.expectedId,
    lexicalTop3: !!t.expectedId && lexical.slice(0, 3).some((x) => x.candidate.id === t.expectedId),
    falseDirect: !t.expectedId && verified,
    latencyMs: performance.now() - started,
    ...budget,
    error,
  });
  if (error === 'provider_rate_limited') break;
}
function summarize(split: string) {
  const set = split === 'all' ? rows : rows.filter((r) => r.split === split);
  const answerable = set.filter((x) => x.answerable),
    negative = set.filter((x) => !x.answerable);
  const times = set.map((x) => x.latencyMs).sort((a, b) => a - b);
  return {
    tasks: set.length,
    answerable: answerable.length,
    unanswerable: negative.length,
    top1: answerable.filter((x) => x.top1).length,
    top3: answerable.filter((x) => x.top3).length,
    exactPassage: answerable.filter((x) => x.exact).length,
    answerableRecall: answerable.filter((x) => x.top1 && x.direct).length,
    falseDirect: negative.filter((x) => x.falseDirect).length,
    lexicalTop1: answerable.filter((x) => x.lexicalTop1).length,
    lexicalTop3: answerable.filter((x) => x.lexicalTop3).length,
    p50Ms: times[Math.floor(times.length * 0.5)],
    p95Ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))],
    providerErrors: set.filter((x) => x.error).length,
    inputTokens: set.reduce((n, x) => n + x.inputTokens, 0),
    outputTokens: set.reduce((n, x) => n + x.outputTokens, 0),
  };
}
const report = {
  generatedAt: new Date().toISOString(),
  status: rows.length === tasks.length && !rows.some((r) => r.error) ? 'complete' : 'incomplete',
  plannedTasks: tasks.length,
  mode: provider.mode,
  transport: provider.transport,
  model: live
    ? process.env.JEV_MODEL || (provider.transport === 'gateway' ? 'typesafe-ai/jev' : 'jev-1.13.0')
    : 'deterministic-keyword-v1',
  note: 'Offline candidate-selection corpus. No crawling or highlight-resolution claim. Top-3 is selected candidate plus lexical alternatives. Mock results only demonstrate the deterministic pipeline; they do not evaluate Jev. Template-level held-out split was fixed before evaluation. Small sample; no production accuracy claim.',
  metrics: { all: summarize('all'), dev: summarize('dev'), held_out: summarize('held_out') },
  rows,
};
await mkdir('docs/reports', { recursive: true });
const output = `docs/reports/evaluation-${live ? 'live' : 'mock'}.json`;
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    { output, status: report.status, mode: report.mode, metrics: report.metrics },
    null,
    2,
  ),
);
if (report.status !== 'complete') {
  console.error(
    'Evaluation incomplete: provider errors invalidate the aggregate semantic metrics.',
  );
  process.exitCode = 1;
}
