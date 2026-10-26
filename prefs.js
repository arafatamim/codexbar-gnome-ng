import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";
import Adw from "gi://Adw";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import { applyLanguage, formatText, tr as _ } from "./localize.js";
import {
  storeToken,
  loadToken,
  nullTokenSchema,
} from "./secret.js";
import {
  adoptCustomProviders,
  buildCliCommand,
  CLI_SOURCES,
  DIRECT_API,
  isCustomId,
  parseGeneratedCommand,
  parseIdList,
} from "./providerSources.js";

const CONTACT_EMAIL = "hi@inled.es";
const COOKIE_IMPORTER_COMMAND =
  "mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-cookie-importer -o ~/.local/bin/codexbar-cookie-importer && chmod +x ~/.local/bin/codexbar-cookie-importer";

/**
 * Human label for a source. Looked up lazily so gettext runs after the
 * translation domain is bound, not at module load.
 * @param {string} source
 * @returns {string}
 */
const sourceLabel = (source) =>
  ({
    [DIRECT_API]: _("Direct API (session cookies)"),
    auto: _("Auto"),
    web: _("Web dashboard"),
    cli: _("Local CLI"),
    oauth: _("OAuth"),
    // Qualified because it would otherwise read as a second "Direct API" on
    // the two rows that offer both.
    api: _("Provider API (via CLI)"),
  })[source] || source;

/**
 * Give an icon-only Gtk.Button an accessible name as well as a tooltip.
 * @param {Gtk.Button} button
 * @param {string} label
 */
/**
 * Predefined providers list.
 *
 * `supportsDirectApi` marks the providers this extension can query itself with
 * a keyring cookie; the rest reach their source through codexbar-cli.
 */
const PREDEFINED_PROVIDERS = [
  {
    id: "codex",
    name: "Codex",
    useApi: true,
    supportsDirectApi: true,
    defaultCommand: "",
  },
  {
    id: "ollama",
    name: "Ollama Cloud",
    useApi: true,
    supportsDirectApi: true,
    defaultCommand: "",
  },
  {
    id: "claude",
    name: "Claude",
    useApi: false,
    defaultCommand: "codexbar --provider claude --source cli --format json",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    useApi: false,
    defaultCommand:
      "codexbar --provider antigravity --source cli --format json",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    useApi: false,
    defaultCommand: "codexbar --provider gemini --source api --format json",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    useApi: false,
    defaultCommand: "codexbar --provider deepseek --source api --format json",
  },
  {
    id: "copilot",
    name: "Copilot",
    useApi: false,
    defaultCommand: "codexbar --provider copilot --source api --format json",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    useApi: false,
    defaultCommand: "codexbar --provider openrouter --source api --format json",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    useApi: false,
    defaultCommand: "codexbar --provider perplexity --source api --format json",
  },
  {
    id: "mistral",
    name: "Mistral",
    useApi: false,
    defaultCommand: "codexbar --provider mistral --source api --format json",
  },
];

/**
 * Preferences page for CodexBar.
 */
