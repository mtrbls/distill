import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "./version.ts";

const PLUGIN_NAME = "distill";
const MARKETPLACE = "distill";
const KEY = `${PLUGIN_NAME}@${MARKETPLACE}`;

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const PLUGINS_DIR = join(CLAUDE_DIR, "plugins");
const PLUGIN_INSTALL_DIR = join(PLUGINS_DIR, "cache", MARKETPLACE, PLUGIN_NAME, VERSION);
const PLUGIN_MANIFEST_DIR = join(PLUGIN_INSTALL_DIR, ".claude-plugin");
const HOOKS_DIR = join(PLUGIN_INSTALL_DIR, "hooks");

const INSTALLED_PLUGINS_PATH = join(PLUGINS_DIR, "installed_plugins.json");
const KNOWN_MARKETPLACES_PATH = join(PLUGINS_DIR, "known_marketplaces.json");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");

export interface InstallOptions {
  distillBinaryPath: string; // absolute path to the running binary
}

export interface InstallResult {
  pluginDir: string;
  hooksFile: string;
  registeredAt: string;
}

export function installPlugin(opts: InstallOptions): InstallResult {
  mkdirSync(PLUGIN_MANIFEST_DIR, { recursive: true });
  mkdirSync(HOOKS_DIR, { recursive: true });

  // 1) plugin.json (Claude Code reads this for plugin metadata)
  const pluginJson = {
    name: PLUGIN_NAME,
    description: "Mine reusable skills from your Claude Code sessions",
    version: VERSION,
    author: { name: "distill" },
    homepage: "https://distill.plouto.ai",
    repository: "https://github.com/PloutoAI/distill",
    license: "MIT",
    keywords: ["claude-code", "skills", "mining"],
  };
  writeFileSync(
    join(PLUGIN_MANIFEST_DIR, "plugin.json"),
    JSON.stringify(pluginJson, null, 2) + "\n",
  );

  // 2) hooks.json
  const hooksJson = {
    description:
      "distill: mines reusable skills from session activity in the background",
    hooks: {
      // per user message, not per tool call: long-lived sessions get
      // mid-session mining without a process spawn on every Bash/Edit
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: `${opts.distillBinaryPath} hook counter`,
              timeout: 5,
              async: true,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `${opts.distillBinaryPath} hook stop`,
              timeout: 30,
              async: true,
            },
          ],
        },
      ],
    },
  };
  const hooksFile = join(HOOKS_DIR, "hooks.json");
  writeFileSync(hooksFile, JSON.stringify(hooksJson, null, 2) + "\n");

  // 3) Mark .in_use so Claude Code's GC won't sweep us
  writeFileSync(join(PLUGIN_INSTALL_DIR, ".in_use"), new Date().toISOString());

  // 4) Add to installed_plugins.json
  const registeredAt = new Date().toISOString();
  const installed: JsonObject = readJsonOrDefault(INSTALLED_PLUGINS_PATH, {
    version: 2,
    plugins: {},
  });
  const plugins: JsonObject = (installed.plugins as JsonObject) ?? {};
  plugins[KEY] = [
    {
      scope: "user",
      installPath: PLUGIN_INSTALL_DIR,
      version: VERSION,
      installedAt: registeredAt,
      lastUpdated: registeredAt,
    },
  ];
  installed.plugins = plugins;
  mkdirSync(PLUGINS_DIR, { recursive: true });
  writeFileSync(INSTALLED_PLUGINS_PATH, JSON.stringify(installed, null, 2) + "\n");

  // 5) The marketplace itself. Tested without it (2026-06-10): the
  // plugin silently does not load. A marketplace is a directory at
  // plugins/marketplaces/<name>/ holding .claude-plugin/marketplace.json
  // that lists plugins with relative source paths; known_marketplaces'
  // installLocation points at that directory. Mirror the layout of
  // working marketplaces exactly.
  const marketplaceDir = join(PLUGINS_DIR, "marketplaces", MARKETPLACE);
  mkdirSync(join(marketplaceDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(marketplaceDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: MARKETPLACE,
        owner: { name: "distill", url: "https://github.com/mtrbls/distill" },
        plugins: [
          {
            name: PLUGIN_NAME,
            description: "Mine reusable skills from your Claude Code sessions",
            source: "./plugin",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  // the plugin source the marketplace points at: same manifest + hooks
  // as the cache copy
  mkdirSync(join(marketplaceDir, "plugin", ".claude-plugin"), { recursive: true });
  mkdirSync(join(marketplaceDir, "plugin", "hooks"), { recursive: true });
  writeFileSync(
    join(marketplaceDir, "plugin", ".claude-plugin", "plugin.json"),
    JSON.stringify(pluginJson, null, 2) + "\n",
  );
  writeFileSync(
    join(marketplaceDir, "plugin", "hooks", "hooks.json"),
    JSON.stringify(hooksJson, null, 2) + "\n",
  );

  const marketplaces: JsonObject = readJsonOrDefault(KNOWN_MARKETPLACES_PATH, {});
  marketplaces[MARKETPLACE] = {
    source: {
      source: "github",
      repo: "mtrbls/distill",
    },
    installLocation: marketplaceDir,
    lastUpdated: registeredAt,
    autoUpdate: false,
  };
  writeFileSync(KNOWN_MARKETPLACES_PATH, JSON.stringify(marketplaces, null, 2) + "\n");

  // 6) Enable the plugin in settings.json
  const settings: JsonObject = readJsonOrDefault(SETTINGS_PATH, {});
  const enabledPlugins: JsonObject = (settings.enabledPlugins as JsonObject) ?? {};
  enabledPlugins[KEY] = true;
  settings.enabledPlugins = enabledPlugins;
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");

  return { pluginDir: PLUGIN_INSTALL_DIR, hooksFile, registeredAt };
}

export function uninstallPlugin(): { removed: string[] } {
  const removed: string[] = [];

  // 1) Remove plugin install dir + marketplace dir
  if (existsSync(PLUGIN_INSTALL_DIR)) {
    rmSync(PLUGIN_INSTALL_DIR, { recursive: true, force: true });
    removed.push(PLUGIN_INSTALL_DIR);
  }
  const marketplaceDir = join(PLUGINS_DIR, "marketplaces", MARKETPLACE);
  if (existsSync(marketplaceDir)) {
    rmSync(marketplaceDir, { recursive: true, force: true });
    removed.push(marketplaceDir);
  }

  // 2) installed_plugins.json
  if (existsSync(INSTALLED_PLUGINS_PATH)) {
    const installed: JsonObject = readJsonOrDefault(INSTALLED_PLUGINS_PATH, {
      version: 2,
      plugins: {},
    });
    const plugins = (installed.plugins as JsonObject) ?? {};
    if (plugins[KEY]) {
      delete plugins[KEY];
      installed.plugins = plugins;
      writeFileSync(INSTALLED_PLUGINS_PATH, JSON.stringify(installed, null, 2) + "\n");
      removed.push(`installed_plugins.json: ${KEY}`);
    }
  }

  // 3) known_marketplaces.json
  if (existsSync(KNOWN_MARKETPLACES_PATH)) {
    const marketplaces: JsonObject = readJsonOrDefault(KNOWN_MARKETPLACES_PATH, {});
    if (marketplaces[MARKETPLACE]) {
      delete marketplaces[MARKETPLACE];
      writeFileSync(KNOWN_MARKETPLACES_PATH, JSON.stringify(marketplaces, null, 2) + "\n");
      removed.push(`known_marketplaces.json: ${MARKETPLACE}`);
    }
  }

  // 4) settings.json
  if (existsSync(SETTINGS_PATH)) {
    const settings: JsonObject = readJsonOrDefault(SETTINGS_PATH, {});
    const enabledPlugins = (settings.enabledPlugins as JsonObject) ?? {};
    if (enabledPlugins[KEY] !== undefined) {
      delete enabledPlugins[KEY];
      settings.enabledPlugins = enabledPlugins;
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
      removed.push(`settings.json: ${KEY}`);
    }
  }

  return { removed };
}

export function isInstalled(): boolean {
  if (!existsSync(INSTALLED_PLUGINS_PATH)) return false;
  try {
    const installed = JSON.parse(readFileSync(INSTALLED_PLUGINS_PATH, "utf-8")) as JsonObject;
    const plugins = installed?.plugins as JsonObject | undefined;
    return !!(plugins && plugins[KEY]);
  } catch {
    return false;
  }
}

type JsonObject = Record<string, unknown>;

function readJsonOrDefault<T extends JsonObject>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}
