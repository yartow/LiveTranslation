// The real TranslateFn for listener-translate.ts: English -> Hindi/Tamil/Chinese through the app's
// existing provider plumbing (sermon-translate.ts's callSermonModel: OpenAI json mode, cached Claude,
// Ollama without thinking). API keys come from the server's environment (.env: OPENAI_API_KEY /
// ANTHROPIC_API_KEY) — the hub never receives the operator page's keys.
//
// Kept apart from listener-translate.ts so that file (and its unit tests) never import a provider SDK.

import { callSermonModel, type TranslateOptions } from './sermon-translate';
import { buildSystemPrompt, buildUserMessage, parseMarkedReply, type TranslateRequest } from './listener-translate';

const BASE_TIMEOUT_MS = 20_000;
const PER_LINE_TIMEOUT_MS = 2_000;

export async function providerTranslate(req: TranslateRequest): Promise<string[]> {
  const opts: TranslateOptions = {
    targetLanguage: req.lang,
    translationProvider: req.model.provider,
    model: req.model.model,
    ollamaBaseUrl: req.ollamaBaseUrl,
    ollamaModel: req.ollamaModel,
    // Tamil and Hindi need many tokens per word; a batch must not be cut off at Claude's default cap.
    maxOutputTokens: Math.min(8192, 1024 + 600 * req.texts.length),
  };
  const signal = AbortSignal.timeout(BASE_TIMEOUT_MS + PER_LINE_TIMEOUT_MS * req.texts.length);
  const reply = await callSermonModel(buildSystemPrompt(req.lang), buildUserMessage(req.texts, req.before, req.terms), opts, signal);
  return parseMarkedReply(reply, req.texts.length);
}
