// Runs the 20 cases in data/HHGOA_IEEE/case_pack.csv through the orchestrator
// and writes one answer file per case to cases/<case_id>.json. That folder is
// the graded deliverable, so the schema in agent.md section 6 is a hard
// contract: missing fields score zero.
//
// Usage:
//   npm run benchmark              write cases/, and to the graph if configured
//   npm run benchmark -- --no-graph   skip the graph write

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseOrchestrator, type AnswerFile } from '../src/orchestrator/case-orchestrator.js';
import { ClaudeNarrator } from '../src/llm/claude-narrator.js';
import { TemplateNarrator } from '../src/llm/template-narrator.js';
import { LocalEvidenceSource } from '../src/tools/local-evidence-source.js';
import { TigerGraphCaseWriter } from '../src/memory/tigergraph-case-writer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO_ROOT, 'cases');

async function main(): Promise<void> {
  const skipGraph = process.argv.includes('--no-graph');
  mkdirSync(OUT_DIR, { recursive: true });

  const evidence = new LocalEvidenceSource();
  // Claude writes the prose when a key is configured; the deterministic
  // narrator is the fallback so a missing key or a failed call can never block
  // the deliverable. Responses are cached to disk, so re-runs are free.
  const useLlm = !process.argv.includes('--no-llm') && ClaudeNarrator.isConfigured();
  const narrator = useLlm ? new ClaudeNarrator() : new TemplateNarrator();
  console.log(
    narrator instanceof ClaudeNarrator
      ? `narrator: Claude (${narrator.stats.model}), responses cached in .llm-cache/ so re-runs are free`
      : 'narrator: deterministic templates (no ANTHROPIC_API_KEY, or --no-llm)',
  );
  const writer = !skipGraph && TigerGraphCaseWriter.isConfigured() ? new TigerGraphCaseWriter() : null;
  if (writer === null) {
    console.log('note: no graph writer (either --no-graph, or .env has no TigerGraph host/secret)');
  }

  const pack = await evidence.getCasePack();
  console.log(`running ${pack.length} cases\n`);
  console.log('case     verdict     prob pattern                      exp($)  initial -> final actions                       SAR');
  console.log('-------- ---------- ----- ---------------------------- ------- ---------------------------------------------- ---');

  const answers: AnswerFile[] = [];
  for (const entry of pack) {
    const orchestrator = new CaseOrchestrator(evidence, narrator, writer);
    const answer = await orchestrator.run(entry);
    answers.push(answer);
    writeFileSync(path.join(OUT_DIR, `${answer.case_id}.json`), JSON.stringify(answer, null, 2) + '\n', 'utf8');

    const initial = answer.next_best_actions.initial.map((a) => a.action).join('+') || '(none)';
    const final = answer.next_best_actions.final.map((a) => a.action).join('+') || '(none)';
    const arrow = initial === final ? final : `${initial} -> ${final}`;
    console.log(
      `${answer.case_id} ${answer.case.verdict.padEnd(10)} ${answer.case.fraud_probability.toFixed(2)} ` +
      `${answer.case.pattern.padEnd(28)} ${answer.case.exposure_usd.toFixed(2).padStart(7)} ` +
      `${arrow.slice(0, 46).padEnd(46)} ${answer.sar.file ? 'YES' : ' no'}`,
    );
  }

  // The README warns that roughly half the exam cases are legitimate and that an
  // agent which blocks everything scores badly, so print the spread.
  const byVerdict = new Map<string, number>();
  for (const a of answers) byVerdict.set(a.case.verdict, (byVerdict.get(a.case.verdict) ?? 0) + 1);
  const blocks = answers.filter((a) => a.next_best_actions.final.some((x) => x.action.startsWith('BLOCK'))).length;
  const sars = answers.filter((a) => a.sar.file).length;
  const changed = answers.filter((a) => a.next_best_actions.what_changed !== 'nothing').length;
  const escalated = answers.filter((a) => a.case.status === 'escalated').length;

  console.log('\n--- spread ---');
  console.log(`verdicts: ${[...byVerdict.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`cards blocked: ${blocks}/${answers.length}   SARs filed: ${sars}   escalated: ${escalated}`);
  console.log(`recommendation changed after evidence: ${changed}/${answers.length}`);
  console.log(`total tool calls: ${answers.reduce((s, a) => s + a.tool_calls, 0)}`);

  if (narrator instanceof ClaudeNarrator) {
    const st = narrator.stats;
    // Haiku 4.5 is $1 per MTok in, $5 per MTok out.
    const cost = (st.inputTokens / 1e6) * 1 + (st.outputTokens / 1e6) * 5;
    console.log(
      `LLM: ${st.calls} calls, ${st.cacheHits} cached, ${st.failures} failed, ` +
        `${st.inputTokens} in / ${st.outputTokens} out tokens, about $${cost.toFixed(4)} spent this run`,
    );
  }
  console.log(`\nwrote ${answers.length} answer files to cases/`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
