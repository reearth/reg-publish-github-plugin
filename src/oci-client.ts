import crypto from "crypto";

export const MEDIA_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const MEDIA_INDEX = "application/vnd.oci.image.index.v1+json";
export const MEDIA_EMPTY_CONFIG = "application/vnd.oci.empty.v1+json";
export const MEDIA_LAYER = "application/octet-stream";
export const ARTIFACT_TYPE = "application/vnd.reg-suit.snapshots.v1+json";
export const TITLE_ANNOTATION = "org.opencontainers.image.title";

/** The canonical OCI empty config blob: the two bytes `{}`. */
const EMPTY_CONFIG = Buffer.from("{}");

export interface OciLayer {
  mediaType: string;
  digest: string;
  size: number;
  annotations?: Record<string, string>;
}

export interface OciManifest {
  schemaVersion: number;
  mediaType: string;
  artifactType?: string;
  config: { mediaType: string; digest: string; size: number };
  layers: OciLayer[];
}

/** Compute the `sha256:<hex>` digest of a buffer. */
export function sha256(buf: Buffer): string {
  return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}

/** Build an OCI image manifest with an empty config and the given layers. */
export function buildManifest(layers: OciLayer[]): OciManifest {
  return {
    schemaVersion: 2,
    mediaType: MEDIA_MANIFEST,
    artifactType: ARTIFACT_TYPE,
    config: { mediaType: MEDIA_EMPTY_CONFIG, digest: sha256(EMPTY_CONFIG), size: EMPTY_CONFIG.length },
    layers,
  };
}

export interface OciClientOptions {
  /** Registry host, e.g. "ghcr.io". */
  registry: string;
  /** Full repository path within the registry, e.g. "owner/repo/reg-snapshots". */
  imagePath: string;
  /** Username for the token exchange (registry Basic auth). */
  username: string;
  /** Token used as the password in the token exchange. */
  token: string;
}

/**
 * Minimal OCI Distribution (registry v2) client over `fetch`, sufficient for
 * pushing/pulling content-addressable snapshot artifacts. Avoids a binary
 * dependency on the ORAS CLI.
 */
export class OciClient {
  private readonly base: string;
  private readonly tokenCache = new Map<string, string>();

  constructor(private readonly opts: OciClientOptions) {
    this.base = `https://${opts.registry}`;
  }

  /** Exchange credentials for a bearer token scoped to the given actions ("pull" / "pull,push"). */
  private async authToken(actions: string): Promise<string> {
    const cached = this.tokenCache.get(actions);
    if (cached) return cached;

    const scope = `repository:${this.opts.imagePath}:${actions}`;
    const url = `${this.base}/token?service=${encodeURIComponent(this.opts.registry)}&scope=${encodeURIComponent(scope)}`;
    const headers: Record<string, string> = {};
    if (this.opts.token) {
      headers.Authorization = "Basic " + Buffer.from(`${this.opts.username}:${this.opts.token}`).toString("base64");
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`OCI auth failed (${res.status}) for scope "${scope}".`);
    }
    const body = (await res.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new Error("OCI auth returned no token.");
    this.tokenCache.set(actions, token);
    return token;
  }

  private async bearer(actions: string): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.authToken(actions)}` };
  }

  /** True if a blob with this digest already exists in the registry. */
  async blobExists(digest: string): Promise<boolean> {
    const res = await fetch(`${this.base}/v2/${this.opts.imagePath}/blobs/${digest}`, {
      method: "HEAD",
      headers: await this.bearer("pull,push"),
    });
    return res.status === 200;
  }

  /** Upload a blob if it is not already present (the registry deduplicates by digest). */
  async ensureBlob(digest: string, data: Buffer): Promise<void> {
    if (await this.blobExists(digest)) return;

    const start = await fetch(`${this.base}/v2/${this.opts.imagePath}/blobs/uploads/`, {
      method: "POST",
      headers: await this.bearer("pull,push"),
    });
    if (start.status !== 202) {
      throw new Error(`Blob upload init failed (${start.status}): ${await safeText(start)}`);
    }
    const location = start.headers.get("location");
    if (!location) throw new Error("Blob upload init returned no Location header.");

    const uploadUrl = new URL(location, this.base);
    uploadUrl.searchParams.set("digest", digest);
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        ...(await this.bearer("pull,push")),
        "Content-Type": MEDIA_LAYER,
        "Content-Length": String(data.length),
      },
      body: data,
    });
    if (put.status !== 201) {
      throw new Error(`Blob upload failed (${put.status}): ${await safeText(put)}`);
    }
  }

  /** Push a manifest (with its empty config blob) under the given tag. */
  async pushManifest(tag: string, layers: OciLayer[]): Promise<void> {
    await this.ensureBlob(sha256(EMPTY_CONFIG), EMPTY_CONFIG);
    const body = Buffer.from(JSON.stringify(buildManifest(layers)));
    const res = await fetch(`${this.base}/v2/${this.opts.imagePath}/manifests/${encodeURIComponent(tag)}`, {
      method: "PUT",
      headers: { ...(await this.bearer("pull,push")), "Content-Type": MEDIA_MANIFEST },
      body,
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`Manifest push failed (${res.status}): ${await safeText(res)}`);
    }
  }

  /** Fetch a manifest by tag, or `null` when it does not exist. */
  async getManifest(tag: string): Promise<OciManifest | null> {
    const res = await fetch(`${this.base}/v2/${this.opts.imagePath}/manifests/${encodeURIComponent(tag)}`, {
      headers: { ...(await this.bearer("pull")), Accept: `${MEDIA_MANIFEST}, ${MEDIA_INDEX}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Manifest pull failed (${res.status}): ${await safeText(res)}`);
    return (await res.json()) as OciManifest;
  }

  /** Download a blob's bytes by digest. */
  async getBlob(digest: string): Promise<Buffer> {
    const res = await fetch(`${this.base}/v2/${this.opts.imagePath}/blobs/${digest}`, {
      headers: await this.bearer("pull"),
    });
    if (!res.ok) throw new Error(`Blob pull failed (${res.status}) for ${digest}.`);
    return Buffer.from(await res.arrayBuffer());
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
