import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  SUPPORTED_EXPORT_FORMATS,
  type AvatarRender as AvatarRenderDto,
  type BodyCore as BodyCoreDto,
  type Coverage,
  type ExportFormat,
  type ExportRecord,
} from '@tailorai/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class AvatarsService {
  private readonly logger = new Logger(AvatarsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // ── Body Core (the permanent profile) ──

  /**
   * `includeParams` gates the raw shape coefficients.
   *
   * They are the most sensitive field we hold and the app never needs them to
   * render — only export and portability flows do. Default-off means an
   * accidental log or cache of a normal response cannot leak them.
   */
  async getCurrentCore(userId: string, includeParams = false): Promise<BodyCoreDto> {
    const core = await this.prisma.bodyCore.findFirst({
      where: { userId, isCurrent: true },
      orderBy: { version: 'desc' },
    });
    if (!core) throw new AppError('NOT_FOUND', undefined, "You don't have a body profile yet.");
    return this.toCoreDto(core, includeParams);
  }

  async getCoreHistory(userId: string): Promise<BodyCoreDto[]> {
    const cores = await this.prisma.bodyCore.findMany({
      where: { userId },
      orderBy: { version: 'desc' },
    });
    return cores.map((c) => this.toCoreDto(c, false));
  }

  // ── Renders ──

  async getRender(userId: string, renderId: string): Promise<AvatarRenderDto> {
    const render = await this.prisma.avatarRender.findFirst({
      where: { id: renderId, bodyCore: { userId } },
    });
    if (!render) throw new AppError('NOT_FOUND');

    const [glb, thumbnail] = await Promise.all([
      this.signAsset(render.glbAssetId),
      this.signAsset(render.thumbnailAssetId),
    ]);

    const glbSize = render.glbAssetId
      ? await this.prisma.asset.findUnique({
          where: { id: render.glbAssetId },
          select: { sizeBytes: true },
        })
      : null;

    return {
      id: render.id,
      bodyCoreId: render.bodyCoreId,
      rendererVersion: render.rendererVersion,
      stats: {
        vertexCount: render.vertexCount,
        triangleCount: render.triangleCount,
        textureRes: render.textureRes,
        fileSizeBytes: Number(glbSize?.sizeBytes ?? 0),
      },
      isTextured: render.isTextured,
      isDegraded: render.isDegraded,
      coverage: (render.coverage as Coverage | null) ?? null,
      createdAt: render.createdAt.toISOString(),
      assets: { glb, thumbnail },
    };
  }

  async getLatestRender(userId: string): Promise<AvatarRenderDto> {
    const render = await this.prisma.avatarRender.findFirst({
      where: { bodyCore: { userId } },
      orderBy: { createdAt: 'desc' },
    });
    if (!render) throw new AppError('NOT_FOUND', undefined, "You don't have an avatar yet.");
    return this.getRender(userId, render.id);
  }

  // ── Exports ──

  async createExport(
    userId: string,
    renderId: string,
    format: ExportFormat,
  ): Promise<ExportRecord> {
    if (!SUPPORTED_EXPORT_FORMATS.includes(format)) {
      throw new AppError(
        'VALIDATION_FAILED',
        { format },
        `${format} export isn't available yet. Use GLB or OBJ.`,
      );
    }

    const render = await this.prisma.avatarRender.findFirst({
      where: { id: renderId, bodyCore: { userId } },
    });
    if (!render) throw new AppError('NOT_FOUND');

    // GLB already exists from the pipeline — reuse rather than regenerate.
    const existing = await this.prisma.export.findFirst({
      where: { renderId, format },
      include: { asset: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return this.toExportDto(existing, await this.signAsset(existing.assetId));

    if (format === 'GLB') {
      if (!render.glbAssetId) throw new AppError('EXPORT_FAILED', { renderId });
      const asset = await this.prisma.asset.findUnique({ where: { id: render.glbAssetId } });
      if (!asset) throw new AppError('EXPORT_FAILED', { renderId });

      const created = await this.prisma.export.create({
        data: {
          renderId,
          format,
          assetId: asset.id,
          sizeBytes: asset.sizeBytes,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        },
      });
      return this.toExportDto(created, await this.signAsset(asset.id));
    }

    // OBJ_ZIP is produced by the pipeline's S12 stage. If it isn't present the
    // job predates the format or the stage degraded — say so rather than
    // silently returning the GLB under a different name.
    throw new AppError(
      'EXPORT_FAILED',
      { renderId, format },
      "That format isn't available for this avatar. Try re-running a scan.",
    );
  }

  async getExport(userId: string, exportId: string): Promise<ExportRecord> {
    const record = await this.prisma.export.findFirst({
      where: { id: exportId, render: { bodyCore: { userId } } },
    });
    if (!record) throw new AppError('NOT_FOUND');

    await this.prisma.export.update({
      where: { id: exportId },
      data: { downloadCount: { increment: 1 } },
    });

    return this.toExportDto(record, await this.signAsset(record.assetId));
  }

  // ── mapping ──

  private async signAsset(
    assetId: string | null,
  ): Promise<{ url: string; expiresAt: string } | null> {
    if (!assetId) return null;
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) return null;
    // Short-lived presigned GET. No bucket is ever public.
    return this.storage.presignGet(asset.storageKey);
  }

  private toCoreDto(
    core: {
      id: string;
      version: number;
      isCurrent: boolean;
      bodyModel: 'MHR' | 'ANNY';
      bodyModelVersion: string;
      scaleSource: BodyCoreDto['scale']['source'];
      heightCm: number | null;
      scaleConfidence: number | null;
      frameCount: number;
      captureMode: BodyCoreDto['quality']['captureMode'];
      overallQuality: number | null;
      createdAt: Date;
      shapeParams: number[];
      shapeConfidence: number[];
    },
    includeParams: boolean,
  ): BodyCoreDto {
    return {
      id: core.id,
      version: core.version,
      isCurrent: core.isCurrent,
      bodyModel: core.bodyModel,
      bodyModelVersion: core.bodyModelVersion,
      scale: {
        source: core.scaleSource,
        heightCm: core.heightCm,
        confidence: core.scaleConfidence,
      },
      quality: {
        overall: core.overallQuality,
        frameCount: core.frameCount,
        captureMode: core.captureMode,
      },
      createdAt: core.createdAt.toISOString(),
      ...(includeParams
        ? { shapeParams: core.shapeParams, shapeConfidence: core.shapeConfidence }
        : {}),
    };
  }

  private toExportDto(
    record: {
      id: string;
      renderId: string;
      format: ExportFormat;
      sizeBytes: bigint;
      createdAt: Date;
      expiresAt: Date | null;
    },
    download: { url: string; expiresAt: string } | null,
  ): ExportRecord {
    return {
      id: record.id,
      renderId: record.renderId,
      format: record.format,
      sizeBytes: Number(record.sizeBytes),
      download,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt?.toISOString() ?? null,
    };
  }
}
