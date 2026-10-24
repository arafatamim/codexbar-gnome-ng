
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { UsageFetcher } from '../core/ports/UsageFetcher.js';
import { UsageApiError, extractWindowLabels, parseTextWindowLabels } from '../usageApi.js';

/**
 * ADAPTER (Hexagonal Architecture)
 * Implementation of the UsageFetcher port to run the external 'codexbar' CLI
 * binary as a subprocess. It resolves the executable path dynamically, invokes
 * the tool, and parses stdout/stderr into structured JS objects. Window labels
 * come from the JSON payload; older CLI versions without them fall back to a
 * second run that reads the text output.
 */
export class CliSubprocessFetcher extends UsageFetcher {
    constructor(extensionPath = null) {
        super();
        this._extensionPath = extensionPath;
    }

    /**
     * Ask `codexbar` for JSON unless the command already says how to format
     * its output. Commands saved before the JSON format existed don't.
     * @param {string[]} argv Parsed command line, modified in place.
     */
    _ensureJsonFormat(argv) {
        if (!/^codexbar(\.exe)?$/.test(GLib.path_get_basename(argv[0]))) return;
        const hasFormat = argv.some((arg) =>
            arg === "--format" ||
            arg.startsWith("--format=") ||
            ["--json", "--json-only", "--json-output"].includes(arg)
        );
        if (!hasFormat) argv.push("--format", "json");
    }

    /**
     * Run the command, parse the output, and resolve window labels.
     */
    async fetch(providerCommand, cancellable = null, options = {}) {
        if (!providerCommand) {
            throw new UsageApiError("No command configured");
        }

        const [ok, argv] = GLib.shell_parse_argv(providerCommand);
        if (!ok || !argv || argv.length === 0) {
            throw new UsageApiError("Invalid command line");
        }

        // A bare `codexbar` resolves against GNOME Shell's PATH, which is
        // usually shorter than the one an interactive shell has.
        if (/^codexbar(\.exe)?$/.test(GLib.path_get_basename(argv[0]))) {
            const commonPaths = [
                `/home/linuxbrew/.linuxbrew/bin/${argv[0]}`,
                `${GLib.get_home_dir()}/.local/bin/${argv[0]}`,
                `/usr/local/bin/${argv[0]}`,
                `/usr/bin/${argv[0]}`,
            ];
            const resolved = commonPaths.find((path) =>
                GLib.file_test(path, GLib.FileTest.EXISTS)
            );
            if (resolved) {
                argv[0] = resolved;
            } else if (!GLib.find_program_in_path(argv[0])) {
                throw new UsageApiError(
                    `${argv[0]} was not found. Install the codexbar CLI or set an absolute path in Preferences.`
                );
            }
        }

        // `codexbar` prints a text table unless asked for JSON, and commands
        // saved by older versions of the extension omit the flag.
        this._ensureJsonFormat(argv);
        const finalCommand = argv.map((arg) => GLib.shell_quote(arg)).join(" ");

        // Setup launcher and custom environment (e.g. to propagate correct PATH)
        const env = GLib.get_environ();

        // Fix PATH to ensure codexbar can find the `agy` executable
        let currentPath = "";
        for (const item of env) {
            if (item.startsWith("PATH=")) {
                currentPath = item.substring(5);
                break;
            }
        }
        const userPaths = [
            `${GLib.get_home_dir()}/.local/bin`,
            "/home/linuxbrew/.linuxbrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin"
        ];
        const newPathDirs = [];
        for (const p of userPaths) {
            if (!newPathDirs.includes(p)) {
                newPathDirs.push(p);
            }
        }
        if (currentPath) {
            for (const p of currentPath.split(":")) {
                if (!newPathDirs.includes(p)) {
                    newPathDirs.push(p);
                }
            }
        }
        const newPath = newPathDirs.join(":");
        let pathFound = false;
        for (let i = 0; i < env.length; i++) {
            if (env[i].startsWith("PATH=")) {
                env[i] = `PATH=${newPath}`;
                pathFound = true;
                break;
            }
        }
        if (!pathFound) {
            env.push(`PATH=${newPath}`);
        }

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        });
        launcher.set_environ(env);

        let proc;
        try {
            proc = launcher.spawnv(argv);
        } catch (e) {
            throw new UsageApiError(`Could not run ${argv[0]}: ${e.message}`);
        }

        const [stdout, stderr] = await new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                try {
                    const [ok, out, err] = p.communicate_utf8_finish(res);
                    resolve([out || "", err || ""]);
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        resolve(["", ""]);
                    } else {
                        reject(e);
                    }
                }
            });
        });

        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();

        if (trimmedStdout && (trimmedStdout.startsWith("[") || trimmedStdout.startsWith("{"))) {
            try {
                const parsed = JSON.parse(trimmedStdout);
                if (options.array) {
                    // Callers like `codexbar cost` need every entry, not the first.
                    return { data: parsed, labels: [], command: finalCommand };
                }
                const rawData = Array.isArray(parsed) ? parsed[0] : parsed;
                let labels = extractWindowLabels(rawData);
                if (labels.length === 0) {
                    labels = await this._discoverLabels(argv, env, cancellable);
                }
                return {
                    data: rawData,
                    labels: labels,
                    command: finalCommand
                };
            } catch (e) {
                throw new UsageApiError(`Invalid JSON from codexbar: ${e.message}`);
            }
        } else if (trimmedStderr) {
            throw new UsageApiError(`codexbar failed: ${trimmedStderr.split("\n")[0]}`);
        } else if (trimmedStdout) {
            throw new UsageApiError("codexbar returned text instead of JSON");
        } else {
            throw new UsageApiError("codexbar returned no output");
        }
    }

    /**
     * Fallback for CLI versions whose JSON has no rateWindowLabels: run the
     * text output once more and read the "Label: NN%" lines.
     */
    async _discoverLabels(argv, env, cancellable) {
        try {
            const discoveryArgv = argv.filter((arg, index) => {
                if (arg === "--format") return false;
                if (index > 0 && argv[index - 1] === "--format") return false;
                if (arg.startsWith("--format=")) return false;
                if (arg === "--json-only" || arg === "--json" || arg === "--json-output" || arg === "--pretty") return false;
                return true;
            });

            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            launcher.set_environ(env);
            const proc = launcher.spawnv(discoveryArgv);

            const [stdout] = await new Promise((resolve) => {
                proc.communicate_utf8_async(null, cancellable, (p, res) => {
                    try {
                        const [ok, out] = p.communicate_utf8_finish(res);
                        resolve([out || ""]);
                    } catch (e) {
                        resolve([""]);
                    }
                });
            });

            return parseTextWindowLabels(stdout);
        } catch (e) {
            return [];
        }
    }
}
