// Match a provider against the ACP agent registry.
//
// Provider ids come from codexbar-cli (claude, codex, opencodego, ...) and the
// registry names agents its own way (claude-acp, codex-acp, github-copilot-cli,
// ...), so neither ids nor names line up exactly. Normalise both sides and look
// for containment instead of keeping an alias table in sync with the registry.
//
// Kept free of gi:// imports so it can be unit tested.

const normalise = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// Two-letter fragments such as "go" match half the registry, so require four
// characters on both sides of a containment test.
const MIN_LENGTH = 4;

/**
 * Pick the registry agent whose id or name best matches a provider.
 * @param {Array<{id: string, name?: string, icon?: string}>} agents
 * @param {string} providerId
 * @param {string} [providerName]
 * @returns {object|null} The matching registry entry, or null.
 */
export const matchAgent = (agents, providerId, providerName = "") => {
  const keys = [normalise(providerId), normalise(providerName)].filter(
    (key) => key.length >= MIN_LENGTH
  );
  if (keys.length === 0) return null;

  let best = null;
  for (const agent of agents || []) {
    if (!agent?.icon) continue;
    const id = normalise(agent.id);
    // "claude-acp" and "claude" are the same agent to a user.
    const idBase = id.endsWith("acp") ? id.slice(0, -3) : id;
    const name = normalise(agent.name);

    for (const key of keys) {
      let score = 0;
      if (key === idBase || key === name) score = 3;
      else if (
        (idBase.length >= MIN_LENGTH &&
          (key.includes(idBase) || idBase.includes(key))) ||
        (name.length >= MIN_LENGTH && (key.includes(name) || name.includes(key)))
      )
        score = 2;
      if (score === 0) continue;

      // Prefer the closer match, then the shorter id: "opencode" beats
      // "opencode-v2" for an "opencodego" provider.
      if (
        !best ||
        score > best.score ||
        (score === best.score && String(agent.id).length < String(best.agent.id).length)
      ) {
        best = { score, agent };
      }
    }
  }
  return best?.agent ?? null;
};
