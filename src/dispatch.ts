import type {
  PluginCreateOptions,
  PluginPreparer,
  PreparerQuestions,
  PublishResult,
  PublisherPlugin,
} from "reg-suit-interface";

import { DEFAULT_BACKEND, DEFAULT_REGISTRY, DEFAULT_TAG_NAME, type Backend, type PluginConfig } from "./config";
import { GhcrPreparer } from "./ghcr-preparer";
import { GhcrPublisherPlugin } from "./ghcr-publisher-plugin";
import { GitHubReleasesPreparer } from "./github-releases-preparer";
import { GitHubReleasesPublisherPlugin } from "./github-releases-publisher-plugin";

function backendOf(config: { backend?: Backend } | undefined): Backend {
  return config?.backend ?? DEFAULT_BACKEND;
}

/**
 * A publisher that delegates to the Releases or GHCR implementation based on the
 * `backend` config option, resolved at `init` time.
 */
export class DispatchingPublisher implements PublisherPlugin<PluginConfig> {
  name = "reg-publish-github-plugin";

  private delegate!: PublisherPlugin<PluginConfig>;

  init(config: PluginCreateOptions<PluginConfig>): void {
    this.delegate =
      backendOf(config.options) === "ghcr" ? new GhcrPublisherPlugin() : new GitHubReleasesPublisherPlugin();
    this.delegate.init(config);
  }

  publish(key: string): Promise<PublishResult> {
    return this.delegate.publish(key);
  }

  fetch(key: string): Promise<unknown> {
    return this.delegate.fetch(key);
  }
}

/** Interactive setup answers, spanning both backends. */
export interface DispatchingInquireResult {
  backend?: Backend;
  repository?: string;
  tagName?: string;
  registry?: string;
}

/**
 * The `reg-suit prepare` step: asks which backend to use plus the common
 * settings, then delegates to that backend's preparer.
 */
export class DispatchingPreparer implements PluginPreparer<DispatchingInquireResult, PluginConfig> {
  inquire(): PreparerQuestions {
    // inquirer's `Question` union doesn't narrow `type` inside a mixed array
    // literal, so the `list` question's `choices` trips excess-property checks.
    const questions = [
      {
        name: "backend",
        type: "list",
        message: "Storage backend",
        choices: ["releases", "ghcr"],
        default: DEFAULT_BACKEND,
      },
      {
        name: "repository",
        type: "input",
        message: 'Storage repository "owner/repo" (leave blank to infer from the git remote)',
      },
      {
        name: "tagName",
        type: "input",
        message: "Snapshot namespace (release tag / GHCR image name)",
        default: DEFAULT_TAG_NAME,
      },
      {
        name: "registry",
        type: "input",
        message: "Container registry (GHCR backend only)",
        default: DEFAULT_REGISTRY,
      },
    ];
    return questions as unknown as PreparerQuestions;
  }

  prepare(config: PluginCreateOptions<DispatchingInquireResult>): Promise<PluginConfig> {
    return backendOf(config.options) === "ghcr"
      ? new GhcrPreparer().prepare(config)
      : new GitHubReleasesPreparer().prepare(config);
  }
}
