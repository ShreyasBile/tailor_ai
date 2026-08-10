import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';

/**
 * Storage client for the worker.
 *
 * The worker hands *presigned URLs* to the GPU service rather than bytes —
 * that's what keeps the Python side stateless and relocatable to a rented GPU
 * without giving it storage credentials.
 */
export class Storage {
  private readonly client: S3Client;
  readonly bucket: string;

  constructor() {
    const cfg = config();
    this.bucket = cfg.S3_BUCKET;
    this.client = new S3Client({
      endpoint: cfg.S3_ENDPOINT,
      region: cfg.S3_REGION,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: cfg.S3_ACCESS_KEY_ID,
        secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async presignGet(key: string, ttl = 3600): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttl,
    });
  }

  async presignPut(key: string, contentType: string, ttl = 3600): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: ttl },
    );
  }

  async put(key: string, body: Buffer | string, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async getJson<T>(key: string): Promise<T> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  }

  async size(key: string): Promise<number> {
    const listed = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: key, MaxKeys: 1 }),
    );
    return Number(listed.Contents?.[0]?.Size ?? 0);
  }

  async exists(key: string): Promise<boolean> {
    const listed = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: key, MaxKeys: 1 }),
    );
    return (listed.Contents ?? []).some((o) => o.Key === key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const objects = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k))
        .map((Key) => ({ Key }));
      if (objects.length) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }),
        );
        deleted += objects.length;
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  /** Deterministic key layout, mirrored from the API. */
  key(parts: { userId: string; jobId: string; kind: string; fileName: string }): string {
    return `users/${parts.userId}/jobs/${parts.jobId}/${parts.kind.toLowerCase()}/${parts.fileName}`;
  }
}
