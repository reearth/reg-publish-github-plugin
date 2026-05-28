import type { PluginCreateOptions, PluginPreparer, PreparerQuestions } from "reg-suit-interface";

import { DEFAULT_TAG_NAME, resolveConfig, type PluginConfig } from "./config";
import { OctokitClient } from "./octokit-client";

/** Answers collected by {@link GitHubReleasesPreparer.inquire}. */
export interface SetupInquireResult {
  repository?: string;
  tagName?: string;
}

/**
 * Interactive `reg-suit prepare` step: asks for the storage repo and tag, then
 * creates the fixed prerelease (unless `--dry-run`) and returns the config block
 * to write into `regconfig.json`.
 */
export class GitHubReleasesPreparer implements PluginPreparer<SetupInquireResult, PluginConfig> {
  inquire(): PreparerQuestions {
    return [
      {
        name: "repository",
        type: "input",
        message: 'Storage repository "owner/repo" (leave blank to infer from the git remote)',
      },
      {
        name: "tagName",
        type: "input",
        message: "Tag name for the fixed snapshot release",
        default: DEFAULT_TAG_NAME,
      },
    ];
  }

  async prepare(config: PluginCreateOptions<SetupInquireResult>): Promise<PluginConfig> {
    const logger = config.logger;
    const repository = config.options.repository?.trim() || undefined;
    const tagName = config.options.tagName?.trim() || DEFAULT_TAG_NAME;

    const pluginConfig: PluginConfig = { tagName };
    if (repository) pluginConfig.repository = repository;

    if (config.noEmit) {
      logger.info("(dry-run) Skipping creation of the snapshot release.");
      return pluginConfig;
    }

    try {
      const resolved = resolveConfig(pluginConfig, logger);
      const client = new OctokitClient(resolved.token, resolved.owner, resolved.repo);
      const release = await client.ensureRelease(resolved.tagName);
      logger.info(`Snapshot prerelease ready at ${logger.colors.green(release.html_url)}.`);
    } catch (err) {
      logger.warn(
        `Could not create the snapshot release now (${(err as Error).message}). ` +
          "It will be created automatically on the first `reg-suit run` once a token is available.",
      );
    }

    return pluginConfig;
  }
}
