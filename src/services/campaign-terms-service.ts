import fs from 'fs';
import path from 'path';

export interface CampaignTerms {
  /**
   * Explicit, curated list of terms that are actually sent to Deepgram.
   *
   * This must remain small enough to stay below Deepgram's combined
   * keyterm token limit.
   */
  keyterms?: string[];

  party?: string[];

  pf2e?: {
    core?: string[];
    combat?: string[];
    actions?: string[];
    traits?: string[];
    conditions?: string[];
    magic?: string[];
    character?: string[];
    skills?: string[];
    [category: string]: string[] | undefined;
  };

  npcs?: string[];
  locations?: string[];
  items?: string[];
  abilities?: string[];
  factions?: string[];
  general?: string[];

  /**
   * Deepgram Find & Replace rules.
   *
   * Example:
   * {
   *   "casane": "Kasane"
   * }
   */
  replacements?: Record<string, string>;
}

export class CampaignTermsService {
  private static readonly FILE_PATH = path.resolve(
    process.cwd(),
    'data',
    'campaign-terms.json',
  );

  /**
   * Load campaign vocabulary.
   *
   * A missing or invalid file never stops transcription.
   */
  static load(): CampaignTerms {
    try {
      if (!fs.existsSync(this.FILE_PATH)) {
        console.warn(
          `[CampaignTerms] No campaign terms file at ${this.FILE_PATH} — continuing without keyterms.`,
        );
        return {};
      }

      const raw = fs.readFileSync(this.FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as CampaignTerms;

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        console.warn(
          '[CampaignTerms] campaign-terms.json must contain a JSON object — ignoring it.',
        );
        return {};
      }

      return parsed;
    } catch (error) {
      console.error(
        '[CampaignTerms] Failed to load campaign-terms.json — continuing without campaign terms:',
        error,
      );
      return {};
    }
  }

  /**
   * Conservative keyterm token estimate.
   *
   * Deepgram's hard limit is 500 combined tokens. We intentionally
   * keep a lower internal budget so small tokenizer differences do not
   * cause a request rejection.
   */
  private static estimateTokens(term: string): number {
    const cleaned = term.trim();

    if (!cleaned) {
      return 0;
    }

    // Conservative approximation for multilingual text.
    return Math.max(1, Math.ceil(cleaned.length / 3));
  }

  /**
   * Add a single keyterm if the conservative budget allows it.
   */
  private static appendKeyterm(
    params: URLSearchParams,
    term: string,
    state: { estimatedTokens: number },
  ): boolean {
    const cleaned = term.trim();

    if (!cleaned) {
      return false;
    }

    const estimatedTokens = this.estimateTokens(cleaned);

    /**
     * Deepgram's documented hard limit is 500 tokens.
     * We deliberately stay below it.
     */
    const SAFE_TOKEN_BUDGET = 300;

    if (
      state.estimatedTokens + estimatedTokens >
      SAFE_TOKEN_BUDGET
    ) {
      return false;
    }

    params.append('keyterm', cleaned);
    state.estimatedTokens += estimatedTokens;

    return true;
  }

  /**
   * Apply the curated campaign vocabulary to a Deepgram request.
   *
   * IMPORTANT:
   * Only the explicit `keyterms` array is sent.
   *
   * The larger party/NPC/location/PF2e arrays remain campaign data,
   * but they do not automatically consume Deepgram's keyterm budget.
   */
  static applyToParams(
    params: URLSearchParams,
    terms: CampaignTerms,
  ): void {
    const uniqueTerms = new Set<string>();

    if (Array.isArray(terms.keyterms)) {
      for (const value of terms.keyterms) {
        if (typeof value !== 'string') {
          continue;
        }

        const cleaned = value.trim();

        if (cleaned) {
          uniqueTerms.add(cleaned);
        }
      }
    }

    const state = {
      estimatedTokens: 0,
    };

    let skippedKeyterms = 0;

    for (const term of uniqueTerms) {
      if (!this.appendKeyterm(params, term, state)) {
        skippedKeyterms++;
      }
    }

    if (uniqueTerms.size === 0) {
      console.log(
        '[CampaignTerms] No explicit keyterms configured.',
      );
    } else {
      console.log(
        `[CampaignTerms] Loaded ${
          uniqueTerms.size - skippedKeyterms
        } keyterms (estimated ${state.estimatedTokens} tokens).`,
      );
    }

    if (skippedKeyterms > 0) {
      console.warn(
        `[CampaignTerms] Keyterm budget reached; skipped ${skippedKeyterms} lower-priority terms.`,
      );
    }

    /**
     * Find & Replace
     *
     * These are independent of the keyterm token budget.
     */
    const replacements = terms.replacements;

    if (!replacements || typeof replacements !== 'object') {
      return;
    }

    const entries = Object.entries(replacements);
    const MAX_REPLACEMENTS = 200;

    for (const [find, replacement] of entries.slice(
      0,
      MAX_REPLACEMENTS,
    )) {
      if (
        typeof find !== 'string' ||
        typeof replacement !== 'string'
      ) {
        continue;
      }

      const normalizedFind = find.trim().toLowerCase();
      const normalizedReplacement = replacement.trim();

      if (!normalizedFind || !normalizedReplacement) {
        continue;
      }

      params.append(
        'replace',
        `${normalizedFind}:${normalizedReplacement}`,
      );
    }

    if (entries.length > MAX_REPLACEMENTS) {
      console.warn(
        `[CampaignTerms] ${entries.length} replacements configured; only the first ${MAX_REPLACEMENTS} will be sent.`,
      );
    }
  }
}