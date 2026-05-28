import type { PluginCreateOptions } from "reg-suit-interface";

import { DEFAULT_REGISTRY, DEFAULT_TAG_NAME, resolveConfig, type PluginConfig } from "./config";

/** Answers relevant to the GHCR backend. */
export interface GhcrInquireResult {
  repository?: string;
  tagName?: string;
  registry?: string;
}

/**
 * `reg-suit prepare` for the GHCR backend. There is nothing to create up front
 * (the package springs into existence on the first push), so this just validates
 * the inputs and returns the config block to write into `regconfig.json`.
 */
export class GhcrPreparer {
  async prepare(config: PluginCreateOptions<GhcrInquireResult>): Promise<PluginConfig> {
    const logger = config.logger;
    const repository = config.options.repository?.trim() || undefined;
    const tagName = config.options.tagName?.trim() || DEFAULT_TAG_NAME;
    const registry = config.options.registry?.trim() || DEFAULT_REGISTRY;

    const pluginConfig: PluginConfig = { backend: "ghcr", tagName, registry };
    if (repository) pluginConfig.repository = repository;

    if (!config.noEmit) {
      try {
        const resolved = resolveConfig(pluginConfig, logger);
        logger.info(
          `GHCR backend ready. Snapshots will be pushed to ` +
            `${logger.colors.green(`${resolved.registry}/${resolved.owner}/${resolved.repo}/${resolved.tagName}`)}.`,
        );
        logger.info("Make sure the token has `packages: write` (and `delete` for retention).");
      } catch (err) {
        logger.warn(`GHCR config is incomplete: ${(err as Error).message}`);
      }
    }

    return pluginConfig;
  }
}