const CodexBarPrefsPage = GObject.registerClass(
  class CodexBarPrefsPage extends Adw.PreferencesPage {
    _init(settings) {
      super._init({
        title: _("General"),
        icon_name: "preferences-system-symbolic",
      });

      this._settings = settings;
      this._providerRows = [];

      this.add(this._buildSettingsGroup());
      this.add(this._buildProvidersGroup());
      this.add(this._buildMaintenanceGroup());
      this.add(this._buildContributeGroup());
      this.add(this._buildDeveloperGroup());

      this.connect("destroy", () => {
        this._settings = null;
        this._providerRows = [];
      });
    }

    /**
     * Show a simple informational or error alert.
     * @param {string} heading
     * @param {string} body
     */
    _showMessage(heading, body) {
      const root = this.get_root();
      if (!root) return;

      const dialog = new Adw.AlertDialog({ heading, body });
      dialog.add_response("close", _("Close"));
      dialog.set_default_response("close");
      dialog.set_close_response("close");
      dialog.present(root);
    }

    /**
     * Add a standard link row with a chevron to a preferences group.
     * @param {Adw.PreferencesGroup} group
     * @param {{title: string, subtitle: string, icon: string, uri: string}} row
     * @returns {Adw.ActionRow}
     */
    _addLinkRow(group, { title, subtitle, icon, uri }) {
      const row = new Adw.ActionRow({ title, subtitle, activatable: true });
      row.add_prefix(new Gtk.Image({ icon_name: icon }));
      row.add_suffix(
        new Gtk.Image({
          icon_name: "go-next-symbolic",
          css_classes: ["dim-label"],
        })
      );
      row.connect("activated", () => {
        Gio.AppInfo.launch_default_for_uri(uri, null);
      });
      group.add(row);
      return row;
    }

    /**
     * Build the developer/testing group. It stays collapsed and last, since
     * it is only useful when the user is working on provider rendering.
     */
    _buildDeveloperGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Developer and Testing"),
        description: _("Simulate CLI output to check provider rendering."),
      });

      const enabledRow = new Adw.ExpanderRow({
        title: _("Test with Custom CLI Output"),
        subtitle: _(
          "Use a saved JSON payload instead of running the configured providers."
        ),
        expanded: false,
      });

      const enabledSwitch = new Gtk.Switch({
        active: this._settings.get_boolean("dev-custom-output-enabled"),
        valign: Gtk.Align.CENTER,
      });
      this._settings.bind(
        "dev-custom-output-enabled",
        enabledSwitch,
        "active",
        Gio.SettingsBindFlags.DEFAULT
      );
      enabledRow.add_suffix(enabledSwitch);
      group.add(enabledRow);

      const providerNameRow = new Adw.EntryRow({
        title: _("Simulated Provider Name"),
      });
      providerNameRow.set_text(
        this._settings.get_string("dev-custom-output-provider-name") ||
          "Mock Provider"
      );
      this._settings.bind(
        "dev-custom-output-provider-name",
        providerNameRow,
        "text",
        Gio.SettingsBindFlags.DEFAULT
      );
      enabledRow.add_row(providerNameRow);

      const jsonRow = new Adw.ActionRow({
        title: _("JSON Output"),
        subtitle: _("Paste the raw codexbar-cli JSON output to test."),
      });

      const scrolled = new Gtk.ScrolledWindow({
        min_content_height: 120,
        hexpand: true,
        vexpand: false,
      });
      scrolled.set_has_frame(true);

      const jsonView = new Gtk.TextView({
        monospace: true,
        wrap_mode: Gtk.WrapMode.WORD,
      });
      jsonView.get_buffer().set_text(
        this._settings.get_string("dev-custom-output-json") || "[]",
        -1
      );
      jsonView.get_buffer().connect("changed", () => {
        const buffer = jsonView.get_buffer();
        const text = buffer.get_text(
          buffer.get_start_iter(),
          buffer.get_end_iter(),
          true
        );
        this._settings.set_string("dev-custom-output-json", text.trim());
      });
      scrolled.set_child(jsonView);

      const jsonBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 8,
        margin_end: 8,
      });
      jsonBox.append(scrolled);
      jsonRow.add_suffix(jsonBox);
      enabledRow.add_row(jsonRow);

      return group;
    }

    /**
     * Build the contribute and contact group.
     */
    _buildContributeGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Contribute and Contact"),
        description: _("Meet other CodexBar users and Inled projects."),
      });

      this._addLinkRow(group, {
        title: _("Add a New Provider"),
        subtitle: _("Submit a pull request on GitHub."),
        icon: "web-browser-symbolic",
        uri: "https://github.com/InledGroup/codexbar-gnome",
      });

      this._addLinkRow(group, {
        title: _("Leave a Review"),
        subtitle: _("Rate the extension on GNOME Extensions."),
        icon: "starred-symbolic",
        uri: "https://extensions.gnome.org/extension/9841/codexbar/",
      });

      this._addLinkRow(group, {
        title: _("Contact Inled"),
        subtitle: _("Questions or suggestions? Write to us."),
        icon: "mail-message-new-symbolic",
        uri: `mailto:${CONTACT_EMAIL}`,
      });

      this._addLinkRow(group, {
        title: _("Visit inled.es"),
        subtitle: _("Discover more tools and projects."),
        icon: "web-browser-symbolic",
        uri: "https://inled.es",
      });

      const socialRow = new Adw.ExpanderRow({
        title: _("Join the Community"),
        subtitle: _("Follow the project on your preferred platform."),
      });
      socialRow.add_prefix(
        new Gtk.Image({ icon_name: "system-users-symbolic" })
      );

      const addSocialRow = (title, uri) => {
        const row = new Adw.ActionRow({ title, activatable: true });
        row.add_suffix(
          new Gtk.Image({
            icon_name: "go-next-symbolic",
            css_classes: ["dim-label"],
          })
        );
        row.connect("activated", () => {
          Gio.AppInfo.launch_default_for_uri(uri, null);
        });
        socialRow.add_row(row);
      };

      addSocialRow("Discord", "https://discord.com/invite/PSeTkDMnr");
      addSocialRow(
        "Matrix",
        "https://matrix.to/#/!POXBFohLnmrKwRBxTi:matrix.org?via=matrix.org"
      );
      addSocialRow("Telegram", "https://link.inled.es/telegram");
      addSocialRow("YouTube", "https://www.youtube.com/@inledgroup");
      addSocialRow("X (Twitter)", "https://x.com/inledgroup");

      group.add(socialRow);

      return group;
    }

    /**
     * Build the general settings group.
     */
    _buildSettingsGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Settings"),
      });

      const refreshRow = new Adw.SpinRow({
        title: _("Refresh Interval"),
        subtitle: _("Minutes between automatic refreshes."),
        digits: 0,
        adjustment: new Gtk.Adjustment({
          lower: 1,
          upper: 1440,
          step_increment: 1,
          value: this._settings.get_int("refresh-interval"),
        }),
      });
      this._settings.bind(
        "refresh-interval",
        refreshRow.adjustment,
        "value",
        Gio.SettingsBindFlags.DEFAULT
      );
      group.add(refreshRow);

      const displayModeRow = new Adw.ComboRow({
        title: _("Display Mode"),
        subtitle: _("Show quota used or quota remaining."),
        model: new Gtk.StringList({
          strings: [_("Used"), _("Remaining")],
        }),
        selected: this._settings.get_string("display-mode") === "used" ? 0 : 1,
      });
      displayModeRow.connect("notify::selected", () => {
        this._settings.set_string(
          "display-mode",
          displayModeRow.selected === 0 ? "used" : "remaining"
        );
      });
      group.add(displayModeRow);

      const tabWindowRow = new Adw.ComboRow({
        title: _("Tab Usage Bar"),
        subtitle: _("Window shown under each provider name."),
        model: new Gtk.StringList({
          strings: [_("Session"), _("Weekly"), _("Monthly"), _("Disabled")],
        }),
        selected:
          { session: 0, weekly: 1, monthly: 2, disabled: 3 }[
            this._settings.get_string("tab-window")
          ] ?? 0,
      });
      tabWindowRow.connect("notify::selected", () => {
        this._settings.set_string(
          "tab-window",
          ["session", "weekly", "monthly", "disabled"][
            tabWindowRow.selected
          ] ?? "session"
        );
      });
      group.add(tabWindowRow);

      const languageRow = new Adw.ComboRow({
        title: _("Language"),
        // Language names stay in their own language, so no gettext here.
        model: new Gtk.StringList({
          strings: ["English", "Español", "Português (Brasil)"],
        }),
        selected:
          { en: 0, es: 1, pt_BR: 2 }[
            this._settings.get_string("language")
          ] ?? 0,
      });
      languageRow.connect("notify::selected", () => {
        const lang = ["en", "es", "pt_BR"][languageRow.selected] ?? "en";
        if (lang !== this._settings.get_string("language"))
          this._settings.set_string("language", lang);
      });
      group.add(languageRow);

      const showLogosRow = new Adw.SwitchRow({
        title: _("Show Provider Logos"),
        subtitle: _("Display provider logos in the top bar."),
        active: this._settings.get_boolean("show-logos"),
      });
      this._settings.bind(
        "show-logos",
        showLogosRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT
      );
      group.add(showLogosRow);

      const showPacingInfoRow = new Adw.SwitchRow({
        title: _("Show Usage Pacing"),
        subtitle: _("Show reserve, pace, and run-out estimates for usage windows."),
        active: this._settings.get_boolean("show-pacing-info"),
      });
      this._settings.bind(
        "show-pacing-info",
        showPacingInfoRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT
      );
      group.add(showPacingInfoRow);

      const showProviderDetailsRow = new Adw.SwitchRow({
        title: _("Show Provider Details"),
        subtitle: _(
          "Show extra detail sections reported by the provider CLI."
        ),
        active: this._settings.get_boolean("show-provider-details"),
      });
      this._settings.bind(
        "show-provider-details",
        showProviderDetailsRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT
      );
      group.add(showProviderDetailsRow);

      return group;
    }

    /**
     * Build the AI providers configuration group.
     */
    _buildProvidersGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("AI Providers"),
        description: _(
          "Enable providers and choose how each one connects. Direct API uses a session cookie from your keyring; the other options run codexbar-cli."
        ),
      });

      const activeProvidersJson = this._settings.get_string("providers");
      let activeProviders = [];
      try {
        activeProviders = JSON.parse(activeProvidersJson);
      } catch (e) {
        activeProviders = [];
      }

      const adopted = adoptCustomProviders(activeProviders, PREDEFINED_PROVIDERS);
      // Persist straight away rather than waiting for the user to touch a
      // control: until this lands in settings the panel keeps reading the old
      // custom-* ids, and those are what cost the row its logo.
      const adoptedJson = JSON.stringify(adopted);
      if (adoptedJson !== JSON.stringify(activeProviders)) {
        this._settings.set_string("providers", adoptedJson);
      }
      activeProviders = adopted;

      // A provider turned off here must stay off: otherwise the next launch
      // imports it again from codexbar's config.
      const setIgnored = (id, ignored) => {
        if (!id || isCustomId(id)) return;

        const ids = new Set(
          parseIdList(this._settings.get_string("ignored-providers"))
        );
        if (ignored) ids.add(id);
        else ids.delete(id);
        this._settings.set_string(
          "ignored-providers",
          JSON.stringify([...ids])
        );
      };

      const saveProviders = async () => {
        const newProviders = [];
        for (const row of this._providerRows) {
          if (!row._enabledSwitch.active) continue;

          newProviders.push({
            id: row._id,
            name: row._name,
            command: row._commandEntry.get_text(),
            useApi: row._useApi,
            ...(row._source ? { source: row._source } : {}),
            ...(row._panelCheck.active ? { showInPanel: true } : {}),
          });

          if (row._useApi) {
            const token = row._tokenEntry?.get_text();
            if (token) await storeToken(row._id, token);
          }
        }
        this._settings.set_string("providers", JSON.stringify(newProviders));
      };

      const createProviderRow = (info, activeData = null) => {
        const isEnabled = activeData !== null;
        const isPredefined = PREDEFINED_PROVIDERS.some((p) => p.id === info.id);

        // Handle command defaults and migrations.
        let command = info.defaultCommand || "";
        if (activeData) {
          if (
            activeData.command &&
            (activeData.command.includes("--provider") ||
              info.useApi ||
              !isPredefined)
          ) {
            command = activeData.command;
          } else {
            command = info.defaultCommand;
          }
        }

        const row = new Adw.ExpanderRow({
          title: info.name,
          subtitle: isEnabled ? _("Enabled") : _("Disabled"),
          expanded: false,
        });

        row._id = activeData ? activeData.id : info.id;
        row._name = info.name;

        // Which sources this row offers, and which one it starts on. Only
        // predefined rows get a selector - a custom provider's command is
        // whatever the user typed, so claiming a source for it would be a
        // guess. Saved configs predate `source`, so fall back to reading it
        // off the stored command (or the Direct API flag) before the default.
        const sourceOptions = (
          info.supportsDirectApi ? [DIRECT_API] : []
        ).concat(CLI_SOURCES);

        const storedSource =
          activeData?.source ||
          (activeData?.useApi ? DIRECT_API : null) ||
          parseGeneratedCommand(activeData?.command)?.source ||
          (info.useApi ? DIRECT_API : null) ||
          parseGeneratedCommand(info.defaultCommand)?.source ||
          "cli";

        row._source = isPredefined
          ? sourceOptions.includes(storedSource)
            ? storedSource
            : sourceOptions[0]
          : null;
        row._useApi = row._source === DIRECT_API;

        const enabledSwitch = new Gtk.Switch({
          active: isEnabled,
          valign: Gtk.Align.CENTER,
        });
        enabledSwitch.update_property(
          [Gtk.AccessibleProperty.LABEL],
          [info.name]
        );
        enabledSwitch.connect("notify::active", () => {
          row.set_subtitle(
            enabledSwitch.active ? _("Enabled") : _("Disabled")
          );
          row.expanded = enabledSwitch.active;
          setIgnored(row._id, !enabledSwitch.active);
          saveProviders();
        });
        row.add_suffix(enabledSwitch);
        row._enabledSwitch = enabledSwitch;

        const panelRow = new Adw.SwitchRow({
          title: _("Show in Panel"),
          subtitle: _("Show this provider's usage in the top bar."),
          active: !!activeData?.showInPanel,
        });
        panelRow.connect("notify::active", saveProviders);
        row._panelCheck = panelRow;
        row.add_row(panelRow);

        let tokenEntry = null;
        let importRow = null;

        const applySource = (source, { rewriteCommand = true } = {}) => {
          row._source = source;
          row._useApi = source === DIRECT_API;
          if (tokenEntry) tokenEntry.visible = row._useApi;
          if (importRow) importRow.visible = row._useApi;
          commandEntry.visible = !row._useApi;

          if (rewriteCommand && !row._useApi) {
            const current = commandEntry.get_text();
            if (!current.trim() || parseGeneratedCommand(current)) {
              commandEntry.set_text(buildCliCommand(info.id, source));
            }
          }
        };

        if (isPredefined) {
          const sourceRow = new Adw.ComboRow({
            title: _("Connection"),
            model: Gtk.StringList.new(sourceOptions.map(sourceLabel)),
            selected: Math.max(0, sourceOptions.indexOf(row._source)),
          });
          sourceRow.connect("notify::selected", () => {
            const picked = sourceOptions[sourceRow.selected];
            if (!picked || picked === row._source) return;
            applySource(picked);
            saveProviders();
          });
          row.add_row(sourceRow);
        }

        if (info.supportsDirectApi) {
          tokenEntry = new Adw.PasswordEntryRow({
            title: _("Session Cookie"),
          });
          loadToken(row._id)
            .then((token) => {
              if (token) tokenEntry.set_text(token);
            })
            .catch(() => {});
          tokenEntry.connect("notify::text", async () => {
            await storeToken(row._id, tokenEntry.get_text().trim());
            saveProviders();
          });
          row._tokenEntry = tokenEntry;
          row.add_row(tokenEntry);

          importRow = new Adw.ActionRow({
            title: _("Import from Browser"),
            subtitle: _("Extract the session cookie automatically."),
          });

          const spinner = new Gtk.Spinner({
            valign: Gtk.Align.CENTER,
            visible: false,
          });
          const importBtn = new Gtk.Button({
            label: _("Import"),
            valign: Gtk.Align.CENTER,
          });
          importBtn.connect("clicked", () => {
            importBtn.sensitive = false;
            spinner.visible = true;
            spinner.start();
            this._importFromBrowser(row._id, tokenEntry, () => {
              importBtn.sensitive = true;
              spinner.stop();
              spinner.visible = false;
            });
          });

          importRow.add_suffix(spinner);
          importRow.add_suffix(importBtn);
          row.add_row(importRow);
        }

        const commandEntry = new Adw.EntryRow({
          title: _("CLI Command"),
          text: command,
        });
        commandEntry.connect("notify::text", saveProviders);
        row._commandEntry = commandEntry;

        if (isPredefined) {
          const resetBtn = new Gtk.Button({
            label: _("Reset"),
            valign: Gtk.Align.CENTER,
            css_classes: ["flat"],
          });
          resetBtn.set_tooltip_text(_("Reset to the default command"));
          resetBtn.connect("clicked", () => {
            commandEntry.set_text(
              row._source && row._source !== DIRECT_API
                ? buildCliCommand(info.id, row._source)
                : info.defaultCommand
            );
            saveProviders();
          });
          commandEntry.add_suffix(resetBtn);
        }
        row.add_row(commandEntry);

        if (info.id === "antigravity") {
          const hasLsof = !!GLib.find_program_in_path("lsof");
          if (!hasLsof) {
            let lsofCmd = "sudo apt install lsof";
            if (GLib.find_program_in_path("pacman")) {
              lsofCmd = "sudo pacman -S lsof";
            } else if (GLib.find_program_in_path("dnf")) {
              lsofCmd = "sudo dnf install lsof";
            }
            const hintRow = new Adw.ActionRow({
              title: _("Missing Dependency: lsof"),
              subtitle: formatText(_("Install it with: %s"), lsofCmd),
              subtitle_lines: 2,
            });
            hintRow.add_prefix(
              new Gtk.Image({ icon_name: "dialog-warning-symbolic" })
            );
            row.add_row(hintRow);
          }

          if (
            !GLib.file_test(
              "/usr/local/share/ca-certificates/antigravity.crt",
              GLib.FileTest.EXISTS
            )
          ) {
            const certRow = new Adw.ActionRow({
              title: _("Antigravity Certificate"),
              subtitle: _(
                "Antigravity needs a trusted local certificate. Install the helper from the README, then run codexbar-ssl-helper."
              ),
              subtitle_lines: 3,
            });
            certRow.add_prefix(
              new Gtk.Image({ icon_name: "dialog-information-symbolic" })
            );
            row.add_row(certRow);
          }
        }

        if (!isPredefined) {
          const deleteRow = new Adw.ActionRow({
            title: _("Remove Provider"),
            subtitle: _("This provider will be removed from the list."),
          });
          const deleteBtn = new Gtk.Button({
            label: _("Remove"),
            valign: Gtk.Align.CENTER,
            css_classes: ["destructive-action"],
          });
          deleteBtn.connect("clicked", () => {
            const dialog = new Adw.AlertDialog({
              heading: formatText(_("Remove %s?"), info.name),
              body: _("This provider will be removed from the list."),
            });
            dialog.add_response("cancel", _("Cancel"));
            dialog.add_response("remove", _("Remove"));
            dialog.set_response_appearance(
              "remove",
              Adw.ResponseAppearance.DESTRUCTIVE
            );
            dialog.set_close_response("cancel");
            dialog.connect("response", (d, response) => {
              if (response !== "remove") return;
              group.remove(row);
              this._providerRows = this._providerRows.filter(
                (r) => r !== row
              );
              saveProviders();
            });
            const root = this.get_root();
            if (root) dialog.present(root);
          });
          deleteRow.add_suffix(deleteBtn);
          row.add_row(deleteRow);
        }

        applySource(row._source, { rewriteCommand: false });

        this._providerRows.push(row);
        return row;
      };

      const processedIds = new Set();
      const processedNames = new Set();

      PREDEFINED_PROVIDERS.forEach((info) => {
        const infoNameLower = info.name.toLowerCase();
        const activeData =
          activeProviders.find((p) => p.id === info.id) ||
          activeProviders.find((p) => p.name.toLowerCase() === infoNameLower);

        if (activeData) {
          processedIds.add(activeData.id);
          processedNames.add(activeData.name.toLowerCase());
        }
        group.add(createProviderRow(info, activeData));
      });

      activeProviders.forEach((p) => {
        const pNameLower = p.name.toLowerCase();
        if (!processedIds.has(p.id) && !processedNames.has(pNameLower)) {
          group.add(
            createProviderRow(
              {
                id: p.id,
                name: p.name,
                useApi: p.useApi || false,
                defaultCommand: p.command,
              },
              p
            )
          );
        }
      });

      const addRow = new Adw.ButtonRow({
        title: _("Add Custom Provider"),
        start_icon_name: "list-add-symbolic",
      });

      addRow.connect("activated", () => {
        const dialog = new Adw.AlertDialog({
          heading: _("New Provider"),
          body: _("Enter a name and the CLI command that returns usage JSON."),
        });

        const list = new Gtk.ListBox({
          selection_mode: Gtk.SelectionMode.NONE,
          css_classes: ["boxed-list"],
        });
        const nameEntry = new Adw.EntryRow({ title: _("Provider Name") });
        const cmdEntry = new Adw.EntryRow({ title: _("CLI Command") });
        list.append(nameEntry);
        list.append(cmdEntry);
        dialog.set_extra_child(list);

        dialog.add_response("cancel", _("Cancel"));
        dialog.add_response("add", _("Add"));
        dialog.set_response_appearance(
          "add",
          Adw.ResponseAppearance.SUGGESTED
        );
        dialog.set_default_response("add");
        dialog.set_close_response("cancel");

        const updateAddSensitivity = () => {
          dialog.set_response_enabled(
            "add",
            !!nameEntry.get_text().trim() && !!cmdEntry.get_text().trim()
          );
        };
        nameEntry.connect("notify::text", updateAddSensitivity);
        cmdEntry.connect("notify::text", updateAddSensitivity);
        updateAddSensitivity();

        dialog.connect("response", (d, response) => {
          if (response !== "add") return;

          const name = nameEntry.get_text().trim();
          const cmd = cmdEntry.get_text().trim();
          if (!name || !cmd) return;

          const newProvider = {
            id: `custom-${Date.now()}`,
            name,
            command: cmd,
            useApi: false,
          };
          group.remove(addRow);
          group.add(
            createProviderRow(
              {
                id: newProvider.id,
                name: newProvider.name,
                useApi: false,
                defaultCommand: newProvider.command,
              },
              newProvider
            )
          );
          group.add(addRow);
          saveProviders();
        });

        const root = this.get_root();
        if (root) dialog.present(root);
      });

      group.add(addRow);

      return group;
    }

    /**
     * Build the maintenance group.
     */
    _buildMaintenanceGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Maintenance"),
      });

      const setupBtnRow = new Adw.ActionRow({
        title: _("Show Welcome Screen"),
        subtitle: _("Reset the first-run state and show setup in the menu."),
      });
      const setupBtn = new Gtk.Button({
        label: _("Show"),
        valign: Gtk.Align.CENTER,
      });
      setupBtn.connect("clicked", () => {
        this._settings.set_boolean("first-run", true);
      });
      setupBtnRow.add_suffix(setupBtn);
      group.add(setupBtnRow);

      return group;
    }

    /**
     * Import cookies from the browser using the bundled helper.
     * @param {string} providerId
     * @param {Adw.PasswordEntryRow} tokenEntry
     * @param {Function|null} callback
     */
    async _importFromBrowser(providerId, tokenEntry, callback = null) {
      const finish = () => {
        if (callback) callback();
      };

      const showError = (title, message) => {
        this._showMessage(title, message);
        finish();
      };

      const showMissingDialog = () => {
        this._showMessage(
          _("Cookie Importer Missing"),
          `${_("Install the helper by running:")}\n${COOKIE_IMPORTER_COMMAND}`
        );
        finish();
      };

      // Find the executable binary or the copy installed in ~/.local/bin.
      let argv = null;
      if (GLib.find_program_in_path("codexbar-cookie-importer")) {
        argv = ["codexbar-cookie-importer"];
      } else {
        const localBin = GLib.build_filenamev([
          GLib.get_home_dir(),
          ".local",
          "bin",
          "codexbar-cookie-importer",
        ]);
        if (GLib.file_test(localBin, GLib.FileTest.EXISTS)) {
          argv = [localBin];
        }
      }

      if (!argv) {
        showMissingDialog();
        return;
      }

      if (providerId === "ollama") {
        argv.push("--provider", "ollama");
      }

      try {
        const proc = new Gio.Subprocess({
          argv,
          flags:
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);

        const cancellable = new Gio.Cancellable();
        let timedOut = false;

        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
          timedOut = true;
          cancellable.cancel();
          proc.force_exit();
          showError(
            _("Timeout"),
            _(
              "The cookie importer is taking too long. Please ensure your browser is closed and try again."
            )
          );
          return GLib.SOURCE_REMOVE;
        });

        proc.communicate_utf8_async(null, cancellable, async (p, res) => {
          if (timeoutId > 0 && !timedOut) {
            GLib.source_remove(timeoutId);
          }

          try {
            const [success, stdout, stderr] = p.communicate_utf8_finish(res);

            if (timedOut) return;

            if (
              !success &&
              stderr &&
              (stderr.includes("No module named") ||
                stderr.includes("No such file"))
            ) {
              showMissingDialog();
              return;
            }

            if (success && stdout) {
              const result = JSON.parse(stdout.trim());

              if (result.error === "DEPENDENCIES_MISSING") {
                showMissingDialog();
              } else if (result.error) {
                showError(_("Import Failed"), result.details || result.error);
              } else if (result.cookie_header) {
                tokenEntry.set_text(result.cookie_header);
                await storeToken(providerId, result.cookie_header);

                const root = this.get_root();
                if (root) {
                  root.add_toast(
                    new Adw.Toast({
                      title: _("Cookies imported successfully"),
                    })
                  );
                }
                finish();
              }
            } else {
              const err = stderr || _("The importer returned no data.");
              if (err.includes("No module named")) {
                showMissingDialog();
              } else {
                showError(_("Error"), err);
              }
            }
          } catch (e) {
            if (!timedOut) {
              if (e.message && e.message.includes("No module named")) {
                showMissingDialog();
              } else {
                console.error(e, "CodexBar: Error reading importer output");
                showError(_("Unexpected Error"), e.message);
              }
            }
          }
        });
      } catch (e) {
        console.error(e, "CodexBar: Error in _importFromBrowser");
        showMissingDialog();
      }
    }
  }
);

/**
 * Main preferences entry point.
 */
export default class CodexBarPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const domain = this.metadata["gettext-domain"] ?? this.uuid;
    const buildPage = () => {
      applyLanguage(settings.get_string("language"), (lang) => {
        const mo = this.dir
          .get_child("locale")
          .get_child(lang)
          .get_child("LC_MESSAGES")
          .get_child(`${domain}.mo`);
        return mo.query_exists(null) ? mo.load_contents(null)[1] : null;
      });
      const page = new CodexBarPrefsPage(settings);
      window.add(page);
      return page;
    };

    let page = buildPage();
    let destroyed = false;

    // Rebuild so every row shows the newly picked language right away.
    settings.connect("changed::language", () => {
      if (destroyed) return;
      window.remove(page);
      page = buildPage();
    });

    // Null out the token schema when the preferences window closes.
    window.connect("destroy", () => {
      destroyed = true;
      nullTokenSchema();
    });
  }
}
