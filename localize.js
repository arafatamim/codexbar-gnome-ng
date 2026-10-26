// Locale-aware formatting for text the extension doesn't author itself:
// labels and detail rows that arrive from codexbar-cli in English, reset
// countdowns and the panel text. Kept free of gi:// imports so it can be
// unit tested; callers pass the gettext function as `tr`.

// UI language: catalogs are read from the extension's own locale/ folder so
// the `language` setting decides, not the shell process locale.
const SUPPORTED_LANGUAGES = ["en", "es", "pt_BR"];
let _catalog = new Map();
let _language = "en";

/** Parse a GNU .mo blob (either endianness) into a msgid -> msgstr Map. */
export const parseMo = (data) => {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = view.getUint32(0, true);
  const little = magic === 0x950412de;
  if (!little && magic !== 0xde120495) return new Map();
  const count = view.getUint32(8, little);
  const originalsOffset = view.getUint32(12, little);
  const translationsOffset = view.getUint32(16, little);
  const decoder = new TextDecoder();
  const catalog = new Map();
  for (let i = 0; i < count; i++) {
    const origLength = view.getUint32(originalsOffset + i * 8, little);
    const origPosition = view.getUint32(originalsOffset + i * 8 + 4, little);
    const transLength = view.getUint32(translationsOffset + i * 8, little);
    const transPosition = view.getUint32(translationsOffset + i * 8 + 4, little);
    if (!origLength) continue; // header entry (metadata)
    const msgid = decoder.decode(u8.subarray(origPosition, origPosition + origLength));
    const msgstr = decoder.decode(u8.subarray(transPosition, transPosition + transLength));
    if (msgstr) catalog.set(msgid, msgstr);
  }
  return catalog;
};

/** Install the catalog for `lang`; `en` (or no catalog) keeps the msgids. */
export const setCatalog = (lang, catalog) => {
  _language = SUPPORTED_LANGUAGES.includes(lang) ? lang : "en";
  _catalog = _language === "en" || !catalog ? new Map() : catalog;
};

/** Load `lang` via `readFile(lang)` -> Uint8Array|null. English needs no file. */
export const applyLanguage = (lang, readFile) => {
  if (lang !== "en" && SUPPORTED_LANGUAGES.includes(lang) && readFile) {
    try {
      const bytes = readFile(lang);
      const catalog = bytes ? parseMo(bytes) : null;
      if (catalog && catalog.size > 0) {
        setCatalog(lang, catalog);
        return;
      }
    } catch (e) {
      // unreadable catalog -> full English fallback below
    }
  }
  setCatalog("en", null);
};

export const currentLanguage = () => _language;

/** Translation lookup; unknown strings fall back to the English msgid. */
export const tr = (s) => _catalog.get(s) ?? s;

/** BCP-47 tag for Intl; tied to the chosen language, not the process locale. */
const uiLocale = () => (_language === "en" ? "en" : _language.replace("_", "-"));

// Times and dates follow the session's regional settings, not the extension's
// UI language, and the hour cycle follows the desktop's clock-format setting so
// the popup matches the clock in the top bar.
let _hour12 = null;

/** @param {boolean|null} hour12 True for 12-hour clock, null to follow locale. */
export const setHour12 = (hour12) => {
  _hour12 = typeof hour12 === "boolean" ? hour12 : null;
};

const withHourCycle = (options) =>
  _hour12 === null ? options : { ...options, hour12: _hour12 };

/** Time in the session locale, e.g. "18:05" or "6:05 PM". */
export const formatClockTime = (date, options) =>
  date.toLocaleTimeString(
    undefined,
    withHourCycle(options ?? { hour: "2-digit", minute: "2-digit" }),
  );

/** Date and time in the session locale, e.g. "Oct 31, 6:35 PM". */
export const formatClockDateTime = (date, options) =>
  date.toLocaleString(
    undefined,
    withHourCycle(
      options ?? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
    ),
  );

// Marks strings for xgettext that only exist at runtime (codexbar-cli output).
const N_ = (s) => s;
export const CLI_STRINGS = [
  N_("Cloud credits"),
  N_("Session"),
  N_("Weekly"),
  N_("Monthly"),
];

/**
 * Expand a gettext template: `%s`/`%d` take the next value, `%%` is a
 * literal percent sign. Exported for callers that build strings from
 * translated templates (the extension used to call a non-existent
 * `String.prototype.format`).
 */
export const formatText = (template, ...values) => {
  let i = 0;
  return String(template).replace(/%%|%[sd]/g, (match) =>
    match === "%%" ? "%" : String(values[i++]),
  );
};

const fill = formatText;

/** Whole percentage points: usage is never precise enough for decimals. */
export const formatPercent = (value) =>
  Number(value || 0).toLocaleString(uiLocale(), { maximumFractionDigits: 0 });

