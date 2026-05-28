import type { PublisherPluginFactory } from "reg-suit-interface";

import { GitHubReleasesPreparer } from "./github-releases-preparer";
import { GitHubReleasesPublisherPlugin } from "./github-releases-publisher-plugin";

const factory: PublisherPluginFactory = () => ({
  preparer: new GitHubReleasesPreparer(),
  publisher: new GitHubReleasesPublisherPlugin(),
});

export = factory;
