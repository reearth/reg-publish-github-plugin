import { describe, expect, it } from "vitest";

import { ARTIFACT_TYPE, MEDIA_EMPTY_CONFIG, MEDIA_MANIFEST, buildManifest, sha256 } from "./oci-client";

describe("sha256", () => {
  it("matches the well-known empty-config digest", () => {
    // The OCI empty descriptor: sha256 of the two bytes "{}".
    expect(sha256(Buffer.from("{}"))).toBe("sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });

  it("is stable and content-addressable", () => {
    expect(sha256(Buffer.from("hello"))).toBe(sha256(Buffer.from("hello")));
    expect(sha256(Buffer.from("hello"))).not.toBe(sha256(Buffer.from("world")));
  });
});

describe("buildManifest", () => {
  it("builds an OCI manifest with an empty config and the given layers", () => {
    const layers = [{ mediaType: "application/octet-stream", digest: sha256(Buffer.from("a")), size: 1 }];
    const m = buildManifest(layers);
    expect(m.schemaVersion).toBe(2);
    expect(m.mediaType).toBe(MEDIA_MANIFEST);
    expect(m.artifactType).toBe(ARTIFACT_TYPE);
    expect(m.config.mediaType).toBe(MEDIA_EMPTY_CONFIG);
    expect(m.config.size).toBe(2);
    expect(m.layers).toEqual(layers);
  });
});
