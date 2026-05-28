import type { PublisherPluginFactory } from "reg-suit-interface";

import { DispatchingPreparer, DispatchingPublisher } from "./dispatch";

const factory: PublisherPluginFactory = () => ({
  preparer: new DispatchingPreparer(),
  publisher: new DispatchingPublisher(),
});

export = factory;
