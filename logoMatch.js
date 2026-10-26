// Resolve provider ids to logo sources: codexbar.app first, the ACP agent
// registry as fallback.
//
// Provider ids come from codexbar-cli (claude, codex, opencodego, ...). The
// website names almost every logo file after the provider id, while the
// registry names agents its own way (claude-acp, codex-acp,
// github-copilot-cli, ...). Normalise both sides and look for containment
// instead of keeping an alias table in sync with the registry.
//
// Kept free of gi:// imports so it can be unit tested.

const normalise = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// codexbar.app serves one SVG per provider at /logos/<slug>.svg. Most slugs are
// the provider id; these ship under a different or themed file name.
const SITE_LOGO_SLUGS = {
  codex: "codex-dark",
  openai: "codex-dark",
  azureopenai: "codex-dark",
  factory: "droid-dark",
  opencode: "opencode-dark",
  zai: "zai-dark",
  kiro: "kiro-dark",
  synthetic: "synthetic-dark",
  abacus: "abacus-ai-dark",
  codebuff: "codebuff-dark",
  vertexai: "vertex-ai",
  jetbrains: "jetbrains-ai",
  alibabatokenplan: "alibaba",
  moonshot: "kimi",
};

/**
 * Logo file keys to try for a provider: id first, name as a last resort for
 * custom rows.
 * @param {string} providerId
 * @param {string} [providerName]
 * @returns {string[]}
 */
const logoCandidates = (providerId, providerName = "") => {
  const candidates = [];
  for (const value of [providerId, providerName]) {
    const text = String(value || "")
      .toLowerCase()
      .trim();
    const slugs = [text.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")];
    // Display names are spaced ("Command Code") while logo files are compact.
    if (/\s/.test(text)) slugs.push(text.replace(/[^a-z0-9]+/g, ""));
    for (const slug of slugs) {
      if (slug && !candidates.includes(slug)) candidates.push(slug);
    }
  }
  return candidates;
};

/**
 * Keys for the bundled icons (`media/logos/<key>-symbolic.svg`).
 * @param {string} providerId
 * @param {string} [providerName]
 * @returns {string[]}
 */
export const bundledLogoCandidates = (providerId, providerName = "") =>
  logoCandidates(providerId, providerName);

/**
 * Logo slugs to try on codexbar.app, provider id first and name as a last
 * resort for custom rows.
 * @param {string} providerId
 * @param {string} [providerName]
 * @returns {string[]}
 */
export const siteLogoCandidates = (providerId, providerName = "") => {
  const candidates = [];
  for (const slug of logoCandidates(providerId, providerName)) {
    const candidate = SITE_LOGO_SLUGS[slug] ?? slug;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
};

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
