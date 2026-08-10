import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '@tailorai/contracts';
import { loadEnv, type Env } from '../../config/env';

export interface PresignedPart {
  partNumber: number;
  url: string;
  expiresAt: string;
}

/**
 * Object storage behind one interface.
 *
 * Bytes never transit the API — the client PUTs directly to storage using
 * presigned URLs. That removes a whole class of memory-pressure and DoS
 * problems, and makes a 60 MB upload over a bad connection the client's
 * concern rather than ours (docs/02 §5).
 *
 * S3-compatible throughout, so MinIO in dev and Cloudflare R2 in production
 * are the same code path.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly env: Env = loadEnv();
  private readonly client: S3Client;
  readonly bucket: string;

  constructor() {
    this.bucket = this.env.S3_BUCKET;
    this.client = new S3Client({
      endpoint: this.env.S3_ENDPOINT,
      region: this.env.S3_REGION,
      forcePathStyle: this.env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: this.env.S3_ACCESS_KEY_ID,
        secretAccessKey: this.env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
      this.logger.log(`Object storage ready (bucket: ${this.bucket})`);
    } catch (err) {
      this.logger.error(
        `Cannot reach bucket "${this.bucket}" at ${this.env.S3_ENDPOINT}. ` +
          `Is the infra stack up? (npm run infra:up)`,
      );
      throw err;
    }
  }

  /**
   * Deterministic, user-scoped key layout. Prefixes group by user then session
   * so a deletion request maps to a single prefix sweep rather than a scan.
   */
  buildKey(parts: {
    userId: string;
    sessionId?: string;
    jobId?: string;
    kind: string;
    fileName: string;
  }): string {
    const segments = ['users', parts.userId];
    if (parts.sessionId) segments.push('sessions', parts.sessionId);
    if (parts.jobId) segments.push('jobs', parts.jobId);
    segments.push(parts.kind.toLowerCase(), parts.fileName);
    return segments.join('/');
  }

  // ── Multipart upload ──

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!res.UploadId) throw new AppError('STORAGE_ERROR', { key }, 'No upload id returned');
    return res.UploadId;
  }

  async presignParts(
    key: string,
    uploadId: string,
    totalParts: number,
  ): Promise<PresignedPart[]> {
    const ttl = this.env.UPLOAD_URL_TTL;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    return Promise.all(
      Array.from({ length: totalParts }, async (_, i) => {
        const partNumber = i + 1;
        const url = await getSignedUrl(
          this.client,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: ttl },
        );
        return { partNumber, url, expiresAt };
      }),
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          // S3 requires ascending part order.
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client
      .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }))
      .catch((err) => this.logger.warn(`Abort failed for ${key}: ${String(err)}`));
  }

  // ── Simple object ops ──

  async putObject(key: string, body: Buffer | string, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async headObject(key: string): Promise<{ sizeBytes: number; contentType?: string } | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: Number(res.ContentLength ?? 0),
        ...(res.ContentType ? { contentType: res.ContentType } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Reads the first N bytes of an object.
   *
   * Used for magic-byte sniffing on upload completion — we need the header, not
   * the 60 MB body, so this is a ranged read rather than a full download.
   */
  async readHeadBytes(key: string, bytes: number): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=0-${bytes - 1}`,
      }),
    );
    if (!res.Body) throw new AppError('STORAGE_ERROR', { key }, 'Empty object body');
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  /** Deletes exactly one object. */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: [{ Key: key }] } }),
    );
  }

  /** Short-lived read URL. Buckets are never public (docs/02 §6). */
  async presignGet(key: string, ttlSeconds?: number): Promise<{ url: string; expiresAt: string }> {
    const ttl = ttlSeconds ?? this.env.DOWNLOAD_URL_TTL;
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttl },
    );
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  async presignPut(
    key: string,
    contentType: string,
    ttlSeconds?: number,
  ): Promise<{ url: string; expiresAt: string }> {
    const ttl = ttlSeconds ?? this.env.UPLOAD_URL_TTL;
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: ttl },
    );
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /**
   * Deletes every object under a prefix.
   *
   * Used by the retention sweeper and by account erasure. Deletion MUST reach
   * object storage — a `deletedAt` on a row while the blob lives on is not
   * deletion, and regulators treat it accordingly (docs/03 §4).
   */
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;

    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      const objects = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k))
        .map((Key) => ({ Key }));

      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }),
        );
        deleted += objects.length;
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);

    this.logger.log(`Purged ${deleted} object(s) under ${prefix}`);
    return deleted;
  }
}
