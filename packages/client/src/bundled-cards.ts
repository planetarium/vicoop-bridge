import claudeCard from '../cards/claude.json' with { type: 'json' };
import codexCard from '../cards/codex.json' with { type: 'json' };
import echoCard from '../cards/echo.json' with { type: 'json' };
import openclawCard from '../cards/openclaw.json' with { type: 'json' };
import vicoopCodexCard from '../cards/vicoop-codex.json' with { type: 'json' };

// Cards bundled with this package, keyed by backend kind. Static imports
// (instead of an `import.meta.url`-relative fs read) so `bun build --compile`
// embeds the JSON into the single-file release binary — an fs lookup against
// Bun's virtual root returns nothing once compiled, leaving the daemon's
// hello frame without an inline `agentCard` and silently defeating the
// openai-compat/v1 `params.models` advertise (planetarium/oai2a2a#63) the
// hello-time merge would otherwise apply. Operator-supplied `--card <path>`
// stays fs-based — that's an explicit runtime path.
export const BUNDLED_CARDS: Record<string, unknown> = {
  claude: claudeCard,
  codex: codexCard,
  echo: echoCard,
  openclaw: openclawCard,
  'vicoop-codex': vicoopCodexCard,
};

export function resolveBundledCard(backendKind: string): unknown | null {
  return BUNDLED_CARDS[backendKind] ?? null;
}