/**
 * Relative age for "Updated …" lines: "just now", "5m ago", "3h ago",
 * "1d 12h ago".
 * @param {number} seconds
 * @param {(s: string) => string} tr
 */
export const formatRelativeTime = (seconds, tr) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return tr("just now");
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return fill(tr("%dm ago"), minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return fill(tr("%dh ago"), hours);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? fill(tr("%dd %dh ago"), days, rest) : fill(tr("%dd ago"), days);
};

/** Compact duration: "45min", "3h 9min", "5d 1h". */
export const formatDuration = (seconds) => {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m ? `${hours}h ${m}min` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days}d ${h}h` : `${days}d`;
};

/**
 * "Resets in 3h 9min". Computed at render time so the countdown doesn't go
 * stale between refreshes.
 */
export const formatResetIn = (resetAfterSeconds, elapsedSeconds, tr) => {
  const seconds = (resetAfterSeconds || 0) - (elapsedSeconds || 0);
  if (!(seconds > 0)) return "";
  return fill(tr("Resets in %s"), formatDuration(seconds));
};

/** Window labels, built by the extension or sent by the CLI ("Gemini 5-hour"). */
export const localizeLabel = (label, tr) => {
  if (!label) return label;
  const direct = tr(label);
  if (direct !== label) return direct;
  let m;
  // "Window" is dropped from the labels; older payloads still carry it.
  if ((m = /^(\d+)-Hour(?: Window)?$/i.exec(label))) return fill(tr("%d-Hour"), m[1]);
  if ((m = /^(\d+)-Day(?: Window)?$/i.exec(label))) return fill(tr("%d-Day"), m[1]);
  if (/^Usage Window$/i.test(label)) return tr("Usage");
  if (/^Weekly Window$/i.test(label)) return tr("Weekly");
  // CLI-provided names ("Gemini 5-hour") are only rewritten when the
  // language actually has a translation; English keeps the CLI's wording.
  const translated = (template) => {
    const t = tr(template);
    return t !== template ? t : null;
  };
  let t;
  if ((m = /^(.+?) (\d+)-hour$/i.exec(label)) && (t = translated(N_("%s · %d hours"))))
    return fill(t, m[1], m[2]);
  if ((m = /^(.+?) weekly$/i.exec(label)) && (t = translated(N_("%s · weekly"))))
    return fill(t, m[1]);
  return label;
};

const money = (amount) => {
  try {
    return Number(amount).toLocaleString(uiLocale(), { style: "currency", currency: "USD" });
  } catch (e) {
    return `$${amount}`;
  }
};

/** Detail rows from the CLI ("$99.97 of $100.00 remaining", "Expires <ISO date>"). */
export const localizeDetail = (text, tr) => {
  if (!text) return text;
  let m;
  if ((m = /^\$([\d.,]+) of \$([\d.,]+) remaining$/i.exec(text))) {
    const parse = (s) => Number(s.replace(/,/g, ""));
    return fill(tr("%s of %s remaining"), money(parse(m[1])), money(parse(m[2])));
  }
  if ((m = /^Expires (\S+)$/i.exec(text))) {
    const date = new Date(m[1]);
    if (!Number.isNaN(date.getTime())) {
      const when = date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      return fill(tr("Expires %s"), when);
    }
  }
  return tr(text);
};

/** Panel text: "5h 7% · 7d 6% in 3h 9min". */
export const formatPanelText = (usage, displayMode, elapsedSeconds, tr = (s) => s) => {
  if (!usage) return "";
  const parts = [];
  let resetSeconds = null;
  for (const tier of ["primary", "secondary"]) {
    const win = usage[tier];
    if (!win || win.usedPercent === undefined) continue;
    // Placeholder tiers (e.g. OpenRouter's balance) aren't usage windows.
    if (!win.windowSeconds && win.usedPercent === 0) continue;
    const used = Math.min(100, Math.max(0, parseFloat(win.usedPercent) || 0));
    const percent = Math.round(displayMode === "remaining" ? 100 - used : used);
    const hours = Math.round((win.windowSeconds || 0) / 3600);
    const label = !hours ? "" : hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
    parts.push(label ? `${label} ${percent}%` : `${percent}%`);
    if (resetSeconds === null) resetSeconds = (win.resetAfterSeconds || 0) - (elapsedSeconds || 0);
  }
  if (parts.length > 0) {
    let text = parts.join(" · ");
    if (resetSeconds > 0) text += fill(tr(" in %s"), formatDuration(resetSeconds));
    return text;
  }

  // Balance-only providers (e.g. DeepSeek) or plain provider cost.
  const balance = usage.primary?.resetDescription?.match(/^\$[0-9.]+/);
  if (balance) return balance[0];
  if (usage.providerCost && typeof usage.providerCost.used === "number") {
    const symbol = usage.providerCost.currencyCode === "USD" ? "$" : "";
    return `${symbol}${usage.providerCost.used.toFixed(2)}`;
  }
  return "";
};
