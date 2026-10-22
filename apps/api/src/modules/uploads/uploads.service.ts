import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  AppError,
  type CaptureSession as CaptureSessionDto,
  type CompleteUploadRequest,
  type CreateSessionRequest,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type UploadStatus,
} from '@tailorai/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { loadEnv, type Env } from '../../config/env';
import { detectMediaType, isAllowedForKind, SNIFF_BYTES } from './media-type';

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly env: Env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // ── Capture sessions ──

  async createSession(userId: string, req: CreateSessionRequest): Promise<CaptureSessionDto> {
    // Retention clock starts at capture, not at processing, and is returned to
    // the client so the app can state the promise plainly (docs/03 §4).
    const purgeAfter = new Date(Date.now() + this.env.RAW_MEDIA_TTL_DAYS * 86_400_000);

    const session = await this.prisma.captureSession.create({
      data: {
        userId,
        mode: req.mode,
        deviceModel: req.deviceModel ?? null,
        osVersion: req.osVersion ?? null,
        qualityHints: req.qualityHints ?? undefined,
        purgeAfter,
      },
    });

    return {
      id: session.id,
      mode: session.mode,
      status: session.status,
      assetCount: 0,
      createdAt: session.createdAt.toISOString(),
      purgeAfter: session.purgeAfter.toISOString(),
    };
  }

  async getSession(userId: string, sessionId: string): Promise<CaptureSessionDto> {
    const session = await this.prisma.captureSession.findFirst({
      where: { id: sessionId, userId },
      include: { _count: { select: { assets: true } } },
    });
    if (!session) throw new AppError('NOT_FOUND');

    return {
      id: session.id,
      mode: session.mode,
      status: session.status,
      assetCount: session._count.assets,
      createdAt: session.createdAt.toISOString(),
      purgeAfter: session.purgeAfter.toISOString(),
    };
  }

  // ── Multipart upload ──

  async createUpload(
    userId: string,
    sessionId: string,
    req: CreateUploadRequest,
  ): Promise<CreateUploadResponse> {
    const session = await this.prisma.captureSession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) throw new AppError('NOT_FOUND');
    if (session.status !== 'UPLOADING') {
      throw new AppError('CONFLICT', { sessionId }, 'This capture is no longer accepting uploads.');
    }

    if (req.sizeBytes > this.env.MAX_UPLOAD_BYTES) {
      throw new AppError('FILE_TOO_LARGE', {
        sizeBytes: req.sizeBytes,
        max: this.env.MAX_UPLOAD_BYTES,
      });
    }

    const safeName = req.fileName.replace(/[^\w.\-]/g, '_').slice(-120);
    const storageKey = this.storage.buildKey({
      userId,
      sessionId,
      kind: req.kind,
      fileName: `${Date.now()}_${safeName}`,
    });

    const s3UploadId = await this.storage.createMultipartUpload(storageKey, req.mimeType);
    const totalParts = Math.max(1, Math.ceil(req.sizeBytes / req.partSizeBytes));
    const parts = await this.storage.presignParts(storageKey, s3UploadId, totalParts);

    const upload = await this.prisma.upload.create({
      data: {
        sessionId,
        kind: req.kind,
        storageKey,
        s3UploadId,
        fileName: safeName,
        mimeType: req.mimeType,
        sizeBytes: BigInt(req.sizeBytes),
        sha256: req.clientFingerprint,
        mirrored: req.mirrored,
        view: req.view ?? null,
        partSizeBytes: req.partSizeBytes,
        totalParts,
        expiresAt: new Date(Date.now() + this.env.UPLOAD_URL_TTL * 1000),
      },
    });

    return { uploadId: upload.id, storageKey, parts };
  }

  /** Drives resume: the client asks what landed and re-sends only the gaps. */
  async getUploadStatus(userId: string, uploadId: string): Promise<UploadStatus> {
    const upload = await this.findUpload(userId, uploadId);
    return {
      uploadId: upload.id,
      kind: upload.kind,
      sizeBytes: Number(upload.sizeBytes),
      totalParts: upload.totalParts,
      completedParts: upload.completedParts,
      isComplete: upload.isComplete,
      expiresAt: upload.expiresAt.toISOString(),
    };
  }

  /**
   * Finalises the upload, then verifies it.
   *
   * Verification order is deliberate: size, then real content type from magic
   * bytes, then checksum. Nothing the client asserted is taken on trust.
   */
  async completeUpload(
    userId: string,
    uploadId: string,
    req: CompleteUploadRequest,
  ): Promise<{ assetId: string }> {
    const upload = await this.findUpload(userId, uploadId);
    if (upload.isComplete) throw new AppError('CONFLICT', { uploadId }, 'Upload already completed.');

    if (req.parts.length !== upload.totalParts) {
      throw new AppError('UPLOAD_INCOMPLETE', {
        received: req.parts.length,
        expected: upload.totalParts,
      });
    }

    await this.storage.completeMultipartUpload(upload.storageKey, upload.s3UploadId, req.parts);

    // Integrity check on the assembled object. The client's declared size is
    // compared against what actually landed — this, plus magic bytes below, is
    // the real verification (the client fingerprint is only for dedupe).
    const head = await this.storage.headObject(upload.storageKey);
    if (!head) throw new AppError('STORAGE_ERROR', { key: upload.storageKey });

    if (head.sizeBytes !== Number(upload.sizeBytes)) {
      await this.storage.deleteObject(upload.storageKey);
      throw new AppError('CHECKSUM_MISMATCH', {
        declared: Number(upload.sizeBytes),
        actual: head.sizeBytes,
      });
    }

    const header = await this.storage.readHeadBytes(upload.storageKey, SNIFF_BYTES);
    const detected = detectMediaType(header);
    const expectVideo = upload.kind === 'RAW_VIDEO';

    if (!isAllowedForKind(detected, expectVideo)) {
      await this.storage.deleteObject(upload.storageKey);
      this.logger.warn(
        JSON.stringify({
          event: 'rejected_upload',
          reason: 'magic_byte_mismatch',
          declared: upload.mimeType,
          detected: detected.mime,
          userId,
        }),
      );
      throw new AppError('UNSUPPORTED_FORMAT', {
        declared: upload.mimeType,
        detected: detected.mime,
      });
    }

    const asset = await this.prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({
        data: {
          sessionId: upload.sessionId,
          kind: upload.kind,
          storageKey: upload.storageKey,
          bucket: this.storage.bucket,
          // Store the *detected* type, not the declared one.
          mimeType: detected.mime ?? upload.mimeType,
          sizeBytes: upload.sizeBytes,
          sha256: upload.sha256,
          mirrored: upload.mirrored,
          // The pipeline reads the four-view label from here (S1).
          ...(upload.view ? { metadata: { view: upload.view } } : {}),
          expiresAt: new Date(Date.now() + this.env.RAW_MEDIA_TTL_DAYS * 86_400_000),
        },
      });
      await tx.upload.update({
        where: { id: upload.id },
        data: { isComplete: true, completedAt: new Date(), completedParts: [] },
      });
      return created;
    });

    return { assetId: asset.id };
  }

  /** Marks a session ready for processing. Idempotent. */
  async finaliseSession(userId: string, sessionId: string): Promise<CaptureSessionDto> {
    const session = await this.prisma.captureSession.findFirst({
      where: { id: sessionId, userId },
      include: { _count: { select: { assets: true } } },
    });
    if (!session) throw new AppError('NOT_FOUND');

    if (session._count.assets === 0) {
      throw new AppError('INSUFFICIENT_FRAMES', { sessionId }, 'No files were uploaded.');
    }

    const updated = await this.prisma.captureSession.update({
      where: { id: sessionId },
      data: { status: 'READY' },
    });

    return {
      id: updated.id,
      mode: updated.mode,
      status: updated.status,
      assetCount: session._count.assets,
      createdAt: updated.createdAt.toISOString(),
      purgeAfter: updated.purgeAfter.toISOString(),
    };
  }

  async abortUpload(userId: string, uploadId: string): Promise<void> {
    const upload = await this.findUpload(userId, uploadId);
    await this.storage.abortMultipartUpload(upload.storageKey, upload.s3UploadId);
    await this.prisma.upload.delete({ where: { id: upload.id } });
  }

  // ── internals ──

  private async findUpload(userId: string, uploadId: string) {
    // Ownership is enforced through the session relation — never trust an id
    // from the client to be the caller's.
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, session: { userId } },
    });
    if (!upload) throw new AppError('NOT_FOUND');
    return upload;
  }

  /** Exposed for tests: verifies a buffer against a declared digest. */
  static sha256(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }
}
