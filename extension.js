// Panel indicator, popup menu and refresh loop for CodexBar.

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Atk from "gi://Atk";
import Pango from "gi://Pango";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { BarLevel } from "resource:///org/gnome/shell/ui/barLevel.js";
import {
  calculateUsagePace,
  deriveCreditsPercent,
  normalizeDetailSections,
  UsageApiClient,
} from "./usageApi.js";
import { loadToken, nullTokenSchema } from "./secret.js";
import { LogoCache } from "./logos.js";
import {
  applyLanguage,
  currentLanguage,
  formatPanelText,
  formatRelativeTime,
  formatPercent,
  formatReset,
  formatText,
  localizeDetail,
  localizeLabel,
  setCatalog,
  setHour12,
  tr as _,
} from "./localize.js";

// Debug trace is opt-in: set CODEXBAR_DEBUG=1 before starting the shell
// (e.g. `CODEXBAR_DEBUG=1 gnome-shell --devkit`) to enable it.
function logDev(msg) {
  if (GLib.getenv("CODEXBAR_DEBUG")) console.debug(`[CodexBar] ${msg}`);
}

// Secondary text keeps the theme's foreground colour and is dimmed with actor
// opacity. St has no CSS `opacity`, and the shell dims text with per-theme
// `rgba()` foregrounds only because it ships separate light and dark
// stylesheets — an extension with a single stylesheet cannot.
const SECONDARY_TEXT_OPACITY = 178;

/**
 * Money in the session locale, falling back to a plain dollar string when the
 * currency code isn't supported by Intl.
 * @param {number} value
 * @param {string} currency
 */
const formatMoney = (value, currency = "USD") => {
  try {
    return Number(value).toLocaleString(undefined, {
      style: "currency",
      currency,
    });
  } catch (e) {
    return `$${Number(value).toFixed(2)}`;
  }
};

/**
 * Compact token count: 812, 64.2K, 146.4M, 1.2B.
 * @param {number} value
 */
const formatTokens = (value) => {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
};

/**
 * Build a dimmed caption.
 * @param {string} text
 * @param {object} params Extra St.Label properties.
 * @returns {St.Label}
 */
function captionLabel(text, params = {}) {
  const label = new St.Label({
    text,
    style_class: "codexbar-caption",
    ...params,
  });
  label.opacity = SECONDARY_TEXT_OPACITY;
  return label;
}

/**
 * Build a dimmed caption that wraps instead of overflowing the popup.
 * @param {string} text
 * @param {object} params Extra St.Label properties.
 * @returns {St.Label}
 */
function wrappingLabel(text, params = {}) {
  const label = captionLabel(text, params);
  label.clutter_text.line_wrap = true;
  label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
  return label;
}

/**
 * Main extension class for CodexBar.
 */
