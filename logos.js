import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup";

import { matchAgent } from "./logoMatch.js";

// GJS does not promisify Soup's async methods automatically; without this the
// awaited send_and_read_async() call fails the argument-count check.
Gio._promisify(
  Soup.Session.prototype,
  "send_and_read_async",
  "send_and_read_finish"
);

// Provider icons come from the ACP agent registry instead of the bundle:
// assets stay current without shipping a copy per provider. Registry and
// icons are cached under the user cache dir and revalidated with ETags.

const REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_TTL = 6 * 60 * 60; // seconds between revalidation attempts
const ICON_TTL = 30 * 24 * 60 * 60; // icons rarely change; revalidate monthly
const RETRY_AFTER = 10 * 60; // seconds before retrying a failed download

/**
 * Disk cache for registry metadata and provider icons.
 */
export class LogoCache {
  /**
   * @param {() => void} onChange Called when a download makes new art available.
   */
  constructor(onChange) {
    this._onChange = onChange;
    this._dir = GLib.build_filenamev([
      GLib.get_user_cache_dir(),
      "codexbar",
      "logos",
    ]);
    this._iconsDir = GLib.build_filenamev([this._dir, "icons"]);
    this._agents = [];
    this._manifest = {};
    this._pending = new Map();
    this._failedAt = new Map();
    this._lastRegistryCheck = 0;
    this._session = new Soup.Session();
    this._session.set_timeout(20);

    this._agents = this._readJson(this._registryPath())?.agents ?? [];
    this._manifest = this._readJson(this._manifestPath()) ?? {};
  }

  /**
   * The registry entry for a provider, or null.
   * @param {string} providerId
   * @param {string} [providerName]
   * @returns {object|null}
   */
  agent(providerId, providerName = "") {
    return matchAgent(this._agents, providerId, providerName);
  }

  /**
   * Cached icon path for an agent, or null when it has not been downloaded.
   * @param {object} agent Registry entry.
   * @returns {string|null}
   */
  iconPath(agent) {
    if (!agent?.id) return null;
    const path = this._iconFile(agent);
    return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
  }

  /**
   * Download an icon when missing or stale. Concurrent calls share one request.
   * @param {object} agent Registry entry.
   * @param {Gio.Cancellable|null} [cancellable]
   * @returns {Promise<string|null>} Cached path, or null on failure.
   */
  ensureIcon(agent, cancellable = null) {
    if (!agent?.icon || !agent.id) return Promise.resolve(null);

    const cached = this.iconPath(agent);
    const meta = this._manifest[agent.id];
    const now = this._now();
    if (cached && meta && now - (meta.fetchedAt || 0) < ICON_TTL)
      return Promise.resolve(cached);
    if (now - (this._failedAt.get(agent.id) || 0) < RETRY_AFTER)
      return Promise.resolve(cached);
    if (this._pending.has(agent.id)) return this._pending.get(agent.id);

    const download = (async () => {
      try {
        let res = await this._get(agent.icon, meta?.etag, cancellable);
        // A validator can survive the cached file (cleared cache dir): ask
        // again without it so the bytes come back.
        if (res.status === Soup.Status.NOT_MODIFIED && !cached)
          res = await this._get(agent.icon, null, cancellable);
        if (res.status === Soup.Status.NOT_MODIFIED) {
          this._manifest[agent.id] = { etag: res.etag, fetchedAt: this._now() };
          this._writeJson(this._manifestPath(), this._manifest);
          return cached;
        }
        if (res.status !== Soup.Status.OK) throw new Error(`HTTP ${res.status}`);

        const bytes = res.bytes?.get_data();
        if (!bytes?.length) throw new Error("empty icon");
        GLib.mkdir_with_parents(this._iconsDir, 0o755);
        const path = this._iconFile(agent);
        if (!GLib.file_set_contents(path, bytes))
          throw new Error(`cannot write ${path}`);
        this._manifest[agent.id] = { etag: res.etag, fetchedAt: this._now() };
        this._writeJson(this._manifestPath(), this._manifest);
        this._onChange?.();
        return path;
      } catch (error) {
        this._failedAt.set(agent.id, this._now());
        if (!cancellable?.is_cancelled?.())
          console.error(
            `CodexBar: logo download failed for ${agent.id}: ${error.message}`
          );
        return cached;
      } finally {
        this._pending.delete(agent.id);
      }
    })();
    this._pending.set(agent.id, download);
    return download;
  }

  /**
   * Revalidate the registry itself; a 304 or an offline device leaves the
   * cached copy in place.
   * @param {Gio.Cancellable|null} [cancellable]
   * @returns {Promise<void>}
   */
  async refresh(cancellable = null) {
    const now = this._now();
    if (now - this._lastRegistryCheck < REGISTRY_TTL) return;
    this._lastRegistryCheck = now;

    try {
      const res = await this._get(
        REGISTRY_URL,
        this._readText(this._etagPath()),
        cancellable
      );
      if (res.status === Soup.Status.NOT_MODIFIED) return;
      if (res.status !== Soup.Status.OK) return;

      const text = new TextDecoder().decode(res.bytes?.get_data() ?? []);
      const agents = JSON.parse(text)?.agents;
      if (!Array.isArray(agents) || agents.length === 0) return;

      if (GLib.mkdir_with_parents(this._dir, 0o755) !== 0) return;
      GLib.file_set_contents(this._registryPath(), text);
      GLib.file_set_contents(this._etagPath(), res.etag || "");
      this._agents = agents;
      this._onChange?.();
    } catch (error) {
      // Offline or malformed payload: keep using the cached registry.
    }
  }

  /**
   * Drop the network session and any in-flight requests.
   */
  destroy() {
    this._session.abort();
    this._pending.clear();
    this._agents = [];
    this._manifest = {};
  }

  _iconFile(agent) {
    // The -symbolic suffix is what makes St recolour a file icon with the
    // theme foreground; without it the SVG's currentColor renders as black.
    const name = String(agent.id).replace(/[^a-zA-Z0-9._-]/g, "_");
    return GLib.build_filenamev([this._iconsDir, `${name}-symbolic.svg`]);
  }

  _registryPath() {
    return GLib.build_filenamev([this._dir, "registry.json"]);
  }

  _etagPath() {
    return GLib.build_filenamev([this._dir, "registry.etag"]);
  }

  _manifestPath() {
    return GLib.build_filenamev([this._dir, "icons.json"]);
  }

  _now() {
    return Math.floor(Date.now() / 1000);
  }

  async _get(url, etag, cancellable) {
    const message = Soup.Message.new("GET", url);
    message.get_request_headers().append("User-Agent", "codexbar-gnome");
    if (etag) message.get_request_headers().append("If-None-Match", etag);
    const bytes = await this._session.send_and_read_async(
      message,
      GLib.PRIORITY_DEFAULT,
      cancellable
    );
    return {
      status: message.get_status(),
      bytes,
      etag: message.get_response_headers().get_one("ETag") || etag,
    };
  }

  _readText(path) {
    try {
      const [ok, data] = GLib.file_get_contents(path);
      return ok ? new TextDecoder().decode(data).trim() : "";
    } catch (error) {
      return "";
    }
  }

  _readJson(path) {
    const text = this._readText(path);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  _writeJson(path, value) {
    GLib.mkdir_with_parents(this._dir, 0o755);
    GLib.file_set_contents(path, JSON.stringify(value));
  }
}
