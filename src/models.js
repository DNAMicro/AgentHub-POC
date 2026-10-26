// Models an agent may be configured to use. Each one accepts exactly what callModel() sends
// (output_config.effort "low", structured outputs, no sampling parameters, no thinking settings), so
// switching is a configuration change only. Anything not listed is refused at startup — older models
// (e.g. Claude Haiku 4.5, which has no effort parameter) would reject our requests.
//
// Prices are USD per million tokens from Anthropic's official list, checked 2026-10-26. Haiku's
// price is for prompts up to 100K tokens; this app's prompts are far smaller. Dependency-free so the
// configuration loader can validate names without loading the SDK.
export const MODELS = {
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5', inputPerMTok: 0.10, outputPerMTok: 0.50 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', inputPerMTok: 2, outputPerMTok: 10 },
  'claude-opus-5-5': { label: 'Claude Opus 5.5', inputPerMTok: 4, outputPerMTok: 20 },
};
export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const DEFAULT_KEY_ENV = 'ANTHROPIC_API_KEY';