export default class CodexBarExtension extends Extension {
  /**
   * Called when the extension is enabled.
   */
  enable() {
    this._settings = this.getSettings();
    this._apiClient = new UsageApiClient(this.path);
    this._copyTimeouts = [];

    this._providers = [];
    this._providersData = [];
    this._costData = new Map();
    this._activeProviderIndex = 0;
    this._sessionPercent = null;
    this._weeklyPercent = null;
    this._meterColor = null;
    this._loading = false;
    this._cancellable = new Gio.Cancellable();

    // Provider icons come from the ACP registry, cached on disk; a download
    // that lands during the session repaints the tabs and panel segments.
    this._logos = new LogoCache(() => this._updateUI());
    this._logos.refresh(this._cancellable);

    this._applyLanguage();

    // Times follow the desktop's clock format, like the shell's own clock.
    this._interfaceSettings = new Gio.Settings({
      schema_id: "org.gnome.desktop.interface",
    });
    this._applyClockFormat();
    this._interfaceSettings.connectObject(
      "changed::clock-format",
      () => {
        this._applyClockFormat();
        this._updateUI();
      },
      this
    );

    this._indicator = new PanelMenu.Button(0.0, _("CodexBar"), false);
    this._buildPanel();
    this._buildMenu();

    Main.panel.addToStatusArea(this.uuid, this._indicator);

    // The meter is drawn in the panel's foreground colour, so it has to follow
    // live theme switches (dark/light/high contrast), not just load time. A
    // theme reload changes the context, while a re-tinted panel (transparent
    // top bar, maximized window) only swaps style classes; that shows up as
    // style-changed on the indicator itself.
    this._applyMeterColors();
    this._themeContext = St.ThemeContext.get_for_stage(global.stage);
    this._themeContext.connectObject(
      "changed",
      () => this._applyMeterColors(),
      this
    );
    this._indicator.connectObject(
      "style-changed",
      () => this._applyMeterColors(),
      this
    );

    this._settings.connectObject(
      "changed::providers", () => this._onSettingsChanged(),
      "changed::refresh-interval", () => this._onSettingsChanged(),
      "changed::display-mode", () => this._updateUI(),
      "changed::show-logos", () => this._updateUI(),
      "changed::show-pacing-info", () => this._updateUI(),
      "changed::show-provider-details", () => this._updateUI(),
      "changed::first-run", () => this._updateUI(),
      "changed::language", () => {
        this._applyLanguage();
        this._updateUI();
        this._refreshData();
      },
      "changed::dev-custom-output-enabled", () => this._onSettingsChanged(),
      "changed::dev-custom-output-provider-name", () => this._onSettingsChanged(),
      "changed::dev-custom-output-json", () => this._onSettingsChanged(),
      this
    );
    this._onSettingsChanged();

    // Keep the panel's reset countdown ticking between refreshes.
    this._panelTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
      this._updatePanel();
      this._updateHeader(); // keep "Updated 5m ago" from going stale
      return GLib.SOURCE_CONTINUE;
    });
  }

  /**
   * Mirror the desktop's 12/24-hour clock setting for displayed times.
   */
  _applyClockFormat() {
    if (!this._interfaceSettings) return;
    const format = this._interfaceSettings.get_string("clock-format");
    setHour12(format === "12h" ? true : format === "24h" ? false : null);
  }

  /**
   * Load the catalog for the `language` setting; English is the fallback.
   */
  _applyLanguage() {
    const domain = this.metadata["gettext-domain"] ?? this.uuid;
    applyLanguage(this._settings.get_string("language"), (lang) => {
      const mo = this.dir
        .get_child("locale")
        .get_child(lang)
        .get_child("LC_MESSAGES")
        .get_child(`${domain}.mo`);
      return mo.query_exists(null) ? mo.load_contents(null)[1] : null;
    });
    logDev(`UI language: ${currentLanguage()}`);
  }

  /**
   * Build the panel actor: the session/weekly meter or the per-provider text
   * segments configured to appear in the panel.
   */
  _buildPanel() {
    // Two bars like the macOS app, drawn in the panel's foreground colour. A
    // stock battery read as hardware and a full battery meant healthy, so a
    // nearly spent quota looked fine.
    this._sessionBar = this._meterBar("codexbar-panel-meter-session");
    this._weeklyBar = this._meterBar("codexbar-panel-meter-weekly");
    this._meter = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "codexbar-panel-meter",
    });
    this._meter.add_child(this._sessionBar);
    this._meter.add_child(this._weeklyBar);

    // Per-provider text ("5h 3% · W 22% in 3h 15m"), shown instead of the
    // meter when any provider is flagged showInPanel.
    this._panelTextBox = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      y_align: Clutter.ActorAlign.CENTER,
      visible: false,
    });

    this._panelBox = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._panelBox.add_child(this._meter);
    this._panelBox.add_child(this._panelTextBox);
    this._indicator.add_child(this._panelBox);
  }

  /**
   * One bar of the panel meter: a 22px-wide level bar filled to a window
   * percentage.
   * @param {string} styleClass
   * @returns {BarLevel}
   */
  _meterBar(styleClass) {
    const bar = new BarLevel({ width: 22 });
    bar.add_style_class_name(styleClass);
    bar.maximum_value = 100;
    bar.overdrive_start = 100;
    return bar;
  }

  /**
   * Draw the meter in the panel's own foreground colour, so the bars stay
   * monochrome: white on a dark panel, black on a light one.
   */
  _applyMeterColors() {
    if (!this._sessionBar || !this._indicator) return;
    const fg = this._indicator.get_theme_node().get_foreground_color();
    const rgb = `${fg.red}, ${fg.green}, ${fg.blue}`;
    if (rgb === this._meterColor) return;

    this._meterColor = rgb;
    const style =
      `-barlevel-background-color: rgba(${rgb}, 0.35);` +
      ` -barlevel-active-background-color: rgb(${rgb});`;
    this._sessionBar.set_style(style);
    this._weeklyBar.set_style(style);
  }

  /**
   * Build the popup: HIG-style provider tabs, a rebuildable content section,
   * and a footer row with the title, the active provider caption, refresh and
   * preferences.
   */
  _buildMenu() {
    const menu = this._indicator.menu;
    menu.box.add_style_class_name("codexbar-popup");

    this._tabsBox = new St.BoxLayout({
      style_class: "codexbar-tabs",
      orientation: Clutter.Orientation.HORIZONTAL,
      visible: false,
    });
    menu.box.add_child(this._tabsBox);

    this._contentSection = new PopupMenu.PopupMenuSection();
    menu.addMenuItem(this._contentSection);

    this._footerBox = new St.BoxLayout({
      style_class: "codexbar-footer",
      orientation: Clutter.Orientation.HORIZONTAL,
      x_expand: true,
    });
    this._footerBox.add_child(
      new St.Label({
        text: _("CodexBar"),
        style_class: "codexbar-title",
        y_align: Clutter.ActorAlign.CENTER,
      })
    );
    this._menuSubtitle = captionLabel("", {
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._menuSubtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    this._footerBox.add_child(this._menuSubtitle);
    this._refreshButton = this._roundButton(
      "view-refresh-symbolic",
      _("Refresh Now"),
      () => this._refreshData()
    );
    this._prefsButton = this._roundButton(
      "preferences-system-symbolic",
      _("Preferences"),
      () => {
        this.openPreferences();
        menu.close();
      }
    );
    this._footerBox.add_child(this._refreshButton);
    this._footerBox.add_child(this._prefsButton);
    menu.box.add_child(this._footerBox);
  }

  /**
   * A circular icon button for the menu footer.
   * @param {string} iconName
   * @param {string} accessibleName
   * @param {Function} onClick
   * @returns {St.Button}
   */
  _roundButton(iconName, accessibleName, onClick) {
    const button = new St.Button({
      style_class: "codexbar-round-button",
      child: new St.Icon({
        icon_name: iconName,
        icon_size: 16,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      }),
      y_align: Clutter.ActorAlign.CENTER,
    });
    button.accessible_name = accessibleName;
    button.connect("clicked", onClick);
    return button;
  }

  /**
   * Called when the extension is disabled.
   */
  disable() {
    if (this._apiClient) {
      this._apiClient.destroy();
      this._apiClient = null;
    }

    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }

    if (this._logos) {
      this._logos.destroy();
      this._logos = null;
    }

    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._panelTickId) {
      GLib.source_remove(this._panelTickId);
      this._panelTickId = null;
    }
    if (this._copyTimeouts) {
      this._copyTimeouts.forEach((id) => GLib.source_remove(id));
      this._copyTimeouts = null;
    }

    if (this._interfaceSettings) {
      this._interfaceSettings.disconnectObject(this);
      this._interfaceSettings = null;
    }

    if (this._themeContext) {
      this._themeContext.disconnectObject(this);
      this._themeContext = null;
    }
    this._meterColor = null;

    if (this._settings) {
      this._settings.disconnectObject(this);
      this._settings = null;
      setCatalog("en", null); // drop the translation catalog with the extension
    }

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    this._tabsBox = null;
    this._contentSection = null;
    this._footerBox = null;
    this._refreshButton = null;
    this._prefsButton = null;
    this._menuSubtitle = null;
    this._meter = null;
    this._sessionBar = null;
    this._weeklyBar = null;
    this._panelTextBox = null;
    this._panelBox = null;

    this._providers = [];
    this._providersData = [];
    this._costData = new Map();
    this._activeProviderIndex = 0;
    this._sessionPercent = null;
    this._weeklyPercent = null;

    nullTokenSchema();
  }

  /**
   * Handle provider or refresh-interval settings changes.
   */
  _onSettingsChanged() {
    if (!this._settings) return;

    const providersJson = this._settings.get_string("providers");
    try {
      this._providers = JSON.parse(providersJson);
    } catch (e) {
      this._providers = [];
      console.error(e, "CodexBar: Failed to parse providers");
    }

    if (this._activeProviderIndex >= this._providers.length) {
      this._activeProviderIndex = 0;
    }

    // Draw the provider logos right away instead of waiting for the first
    // CLI round-trip, which otherwise leaves the fallback icon up at login.
    this._updateUI();
    this._refreshData();
    this._setupTimeout();
  }

  /**
   * Set up the auto-refresh timer.
   */
  _setupTimeout() {
    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
    }
    const interval = this._settings.get_int("refresh-interval") * 60 * 1000;
    if (interval > 0) {
      this._timeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        interval,
        () => {
          this._refreshData();
          return GLib.SOURCE_CONTINUE;
        }
      );
    }
  }

  /**
   * Refresh usage data for all enabled providers.
   */
  async _refreshData() {
    if (this._loading || !this._settings) return;
    if (this._providers.length === 0) {
      this._updateUI();
      return;
    }
    this._loading = true;
    this._updateHeader();

    // Cheap while the cached registry is fresh; keeps icons current in long
    // sessions without another timer.
    this._logos?.refresh(this._cancellable);

    logDev("Refreshing usage data...");

    if (this._settings.get_boolean("dev-custom-output-enabled")) {
      this._loadMockData();
      return;
    }

    this._providersData = [];

    for (let i = 0; i < this._providers.length; i++) {
      const provider = this._providers[i];

      if (provider.useApi) {
        logDev(`Fetching API summary for provider: ${provider.name}`);
        try {
          let data;
          const token = await loadToken(provider.id);
          if (!token) {
            // The CLI reads the provider's own credentials from disk, so it
            // still works when nothing is stored in the keyring.
            logDev(
              `No keyring token for ${provider.name}; falling back to the CLI`
            );
            const cliCommand =
              provider.command ||
              (provider.id
                ? `codexbar --provider ${provider.id} --format json`
                : "");
            if (!cliCommand) {
              this._providersData[i] = { error: _("No token found in keyring") };
              continue;
            }
            try {
              this._providersData[i] = this._normalizeCliData(
                await this._apiClient.fetchCliSummary(
                  cliCommand,
                  this._cancellable
                ),
                provider
              );
            } catch (error) {
              console.error(
                error,
                `CodexBar: error running provider ${provider.name}`
              );
              this._providersData[i] = {
                error: error.message || _("Unknown CLI error"),
              };
            }
            continue;
          }
          data = await this._apiClient.fetchSummary(
            token,
            provider.id,
            this._cancellable
          );

          let apiLabels = [];
          if (data.labels && data.labels.length > 0) {
            apiLabels = data.labels;
          } else {
            ["primary", "secondary", "tertiary", "quaternary"].forEach(
              (tier) => {
                const win = data.usage[tier];
                if (win && win.windowSeconds) {
                  const hours = Math.round(win.windowSeconds / 3600);
                  if (hours >= 24) {
                    const days = Math.round(hours / 24);
                    apiLabels.push(
                      days === 7
                        ? _("Weekly")
                        : formatText(_("%d-Day"), days)
                    );
                  } else {
                    apiLabels.push(formatText(_("%d-Hour"), hours));
                  }
                } else if (win) {
                  apiLabels.push(_("Usage"));
                }
              }
            );
          }

          this._providersData[i] = {
            data,
            labels: apiLabels,
          };
          logDev(`Successfully fetched API data for provider: ${provider.name}`);
        } catch (error) {
          logDev(
            `API error for provider ${provider.name}: ${error.message || error}`
          );
          console.error(error, `CodexBar: API error for ${provider.name}`);
          let msg = error.message;
          if (!msg && error.toString) msg = error.toString();
          if (!msg || msg === "[object Object]") msg = _("Unknown API error");
          this._providersData[i] = { error: msg };
        }
        continue;
      }

      if (!provider.command) {
        logDev(`Error: No CLI command configured for provider: ${provider.name}`);
        this._providersData[i] = { error: _("No command configured") };
        continue;
      }

      logDev(
        `Executing CLI command for provider ${provider.name}: ${provider.command}`
      );
      try {
        const result = await this._apiClient.fetchCliSummary(
          provider.command,
          this._cancellable
        );
        if (!this._cancellable || this._cancellable.is_cancelled()) {
          logDev(`CLI execution cancelled for provider: ${provider.name}`);
          return;
        }

        this._providersData[i] = this._normalizeCliData(result, provider);
        logDev(`Successfully executed CLI command for provider: ${provider.name}`);
      } catch (error) {
        if (this._cancellable && !this._cancellable.is_cancelled()) {
          logDev(
            `CLI error for provider ${provider.name}: ${error.message || error}`
          );
          console.error(
            error,
            `CodexBar: error running provider ${provider.name}`
          );
          let msg = error.message;
          if (!msg && error.toString) msg = error.toString();
          if (!msg || msg === "[object Object]") msg = _("Unknown CLI error");
          this._providersData[i] = {
            error: msg,
            command: provider.command,
          };
        }
      }
    }

    if (this._cancellable && !this._cancellable.is_cancelled()) {
      await this._refreshCostData();

      // One timestamp for the whole sequential fetch; the panel countdown is
      // skewed by the fetch duration (seconds). Stamp per provider if needed.
      const fetchedAt = Date.now();
      this._providersData.forEach((d) => {
        if (d) d.fetchedAt = fetchedAt;
      });
      this._loading = false;
      this._updateUI();
    }
  }

  /**
   * Read `codexbar cost` totals. Optional: older CLIs have no cost command, so
   * a failure just means the cost card is omitted.
   */
  async _refreshCostData() {
    if (!this._apiClient || !this._providers.length) {
      this._costData = new Map();
      return;
    }
    try {
      // Prefer a provider's own command so a custom binary path (Homebrew,
      // ~/.local/bin) is reused instead of relying on the shell's PATH.
      const command = this._providers
        .map((provider) => (provider.command || "").trim())
        .find((candidate) => candidate.length > 0);
      this._costData = await this._apiClient.fetchCostSummary(
        this._cancellable,
        command || ""
      );
      logDev(`Cost totals loaded for ${this._costData.size} provider(s)`);
    } catch (error) {
      logDev(`Cost summary unavailable: ${error.message || error}`);
      this._costData = new Map();
    }
  }

  /**
   * Map a configured provider onto a `codexbar cost` entry key.
   * @param {object} provider
   * @returns {string|null}
   */
  _costProviderKey(provider) {
    if (!provider) return null;
    const id = (provider.id || "").toLowerCase();
    if (this._costData.has(id)) return id;
    const name = (provider.name || "").toLowerCase().replace(/[\s-]+/g, "");
    for (const key of this._costData.keys()) {
      if (key.toLowerCase().replace(/[\s-]+/g, "") === name) return key;
    }
    return null;
  }

  /**
   * Render the local cost equivalent for today and the rolling 30 days.
   * @param {object} provider
   */
  _renderCostEstimate(provider) {
    const key = this._costProviderKey(provider);
    const entry = key ? this._costData.get(key) : null;
    if (!entry?.today && !entry?.last30Days) return;

    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      style_class: "codexbar-spacing-2",
    });
    box.add_child(
      new St.Label({ text: _("Cost"), style_class: "codexbar-section-title" })
    );

    const rows = [
      [_("Today"), entry.today],
      [_("Last 30 days"), entry.last30Days],
    ];
    rows.forEach(([label, totals]) => {
      if (!totals) return;
      const row = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_expand: true,
        style_class: "codexbar-spacing-6",
      });
      row.add_child(new St.Label({ text: label, x_expand: true }));
      row.add_child(
        new St.Label({
          text: formatText(
            _("%s · %s tokens"),
            formatMoney(totals.cost, totals.currency),
            formatTokens(totals.tokens)
          ),
          style_class: "codexbar-value",
          x_align: Clutter.ActorAlign.END,
        })
      );
      box.add_child(row);
    });

    this._addInactiveItem(box);
  }

  /**
   * Render the developer-mode payload into the provider list.
   */
  _loadMockData() {
    const mockName =
      this._settings.get_string("dev-custom-output-provider-name") ||
      "Mock Provider";
    const mockJson = this._settings.get_string("dev-custom-output-json") || "[]";
    logDev(`[Dev Mode] Simulating custom output for provider: ${mockName}`);
    logDev(`[Dev Mode] Input payload: ${mockJson}`);

    this._providersData = [];
    try {
      const parsed = JSON.parse(mockJson);
      let rawData = Array.isArray(parsed) ? parsed[0] : parsed;
      let finalLabels = [];

      if (rawData) {
        const isAntigravity =
          mockName.toLowerCase() === "antigravity" ||
          rawData.provider === "antigravity";

        if (rawData.usage) {
          logDev(`[Dev Mode] Normalizing nested usage object...`);
          const normalized = this._apiClient.normalizeSummary(
            rawData.usage,
            isAntigravity
          );
          rawData.usage = normalized.usage;
          finalLabels = normalized.labels || [];
        } else {
          logDev(`[Dev Mode] Normalizing flat usage object...`);
          const normalized = this._apiClient.normalizeSummary(
            rawData,
            isAntigravity
          );
          rawData = { ...rawData, usage: normalized.usage };
          finalLabels = normalized.labels || [];
        }
      }

      this._providersData[0] = {
        data: rawData,
        labels: finalLabels,
        command: "mock-command",
        fetchedAt: Date.now(),
      };
      this._providers = [
        {
          id: "mock-provider",
          name: mockName,
          useApi: false,
          command: "mock-command",
        },
      ];
      this._activeProviderIndex = 0;
      logDev(
        `[Dev Mode] Successfully simulated custom output. Labels: [${finalLabels.join(", ")}]`
      );
    } catch (error) {
      logDev(`[Dev Mode] Error parsing/normalizing mock output: ${error.message}`);
      this._providersData[0] = {
        error: error.message,
        command: "mock-command",
        fetchedAt: Date.now(),
      };
      this._providers = [
        {
          id: "mock-provider",
          name: mockName,
          useApi: false,
          command: "mock-command",
        },
      ];
      this._activeProviderIndex = 0;
    }

    this._loading = false;
    this._updateUI();
  }

  /**
   * Update the footer caption and the refresh button's state.
   */
  _updateHeader() {
    if (!this._menuSubtitle) return;

    if (this._refreshButton) this._refreshButton.reactive = !this._loading;

    if (this._loading) {
      this._menuSubtitle.set_text(_("Refreshing…"));
      return;
    }

    if (this._providers.length === 0) {
      this._menuSubtitle.set_text(_("No providers configured"));
      return;
    }

    const fetchedAt = this._providersData.reduce(
      (latest, entry) => Math.max(latest, entry?.fetchedAt || 0),
      0
    );

    if (fetchedAt === 0) {
      this._menuSubtitle.set_text(_("Not updated yet"));
      return;
    }
    this._menuSubtitle.set_text(
      formatText(
        _("Updated %s"),
        formatRelativeTime((Date.now() - fetchedAt) / 1000, _)
      )
    );
  }

  /**
   * Render the panel text for providers flagged showInPanel, or fall back to
   * the session/weekly meter for the active provider.
   */
  _updatePanel() {
    if (!this._panelTextBox || !this._settings) return;

    const shown = (this._providers || [])
      .map((provider, index) => ({ provider, entry: this._providersData[index] }))
      .filter(({ provider }) => provider.showInPanel);
    const showLogos = this._settings.get_boolean("show-logos");

    this._meter.visible = shown.length === 0;
    this._panelTextBox.visible = shown.length > 0;
    this._sessionBar.value = this._sessionPercent ?? 0;
    this._weeklyBar.value = this._weeklyPercent ?? 0;

    // The bars carry no text, so the accessible name is the only place the
    // numbers are spoken.
    const windows = [];
    if (this._sessionPercent !== null) {
      windows.push(`${_("Session")} ${Math.round(this._sessionPercent)}%`);
    }
    if (this._weeklyPercent !== null) {
      windows.push(`${_("Weekly")} ${Math.round(this._weeklyPercent)}%`);
    }
    this._indicator.accessible_name =
      shown.length === 0 && windows.length > 0
        ? `${_("CodexBar")} ${windows.join(", ")}`
        : _("CodexBar usage");

    logDev(
      shown.length === 0
        ? `Panel meter: ${windows.join(", ") || "no quota windows"}`
        : `Panel: ${shown.length} provider text segment(s)`
    );

    this._panelTextBox.destroy_all_children();

    const displayMode = this._settings.get_string("display-mode");
    shown.forEach(({ provider, entry }) => {
      const segment = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        style_class: "codexbar-panel-segment",
      });

      let text;
      if (!entry) {
        text = `${provider.name}…`;
      } else if (entry.error) {
        segment.add_child(
          new St.Icon({
            icon_name: "dialog-warning-symbolic",
            style_class: "codexbar-panel-logo",
            y_align: Clutter.ActorAlign.CENTER,
          })
        );
        text = provider.name;
      } else {
        const elapsed = (Date.now() - (entry.fetchedAt || Date.now())) / 1000;
        const usageText =
          formatPanelText(entry.data?.usage, displayMode, elapsed, _) || "";
        if (showLogos) {
          const logo = this._getProviderLogo(provider.id, provider.name);
          if (logo) {
            logo.set_style_class_name("codexbar-panel-logo");
            segment.add_child(logo);
          }
        }
        // Keep the provider name even when a logo is present: panel segments
        // are read at a glance and the text must not depend on the icon.
        text = usageText ? `${provider.name} ${usageText}` : provider.name;
      }

      segment.add_child(
        new St.Label({ text, y_align: Clutter.ActorAlign.CENTER })
      );
      this._panelTextBox.add_child(segment);
    });
  }

  /**
   * Percent for one usage window in the configured display mode, or null when
   * the provider reports no such window.
   * @param {object} activeData
   * @param {string} tier
   * @param {string} displayMode
   * @returns {number|null}
   */
  _windowPercent(activeData, tier, displayMode) {
    const tierData = activeData?.data?.usage?.[tier];
    if (!tierData || tierData.usedPercent === undefined) return null;
    if (this._isDegenerateTier(tierData)) return null;
    const used = this._normalizePercent(tierData.usedPercent);
    return displayMode === "remaining" ? 100 - used : used;
  }

  /**
   * Normalize a percentage value.
   */
  _normalizePercent(value) {
    if (value === undefined || value === null) return 0;
    const p = parseFloat(value);
    if (!Number.isFinite(p)) return 0;
    return Math.min(100, Math.max(0, p));
  }

  /**
   * A tier with usedPercent:0 and no windowSeconds isn't a real usage window
   * (e.g. OpenRouter's balance placeholder).
   */
  _isDegenerateTier(tierData) {
    return (
      !!tierData &&
      !tierData.windowSeconds &&
      tierData.usedPercent === 0 &&
      !tierData.resetDescription
    );
  }

  /**
   * Normalize a codexbar payload into the shape the UI renders. Shared by the
   * CLI path and the keyring-token fallback so both agree on window labels.
   * @param {{data: object, labels?: string[], command?: string}} result
   * @param {object} provider
   */
  _normalizeCliData(result, provider) {
    let rawData = result.data;
    let labels = result.labels || [];

    if (rawData) {
      const isAntigravity =
        provider.id === "antigravity" || rawData.provider === "antigravity";

      if (rawData.usage) {
        const normalized = this._apiClient.normalizeSummary(
          rawData.usage,
          isAntigravity
        );
        rawData.usage = normalized.usage;
        if (normalized.labels && normalized.labels.length > 0) {
          labels = normalized.labels;
        }
      } else {
        const normalized = this._apiClient.normalizeSummary(
          rawData,
          isAntigravity
        );
        rawData = { ...rawData, usage: normalized.usage };
        if (normalized.labels && normalized.labels.length > 0) {
          labels = normalized.labels;
        }
      }
    }

    return { data: rawData, labels, command: result.command };
  }

  /**
   * Check if a binary exists in the PATH or standard directories.
   */
  _checkBinaryExists(name) {
    if (GLib.find_program_in_path(name)) {
      return true;
    }
    const commonPaths = [
      `/home/linuxbrew/.linuxbrew/bin/${name}`,
      `${GLib.get_home_dir()}/.local/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
    ];
    for (const path of commonPaths) {
      if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update the popup menu for the current providers and settings.
   */
  _updateUI() {
    if (!this._indicator || !this._contentSection || !this._settings) return;

    this._applyMeterColors();
    const wasOpen = this._indicator.menu.isOpen;
    this._contentSection.removeAll();
    this._updateHeader();

    // Rebuilding while the menu is open replaces the contents in place; a
    // short fade keeps that from reading as a flash of unstyled rows.
    if (wasOpen && St.Settings.get().enable_animations) {
      this._contentSection.box.opacity = 0;
      this._contentSection.box.ease({
        opacity: 255,
        duration: 140,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    }

    const displayMode = this._settings.get_string("display-mode");
    const firstRun = this._settings.get_boolean("first-run");
    const codexbarExists = this._checkBinaryExists("codexbar");
    const importerExists = this._checkBinaryExists("codexbar-cookie-importer");
    const certInstalled = GLib.file_test(
      "/usr/local/share/ca-certificates/antigravity.crt",
      GLib.FileTest.EXISTS
    );

    this._renderTabs(
      !firstRun && codexbarExists && this._providers.length > 1
    );

    const activeData = this._providersData[this._activeProviderIndex];
    this._sessionPercent = this._windowPercent(activeData, "primary", displayMode);
    this._weeklyPercent = this._windowPercent(activeData, "secondary", displayMode);
    this._updatePanel();

    if (firstRun || !codexbarExists) {
      this._renderWelcome(codexbarExists, importerExists, certInstalled);
      return;
    }

    if (this._providers.length === 0) {
      this._renderEmpty();
      return;
    }

    const activeProvider = this._providers[this._activeProviderIndex];

    if (!activeData) {
      this._addInactiveItem(
        new St.Label({ text: _("Loading usage…"), x_expand: true })
      );
      return;
    }

    if (activeData.error) {
      this._renderError(activeData);
      return;
    }

    const data = activeData.data;
    if (!data || !data.usage) {
      this._addInactiveItem(
        new St.Label({
          text: _("Invalid JSON format (missing usage)"),
          x_expand: true,
        })
      );
      return;
    }

    this._renderUsage(activeProvider, activeData, displayMode);
  }

  /**
   * Add a non-interactive popup item containing arbitrary content.
   * @param {St.Widget} child
   * @param {PopupMenu.PopupMenuBase} [section]
   * @returns {PopupMenu.PopupBaseMenuItem}
   */
  _addInactiveItem(child, section = this._contentSection) {
    const item = new PopupMenu.PopupBaseMenuItem({
      reactive: false,
      can_focus: false,
    });
    item.add_child(child);
    section.addMenuItem(item);
    return item;
  }

  /**
   * Provider tabs above the content, as a HIG segmented control: one pill per
   * provider, the active one on the accent colour.
   * @param {boolean} show
   */
  _renderTabs(show) {
    this._tabsBox.visible = show;
    this._tabsBox.destroy_all_children();
    if (!show) return;

    const showLogos = this._settings.get_boolean("show-logos");
    this._providers.forEach((provider, index) => {
      const button = new St.Button({
        style_class: "codexbar-tab",
        can_focus: true,
      });
      button.accessible_name = provider.name;
      if (index === this._activeProviderIndex) {
        button.add_style_class_name("codexbar-tab-active");
      }

      const row = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        y_align: Clutter.ActorAlign.CENTER,
      });
      if (showLogos) {
        const logo = this._getProviderLogo(provider.id, provider.name);
        if (logo) {
          logo.set_style_class_name("codexbar-tab-icon");
          row.add_child(logo);
        }
      }
      row.add_child(
        new St.Label({
          text: provider.name,
          y_align: Clutter.ActorAlign.CENTER,
        })
      );
      button.set_child(row);
      button.connect("clicked", () => {
        if (index === this._activeProviderIndex) return;
        this._activeProviderIndex = index;
        this._updateUI();
      });
      this._tabsBox.add_child(button);
    });
  }

  /**
   * Render the account summary and every usage window for the active provider.
   * @param {object} provider
   * @param {object} activeData
   * @param {string} displayMode
   */
  _renderUsage(provider, activeData, displayMode) {
    const usage = activeData.data.usage;
    const showPacing = this._settings.get_boolean("show-pacing-info");
    const creditsPercent = deriveCreditsPercent(
      normalizeDetailSections(usage.details)
    );

    this._renderAccount(provider, usage);

    const tiers = ["primary", "secondary", "tertiary", "quaternary"];
    const discoveredLabels = activeData.labels || [];
    let hasTiers = false;

    const usageEntries = tiers.map((tier, tierIdx) => {
      let tierData = usage[tier];
      let title = localizeLabel(
        discoveredLabels[tierIdx] ||
          tier.charAt(0).toUpperCase() + tier.slice(1),
        _
      );

      if (this._isDegenerateTier(tierData)) {
        if (creditsPercent === null) {
          tierData = null;
        } else {
          tierData = { ...tierData, usedPercent: creditsPercent };
          title = _("Credits");
        }
      } else if (tierData && !tierData.windowSeconds && tierData.resetDescription) {
        title = discoveredLabels[tierIdx] || _("Balance");
      }

      return { data: tierData, showPace: true, title };
    });
    usageEntries.push({
      data: usage.codeReview,
      showPace: false,
      title: _("Code review"),
    });

    usageEntries.forEach((entry) => {
      if (!entry.data || entry.data.usedPercent === undefined) return;

      hasTiers = true;
      const tierData = entry.data;
      const usedPercent = this._normalizePercent(tierData.usedPercent);
      const percent =
        displayMode === "remaining" ? 100 - usedPercent : usedPercent;
      const percentText =
        displayMode === "remaining"
          ? formatText(_("%s%% left"), formatPercent(percent))
          : formatText(_("%s%% used"), formatPercent(percent));

      const resetText = (
        tierData.resetAfterSeconds
          ? formatReset(
              tierData.resetAfterSeconds,
              (Date.now() - (activeData.fetchedAt || Date.now())) / 1000,
              _
            )
          : tierData.resetDescription
      ) || "";

      let paceText = "";
      if (
        showPacing &&
        entry.showPace &&
        tierData.windowSeconds >= 7 * 24 * 3600
      ) {
        const pace = calculateUsagePace(tierData);
        if (pace) {
          const roundedReserve = Math.round(pace.reservePercent);
          paceText =
            roundedReserve >= 0
              ? formatText(_("%d%% in reserve"), roundedReserve)
              : formatText(_("%d%% over pace"), Math.abs(roundedReserve));
        }
      }

      this._addUsageRow({
        title: entry.title,
        percent,
        warning: displayMode === "remaining" ? percent < 10 : percent > 90,
        percentText,
        resetText,
        paceText,
      });
    });

    if (usage.rateLimitResetCredits?.availableCount !== undefined) {
      const creditCount = usage.rateLimitResetCredits.availableCount;
      const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        style_class: "codexbar-spacing-2",
      });
      box.add_child(
        new St.Label({
          text: _("Limit reset credits"),
          style_class: "codexbar-section-title",
        })
      );
      box.add_child(
        captionLabel(
          creditCount === 1
            ? _("1 available")
            : formatText(_("%d available"), creditCount)
        )
      );
      this._addInactiveItem(box);
    }

    if (!hasTiers && usage.providerCost) {
      this._renderCost(usage.providerCost);
    }

    this._renderCostEstimate(provider);
    this._renderDetails(usage);
  }

  /**
   * Render the account email, plan and last-updated line. The provider name is
   * skipped while the tab bar is visible, because the active tab already
   * names it.
   */
  _renderAccount(provider, usage) {
    if (!usage.accountEmail) return;

    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      style_class: "codexbar-spacing-2",
    });
    if (!this._tabsBox.visible) {
      box.add_child(
        new St.Label({
          text: provider.name,
          style_class: "codexbar-section-title",
        })
      );
    }

    let accountText = usage.accountEmail;
    if (usage.loginMethod) accountText += ` (${usage.loginMethod})`;
    box.add_child(captionLabel(accountText));

    if (usage.planType) {
      const planText =
        usage.planType.charAt(0).toUpperCase() + usage.planType.slice(1);
      box.add_child(captionLabel(planText));
    }

    if (usage.updatedAt) {
      const date = new Date(usage.updatedAt);
      if (!Number.isNaN(date.getTime())) {
        box.add_child(
          captionLabel(
            formatText(
              _("Updated %s"),
              formatRelativeTime((Date.now() - date.getTime()) / 1000, _)
            )
          )
        );
      }
    }

    this._addInactiveItem(box);
  }

  /**
   * Add one usage window: title and value, a native level bar, then reset and
   * pacing captions.
   */
  _addUsageRow({ title, percent, warning, percentText, resetText, paceText }) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      style_class: "codexbar-spacing-6",
    });

    const header = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      x_expand: true,
      style_class: "codexbar-spacing-6",
    });
    header.add_child(
      new St.Label({
        text: title,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      })
    );
    if (warning) {
      header.add_child(
        new St.Icon({
          icon_name: "dialog-warning-symbolic",
          style_class: "popup-menu-icon",
          y_align: Clutter.ActorAlign.CENTER,
        })
      );
    }
    header.add_child(
      new St.Label({
        text: percentText,
        style_class: "codexbar-value",
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
      })
    );
    box.add_child(header);

    const bar = new BarLevel({ x_expand: true, y_align: Clutter.ActorAlign.CENTER });
    bar.add_style_class_name("codexbar-level");
    bar.maximum_value = 100;
    bar.overdrive_start = 100;
    const target = Math.max(0, Math.min(100, percent));
    if (St.Settings.get().enable_animations) {
      // Fill from empty so a refresh reads as movement, not a jump.
      bar.value = 0;
      bar.ease_property("value", target, {
        duration: 250,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      });
    } else {
      bar.value = target;
    }
    box.add_child(bar);

    if (resetText || paceText) {
      const footer = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_expand: true,
        style_class: "codexbar-spacing-6",
      });
      const reset = captionLabel(resetText, {
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
      });
      reset.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      footer.add_child(reset);
      if (paceText) {
        footer.add_child(
          captionLabel(paceText, { x_align: Clutter.ActorAlign.END })
        );
      }
      box.add_child(footer);
    }

    this._addInactiveItem(box);
  }

  /**
   * Render the balance card used by cost-only providers.
   */
  _renderCost(cost) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      style_class: "codexbar-spacing-2",
    });
    box.add_child(captionLabel(cost.period || _("Balance")));

    let formattedAmount = "";
    try {
      const currency = cost.currencyCode || "USD";
      const used = cost.used || 0;
      const limit = cost.limit || 0;
      const formatter = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      });
      if (limit > 0) {
        formattedAmount = `${formatter.format(used)} / ${formatter.format(limit)}`;
      } else {
        formattedAmount = formatter.format(used);
      }
    } catch (e) {
      const currencySymbol = cost.currencyCode === "USD" ? "$" : cost.currencyCode || "";
      const used = cost.used || 0;
      const limit = cost.limit || 0;
      if (limit > 0) {
        formattedAmount = `${currencySymbol}${used.toFixed(2)} / ${currencySymbol}${limit.toFixed(2)}`;
      } else {
        formattedAmount = `${currencySymbol}${used.toFixed(2)}`;
      }
    }

    box.add_child(
      new St.Label({ text: formattedAmount, style_class: "codexbar-amount" })
    );
    this._addInactiveItem(box);
  }

  /**
   * Render provider-supplied detail sections inside a Details submenu.
   */
  _renderDetails(usage) {
    if (!this._settings.get_boolean("show-provider-details")) return;

    const sections = normalizeDetailSections(usage?.details);
    if (sections.length === 0) return;

    const detailsItem = new PopupMenu.PopupSubMenuMenuItem(_("Details"));

    sections.forEach((section) => {
      if (section.title) {
        this._addInactiveItem(
          new St.Label({
            text: localizeDetail(section.title, _),
            style_class: "codexbar-section-title",
          }),
          detailsItem.menu
        );
      }

      section.rows.forEach((row) => {
        const box = new St.BoxLayout({
          orientation: Clutter.Orientation.VERTICAL,
          x_expand: true,
          style_class: "codexbar-spacing-2",
        });

        const rowBox = new St.BoxLayout({
          orientation: Clutter.Orientation.HORIZONTAL,
          x_expand: true,
          style_class: "codexbar-spacing-6",
        });

        const label = captionLabel(localizeDetail(row.label, _), {
          x_expand: true,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        rowBox.add_child(label);

        const value = new St.Label({
          text: localizeDetail(row.value, _),
          style_class: "codexbar-value",
          x_align: Clutter.ActorAlign.END,
        });
        value.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        rowBox.add_child(value);

        box.add_child(rowBox);

        if (row.secondaryValue) {
          box.add_child(
            wrappingLabel(localizeDetail(row.secondaryValue, _))
          );
        }

        this._addInactiveItem(box, detailsItem.menu);
      });
    });

    this._contentSection.addMenuItem(detailsItem);
  }

  /**
   * Render an error with a recovery hint.
   */
  _renderError(activeData) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      x_expand: true,
      style_class: "codexbar-spacing-12",
    });
    box.add_child(
      new St.Icon({
        icon_name: "dialog-warning-symbolic",
        style_class: "popup-menu-icon",
        y_align: Clutter.ActorAlign.START,
      })
    );

    const text = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      style_class: "codexbar-spacing-4",
    });
    text.add_child(
      new St.Label({
        text: _("Couldn't load usage"),
        style_class: "codexbar-section-title",
      })
    );
    text.add_child(wrappingLabel(activeData.error));
    text.add_child(
      wrappingLabel(_("Check the provider command in Preferences."))
    );
    box.add_child(text);

    this._addInactiveItem(box);
  }

  /**
   * Render the first-run / missing dependency screen.
   */
  _renderWelcome(codexbarExists, importerExists, certInstalled) {
    const intro = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      style_class: "codexbar-spacing-4",
    });
    intro.add_child(
      new St.Label({
        text: _("Welcome to CodexBar"),
        style_class: "codexbar-title",
      })
    );
    intro.add_child(
      wrappingLabel(_("Track your AI provider usage from the top bar."))
    );
    this._addInactiveItem(intro);

    this._addLanguageSwitcher();

    this._addDependency({
      title: _("CodexBar CLI"),
      description: _("Required to query AI usage metrics."),
      installed: codexbarExists,
      optional: false,
      command: "brew install steipete/tap/codexbar",
    });

    this._addDependency({
      title: _("Cookie Importer"),
      description: _(
        "Automatically extracts the Codex (ChatGPT) session cookie from your browser."
      ),
      installed: importerExists,
      optional: true,
      command:
        "mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-cookie-importer -o ~/.local/bin/codexbar-cookie-importer && chmod +x ~/.local/bin/codexbar-cookie-importer",
    });

    this._addDependency({
      title: _("Antigravity Helper"),
      description: _(
        "Trusts the local Antigravity server certificate. Requires administrator privileges."
      ),
      installed: certInstalled,
      optional: true,
      command:
        "mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-ssl-helper -o ~/.local/bin/codexbar-ssl-helper && chmod +x ~/.local/bin/codexbar-ssl-helper && codexbar-ssl-helper",
    });

    this._contentSection.addAction(_("Get Started"), () => {
      // The settings change rebuilds the popup, so let the activation finish
      // before the item that received the click is destroyed.
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        if (!this._indicator || !this._settings) return GLib.SOURCE_REMOVE;
        this._settings.set_boolean("first-run", false);
        this._refreshData();
        return GLib.SOURCE_REMOVE;
      });
    });
  }

  /**
   * Add a language selector to the welcome screen.
   */
  _addLanguageSwitcher() {
    // Language names stay in their own language; not passed to gettext.
    const languages = [
      ["en", "English"],
      ["es", "Español"],
      ["pt_BR", "Português (Brasil)"],
    ];
    const currentLang = this._settings.get_string("language");
    const currentName =
      languages.find(([code]) => code === currentLang)?.[1] ?? "English";

    const item = new PopupMenu.PopupSubMenuMenuItem(
      formatText(_("Language: %s"), currentName)
    );
    languages.forEach(([code, name]) => {
      const row = new PopupMenu.PopupMenuItem(name);
      row.setOrnament(
        code === currentLang
          ? PopupMenu.Ornament.DOT
          : PopupMenu.Ornament.NO_DOT
      );
      row.accessible_role = Atk.Role.CHECK_MENU_ITEM;
      row.connect("activate", () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          if (!this._settings) return GLib.SOURCE_REMOVE;
          this._settings.set_string("language", code);
          return GLib.SOURCE_REMOVE;
        });
      });
      item.menu.addMenuItem(row);
    });
    this._contentSection.addMenuItem(item);
  }

  /**
   * Add one dependency row with a status icon and, when missing, its install
   * command with a Copy button.
   */
  _addDependency({ title, description, installed, optional, command }) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      style_class: "codexbar-spacing-6",
    });

    const header = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      x_expand: true,
      style_class: "codexbar-spacing-6",
    });
    const iconName = installed
      ? "object-select-symbolic"
      : optional
        ? "dialog-information-symbolic"
        : "dialog-warning-symbolic";
    header.add_child(
      new St.Icon({
        icon_name: iconName,
        style_class: "popup-menu-icon",
        y_align: Clutter.ActorAlign.CENTER,
      })
    );
    header.add_child(
      new St.Label({
        text: title,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      })
    );
    header.add_child(
      captionLabel(
        installed ? _("Installed") : optional ? _("Optional") : _("Missing")
      )
    );
    box.add_child(header);
    box.add_child(wrappingLabel(description));

    if (!installed && command) {
      box.add_child(this._createCommandWithCopyButton(command));
    }

    this._addInactiveItem(box);
  }

  /**
   * Render the no-providers state with a direct route to Preferences.
   */
  _renderEmpty() {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      style_class: "codexbar-spacing-4",
    });
    box.add_child(
      new St.Label({
        text: _("No providers configured"),
        style_class: "codexbar-section-title",
      })
    );
    box.add_child(
      wrappingLabel(_("Add a provider in Preferences to start tracking usage."))
    );
    this._addInactiveItem(box);

    this._contentSection.addAction(
      _("Open Preferences"),
      () => this.openPreferences(),
      "preferences-system-symbolic"
    );
  }

  /**
   * Load a provider logo as a Gio.Icon, or null when the asset doesn't exist.
   * @param {string} key
   * @returns {Gio.Icon|null}
   */
  _loadLogoFile(key) {
    if (!key) return null;
    const logoPath = GLib.build_filenamev([
      this.path,
      "media",
      "logos",
      `${key}-symbolic.svg`,
    ]);
    if (!GLib.file_test(logoPath, GLib.FileTest.EXISTS)) return null;
    return Gio.Icon.new_for_string(logoPath);
  }

  /**
   * Get a provider logo as an St.Icon.
   * Art comes from the ACP registry; providers the registry does not list yet
   * still use the bundled SVGs.
   * @param {string} providerId
   * @param {string} [providerName]
   * @returns {St.Icon|null}
   */
  _getProviderLogo(providerId, providerName = "") {
    if (!providerId && !providerName) return null;

    const agent = this._logos?.agent(providerId, providerName);
    if (agent) {
      // Download on first use; ensureIcon revalidates stale icons in the
      // background and calls back into _updateUI when new art arrives.
      this._logos.ensureIcon(agent, this._cancellable);
      const path = this._logos.iconPath(agent);
      if (path)
        return new St.Icon({
          gicon: Gio.Icon.new_for_string(path),
          icon_size: 16,
          style_class: "codexbar-panel-logo",
        });
    }

    // Normalize ID and name: lowercase and replace spaces with dashes
    const candidates = [
      (providerId || "").toLowerCase().replace(/\s+/g, "-"),
      (providerName || "").toLowerCase().replace(/\s+/g, "-"),
    ].filter((c) => c.length > 0);

    // Only the providers missing from the registry are still bundled.
    const knownKeys = [
      "deepseek",
      "openrouter",
      "perplexity",
      "ollama",
    ];

    const tried = new Set();
    const logoFor = (key) => {
      if (!key || tried.has(key)) return null;
      tried.add(key);
      const gicon = this._loadLogoFile(key);
      if (!gicon) return null;
      return new St.Icon({
        gicon,
        icon_size: 16,
        style_class: "codexbar-panel-logo",
      });
    };

    for (const candidate of candidates) {
      const icon = logoFor(candidate);
      if (icon) return icon;
    }

    for (const candidate of candidates) {
      for (const key of knownKeys) {
        if (candidate.includes(key)) {
          const icon = logoFor(key);
          if (icon) return icon;
        }
      }
    }

    return null;
  }

  /**
   * Create a command box with a Copy button.
   */
  _createCommandWithCopyButton(commandText) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      x_expand: true,
      style_class: "codexbar-command-box",
    });

    const cmdLabel = new St.Label({
      text: commandText,
      style_class: "codexbar-command",
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    cmdLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    box.add_child(cmdLabel);

    const copyBtn = new St.Button({
      label: _("Copy"),
      style_class: "button flat codexbar-copy-button",
      can_focus: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    copyBtn.connect("clicked", () => {
      const clipboard = St.Clipboard.get_default();
      clipboard.set_text(St.ClipboardType.CLIPBOARD, commandText);
      copyBtn.label = _("Copied");
      const timeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        1500,
        () => {
          copyBtn.label = _("Copy");
          if (this._copyTimeouts) {
            const index = this._copyTimeouts.indexOf(timeoutId);
            if (index > -1) this._copyTimeouts.splice(index, 1);
          }
          return GLib.SOURCE_REMOVE;
        }
      );
      if (this._copyTimeouts) this._copyTimeouts.push(timeoutId);
    });
    box.add_child(copyBtn);

    return box;
  }
}
