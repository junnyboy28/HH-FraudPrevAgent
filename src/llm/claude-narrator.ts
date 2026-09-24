// Claude-backed narrator for the case summary and the SAR narrative.
//
// Cost control is a design goal here, not an afterthought:
//   - Two call types only. Pattern detection, action selection and routing are
//     deterministic, so the model is used for prose and nothing else.
//   - The SAR narrative is only generated for the cases that actually file one,
//     which is about five of twenty.
//   - Every response is cached to disk under .llm-cache/, keyed on a hash of
//     the exact prompt. Re-running the benchmark costs nothing.
//   - Hard max_tokens per call, because the outputs are deliberately short.
//   - Haiku 4.5 by default. Override with LLM_MODEL in .env.
//
// A full uncached run is roughly 25 calls at a few thousand input tokens each,
// which is single-digit cents on Haiku. Every run after that is free unless the
// evidence changes.
//
// The model never invents evidence: it is given the assembled evidence bundle
// and instructed to write only from it. If the call fails for any reason the
// TemplateNarrator output is used, so the benchmark can never be blocked by the
// API being unavailable.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NarrationInput, Narrator } from '../orchestrator/case-orchestrator.js';
import { TemplateNarrator } from './template-narrator.js';
import { CASE_SUMMARY_SYSTEM, SAR_NARRATIVE_SYSTEM, buildEvidenceBrief } from './prompts/narration.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CACHE_DIR = path.join(REPO_ROOT, '.llm-cache');

/** Haiku 4.5. These are short prose tasks, so the cheapest current model fits. */
const DEFAULT_MODEL = 'claude-haiku-4-5';
/** Two to six sentences. */
const SUMMARY_MAX_TOKENS = 600;
/** Six to twelve sentences. */
const NARRATIVE_MAX_TOKENS = 1000;

function envVar(name: string): string {
  const file = path.join(REPO_ROOT, '.env');
  if (!existsSync(file)) return process.env[name] ?? '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    if (line.slice(0, line.indexOf('=')).trim() === name) {
      return line.slice(line.indexOf('=') + 1).trim();
    }
  }
  return process.env[name] ?? '';
}

export class ClaudeNarrator implements Narrator {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly fallback = new TemplateNarrator();
  private inputTokens = 0;
  private outputTokens = 0;
  private calls = 0;
  private cacheHits = 0;
  private failures = 0;

  constructor(apiKey = envVar('ANTHROPIC_API_KEY'), model = envVar('LLM_MODEL') || DEFAULT_MODEL) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  static isConfigured(): boolean {
    return envVar('ANTHROPIC_API_KEY') !== '';
  }

  /** Tokens charged for this run, for the answer file's `tokens` field. */
  get tokensUsed(): number {
    return this.inputTokens + this.outputTokens;
  }

  /** What the run actually cost, for the console summary. */
  get stats(): {
    model: string;
    calls: number;
    cacheHits: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
  } {
    return {
      model: this.model,
      calls: this.calls,
      cacheHits: this.cacheHits,
      failures: this.failures,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }

  private cachePath(kind: string, prompt: string): string {
    const key = createHash('sha256').update(`${this.model}\u0000${kind}\u0000${prompt}`).digest('hex');
    return path.join(CACHE_DIR, `${kind}-${key.slice(0, 32)}.txt`);
  }

  /**
   * One short completion, cached on disk. A cache hit costs nothing and is not
   * counted in the token totals, so the reported figure is real spend.
   */
  private async complete(kind: string, system: string, prompt: string, maxTokens: number): Promise<string | null> {
    const cacheFile = this.cachePath(kind, prompt);
    if (existsSync(cacheFile)) {
      this.cacheHits += 1;
      return readFileSync(cacheFile, 'utf8');
    }
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      this.calls += 1;
      this.inputTokens += response.usage.input_tokens;
      this.outputTokens += response.usage.output_tokens;
      if (response.stop_reason === 'refusal') {
        this.failures += 1;
        return null;
      }
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (text === '') {
        this.failures += 1;
        return null;
      }
      writeFileSync(cacheFile, text, 'utf8');
      return text;
    } catch (err) {
      // A narrative is not worth failing a case over: the deterministic
      // narrator still produces a valid, evidence-derived answer file.
      this.failures += 1;
      if (this.failures <= 2) {
        console.warn(
          `  LLM ${kind} failed (${err instanceof Error ? err.message : String(err)}), using the template narrator`,
        );
      }
      return null;
    }
  }

  async summarize(input: NarrationInput): Promise<string> {
    const text = await this.complete(
      'summary',
      CASE_SUMMARY_SYSTEM,
      buildEvidenceBrief(input),
      SUMMARY_MAX_TOKENS,
    );
    return text ?? this.fallback.summarize(input);
  }

  async sarNarrative(input: NarrationInput): Promise<string> {
    const text = await this.complete(
      'sar',
      SAR_NARRATIVE_SYSTEM,
      buildEvidenceBrief(input),
      NARRATIVE_MAX_TOKENS,
    );
    return text ?? this.fallback.sarNarrative(input);
  }
}
