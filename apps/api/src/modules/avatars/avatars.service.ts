import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  SUPPORTED_EXPORT_FORMATS,
  type AvatarRender as AvatarRenderDto,
  type BodyCore as BodyCoreDto,
  type Coverage,
  type ExportFormat,
  type ExportRecord,
  type MeasurementsResponse,
} from '@tailorai/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { loadEnv } from '../../config/env';

const CANONICAL_HEIGHT_CM = 175.0;

/** Display order of the four-view scan's measurements (scan engine order). */
const MEASUREMENT_ORDER = [
  'height', 'chest', 'waist', 'hip', 'shoulder_width', 'inseam',
  'thigh', 'arm_length', 'neck', 'torso_length', 'calf',
];
const MEASUREMENT_LABELS: Record<string, string> = {
  height: 'Height', chest: 'Chest', waist: 'Waist', hip: 'Hip',
  shoulder_width: 'Shoulder width', inseam: 'Inseam', thigh: 'Thigh',
  arm_length: 'Arm length', neck: 'Neck', torso_length: 'Torso length', calf: 'Calf',
};

@Injectable()
export class AvatarsService {
  private readonly logger = new Logger(AvatarsService.name);
  private readonly helpersCache = new Map<string, { count: number; positions: string; bodyCoreId: string }>();

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

  /**
   * The 14 anthropometric measurements for the user's current body profile.
   *
   * Derived, not stored — like the avatar render. The BodyCore's shape vector
   * is the source of truth; measurements are recomputed from it by the
   * reconstruction service so they always reflect the latest extractor. Every
   * value ships with `estimated` + `confidence`: a measurement is never
   * presented as an authoritative number stripped of its uncertainty.
   */
  async getMeasurements(userId: string): Promise<MeasurementsResponse> {
    const core = await this.prisma.bodyCore.findFirst({
      where: { userId, isCurrent: true },
      orderBy: { version: 'desc' },
      include: { measurements: true },
    });
    if (!core) throw new AppError('NOT_FOUND', undefined, "You don't have a body profile yet.");

    // Four-view scans store measured values (with per-measurement confidence)
    // at scan time. Those are the user's numbers; serve them as recorded.
    if (core.measurements.length > 0) {
      const order = MEASUREMENT_ORDER;
      const rows = [...core.measurements].sort(
        (a, b) => order.indexOf(a.name) - order.indexOf(b.name),
      );
      return {
        bodyCoreId: core.id,
        estimated: true,
        confidence: core.overallQuality,
        scaleSource: core.scaleSource,
        heightCm: core.heightCm,
        measurements: Object.fromEntries(rows.map((m) => [m.name, m.valueCm])),
        regions: Object.fromEntries(
          rows.map((m) => {
            const r = (m.region ?? {}) as Record<string, unknown>;
            return [
              m.name,
              {
                value: m.valueCm,
                unit: 'cm' as const,
                kind: (r.kind as 'girth' | 'width' | 'length') ?? 'length',
                y: (r.y as number | undefined) ?? null,
                y0: (r.y0 as number | undefined) ?? null,
                y1: (r.y1 as number | undefined) ?? null,
                side: (r.side as 'torso' | 'arm' | 'leg' | 'full') ?? 'torso',
              },
            ];
          }),
        ),
        details: rows.map((m) => ({
          name: m.name,
          label: MEASUREMENT_LABELS[m.name] ?? m.name,
          value: m.valueCm,
          unit: 'cm' as const,
          confidence: m.confidence,
          method: m.method,
          sources: m.sources,
          kind: ((m.region as { kind?: string } | null)?.kind ?? 'length') as 'girth' | 'width' | 'length',
          region: (m.region ?? {}) as Record<string, unknown>,
          typicalErrorCm: m.typicalErrorCm,
        })),
        engineVersion: rows[0]?.engineVersion ?? null,
      };
    }

    const env = loadEnv();
    const metricScale =
      core.metricScale && core.metricScale > 0
        ? core.metricScale
        : (core.heightCm ?? CANONICAL_HEIGHT_CM) / CANONICAL_HEIGHT_CM;

    let derived: { measurements: Record<string, number | null>; regions: Record<string, unknown> };
    try {
      const res = await fetch(`${env.RECONSTRUCTION_URL.replace(/\/$/, '')}/measure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.RECONSTRUCTION_API_KEY },
        body: JSON.stringify({ shape: core.shapeParams, metricScale }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`measure ${res.status}`);
      derived = (await res.json()) as typeof derived;
    } catch (err) {
      this.logger.error(`measurement derivation failed: ${String(err)}`);
      throw new AppError('INFERENCE_FAILED', { userId }, "We couldn't work out your measurements.");
    }

    return {
      bodyCoreId: core.id,
      // Always estimated until real geometry (SAM 3D Body / MHR) is wired in.
      estimated: true,
      confidence: core.overallQuality,
      scaleSource: core.scaleSource,
      heightCm: core.heightCm,
      measurements: derived.measurements,
      regions: derived.regions as MeasurementsResponse['regions'],
    };
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

  /**
   * MakeHuman's helper layers (tights, skirt) for the body in the user's latest
   * avatar, in the avatar GLB's frame. The shop's 3D garments are MakeHuman
   * clothes, and most hang off these layers rather than the skin; with them the
   * browser wraps a garment onto this exact body. Derived from the same shape
   * vector and scale as the GLB, cached per body profile.
   */
  async getBodyHelpers(userId: string): Promise<{ count: number; positions: string; bodyCoreId: string }> {
    const render = await this.prisma.avatarRender.findFirst({
      where: { bodyCore: { userId } },
      orderBy: { createdAt: 'desc' },
      include: { bodyCore: true },
    });
    if (!render) throw new AppError('NOT_FOUND', undefined, "You don't have an avatar yet.");
    const core = render.bodyCore;
    const hit = this.helpersCache.get(core.id);
    if (hit) return hit;
    const env = loadEnv();
    const metricScale =
      core.metricScale && core.metricScale > 0
        ? core.metricScale
        : (core.heightCm ?? CANONICAL_HEIGHT_CM) / CANONICAL_HEIGHT_CM;
    try {
      const res = await fetch(`${env.RECONSTRUCTION_URL.replace(/\/$/, '')}/body/helpers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.RECONSTRUCTION_API_KEY },
        body: JSON.stringify({ shape: core.shapeParams, metricScale }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`helpers ${res.status}`);
      const data = (await res.json()) as { count: number; positions: string };
      const out = { ...data, bodyCoreId: core.id };
      if (this.helpersCache.size > 200) this.helpersCache.clear();
      this.helpersCache.set(core.id, out);
      return out;
    } catch (err) {
      this.logger.error(`body helpers failed: ${String(err)}`);
      throw new AppError('INFERENCE_FAILED', { userId }, "We couldn't prepare your body for the 3D fitting room.");
    }
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
