import { Injectable, Logger } from '@nestjs/common';
import type {
  Brand as BrandRow,
  FitPreference,
  Garment as GarmentRow,
  Recommendation as RecommendationRow,
  FitFeedback as FitFeedbackRow,
  SizeChart as SizeChartRow,
  SizeChartEntry,
} from '@prisma/client';
import {
  AppError,
  type FitFeedbackRequest,
  type GarmentCategory,
  type GarmentDetail,
  type GarmentSummary,
  type GeneratedImage,
  type PhotoTryOnView,
  type RecommendationView,
  type SizeChartView,
} from '@tailorai/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { loadEnv } from '../../config/env';

const STORAGE_PREFIX = 'storage:';

type GarmentWithBrand = GarmentRow & { brand: BrandRow };
type RecommendationWithRefs = RecommendationRow & {
  garment: GarmentWithBrand;
  feedback: FitFeedbackRow[];
};

/** Shape of the fit engine's response (services/reconstruction/app/fit). */
interface FitResult {
  recommendedSize: string;
  fitScore: number;
  fitLabel: string;
  alternativeSize: string | null;
  betweenSizes: boolean;
  confidence: { value: number; label: string };
  dimensions: RecommendationView['dimensions'];
  sizes: RecommendationView['sizes'];
  explanation: string;
  explanationSource?: string;
  noSizeFits?: boolean;
  engineVersion: string;
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // ── Product photos ──

  /** A presigned URL for an uploaded product photo (buckets are private). */
  async imageRedirect(slug: string): Promise<string> {
    const g = await this.prisma.garment.findUnique({ where: { slug }, select: { imageUrl: true } });
    if (!g?.imageUrl?.startsWith(STORAGE_PREFIX)) throw new AppError('NOT_FOUND');
    return (await this.storage.presignGet(g.imageUrl.slice(STORAGE_PREFIX.length), 3600)).url;
  }

  /** Where a server (the reconstruction service) can fetch the photo from. */
  private async fetchableImage(slug: string, imageUrl: string): Promise<string> {
    if (imageUrl.startsWith(STORAGE_PREFIX)) {
      return (await this.storage.presignGet(imageUrl.slice(STORAGE_PREFIX.length), 600)).url;
    }
    if (imageUrl.startsWith('/')) return `${loadEnv().WEB_PUBLIC_URL.replace(/\/$/, '')}${imageUrl}`;
    void slug;
    return imageUrl;
  }

  private async currentCoreForTryOn(userId: string) {
    return this.prisma.bodyCore.findFirst({
      where: { userId, isCurrent: true },
      orderBy: { version: 'desc' },
      select: { id: true, job: { select: { sessionId: true } } },
    });
  }

  private async toPhotoView(row: { storageKey: string; model: string; createdAt: Date }): Promise<PhotoTryOnView> {
    return {
      url: (await this.storage.presignGet(row.storageKey, 3600)).url,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** The saved try-on for this item and the current scan, if one was made. */
  async savedPhotoTryOn(userId: string, slug: string): Promise<PhotoTryOnView> {
    const [garment, core] = await Promise.all([
      this.prisma.garment.findUnique({ where: { slug }, select: { id: true } }),
      this.currentCoreForTryOn(userId),
    ]);
    const row =
      garment && core
        ? await this.prisma.photoTryOn.findUnique({
            where: { userId_garmentId_bodyCoreId: { userId, garmentId: garment.id, bodyCoreId: core.id } },
          })
        : null;
    if (!row) throw new AppError('NOT_FOUND', { slug }, 'No try-on photo yet.');
    return this.toPhotoView(row);
  }

  /**
   * The shopper's own front scan photo, wearing this garment (Gemini image
   * model). Made once per item and scan, saved to the shopper's storage
   * (erased with the account), and returned again on later requests instead
   * of being regenerated. Explicit consent per request. A style preview only —
   * fit and size come from the fit engine.
   */
  async photoTryOn(userId: string, slug: string): Promise<PhotoTryOnView> {
    const env = loadEnv();
    const garment = await this.prisma.garment.findUnique({ where: { slug } });
    if (!garment?.isActive) throw new AppError('NOT_FOUND', { slug }, "We couldn't find that item.");
    if (!garment.imageUrl) throw new AppError('NOT_FOUND', { slug }, 'This item has no product photo to try on yet.');

    const core = await this.currentCoreForTryOn(userId);
    if (core) {
      const saved = await this.prisma.photoTryOn.findUnique({
        where: { userId_garmentId_bodyCoreId: { userId, garmentId: garment.id, bodyCoreId: core.id } },
      });
      if (saved) return this.toPhotoView(saved);
    }
    if (!env.GEMINI_API_KEY?.trim()) {
      throw new AppError('GPU_UNAVAILABLE', undefined, 'Photo try-on needs GEMINI_API_KEY.');
    }
    const front = core?.job
      ? await this.prisma.asset.findFirst({
          where: { sessionId: core.job.sessionId, kind: 'RAW_PHOTO', metadata: { path: ['view'], equals: 'front' } },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    if (!front || (front.expiresAt && front.expiresAt < new Date())) {
      throw new AppError('NOT_FOUND', { userId }, 'Your scan photos are no longer stored — rescan to use photo try-on.');
    }

    const body = {
      personImageUrl: (await this.storage.presignGet(front.storageKey, 600)).url,
      garmentImageUrl: await this.fetchableImage(slug, garment.imageUrl),
      garment: {
        name: garment.name,
        subcategory: garment.subcategory,
        gender: garment.gender,
        fitIntent: garment.fitIntent,
        material: garment.material,
        description: garment.description,
        colorName: garment.colorName,
        colorHex: garment.colorHex,
      },
    };
    let res: Response;
    try {
      res = await fetch(`${env.RECONSTRUCTION_URL.replace(/\/$/, '')}/tryon/photo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.RECONSTRUCTION_API_KEY },
        body: JSON.stringify(body),
        // Up to three image attempts (~15 s each, 120 s cap) in the reconstruction service.
        signal: AbortSignal.timeout(270_000),
      });
    } catch (err) {
      this.logger.error(`photo try-on failed: ${String(err)}`);
      throw new AppError('INFERENCE_FAILED', undefined, "We couldn't create your try-on photo right now. Please try again.");
    }
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { detail?: { message?: string } } | null)?.detail;
      this.logger.error(`photo try-on failed: ${res.status} ${detail?.message ?? ''}`);
      // Out of Gemini credits: retrying won't help, so say what will.
      if (res.status === 402) throw new AppError('QUOTA_EXCEEDED', undefined, detail?.message);
      throw new AppError('INFERENCE_FAILED', undefined, "We couldn't create your try-on photo right now. Please try again.");
    }
    const image = (await res.json()) as GeneratedImage;

    // Keep it: the next visit shows this one instead of asking Gemini again.
    const ext = image.mimeType === 'image/png' ? 'png' : 'jpg';
    const storageKey = `users/${userId}/tryon/${garment.slug}-${core!.id}.${ext}`;
    await this.storage.putObject(storageKey, Buffer.from(image.imageBase64, 'base64'), image.mimeType);
    const row = await this.prisma.photoTryOn.upsert({
      where: { userId_garmentId_bodyCoreId: { userId, garmentId: garment.id, bodyCoreId: core!.id } },
      update: { storageKey, mimeType: image.mimeType, model: image.model },
      create: {
        userId,
        garmentId: garment.id,
        bodyCoreId: core!.id,
        storageKey,
        mimeType: image.mimeType,
        model: image.model,
      },
    });
    return this.toPhotoView(row);
  }

  // ── Catalogue ──

  async listGarments(filter: {
    category?: GarmentCategory;
    gender?: string;
    brand?: string;
  }): Promise<GarmentSummary[]> {
    const rows = await this.prisma.garment.findMany({
      where: {
        isActive: true,
        ...(filter.category ? { category: filter.category } : {}),
        // "unisex" items show under either gender filter.
        ...(filter.gender ? { gender: { in: [filter.gender, 'unisex'] } } : {}),
        ...(filter.brand ? { brand: { slug: filter.brand } } : {}),
      },
      include: { brand: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return rows.map((g) => this.toSummary(g));
  }

  async listBrands() {
    const rows = await this.prisma.brand.findMany({ orderBy: { name: 'asc' } });
    return rows.map((b) => this.toBrand(b));
  }

  async getGarment(slug: string): Promise<GarmentDetail> {
    const g = await this.prisma.garment.findUnique({
      where: { slug },
      include: { brand: true, sizeChart: { include: { entries: true } } },
    });
    if (!g || !g.isActive) throw new AppError('NOT_FOUND', { slug }, "We couldn't find that item.");
    return {
      ...this.toSummary(g),
      description: g.description,
      sizeChart: this.toChart(g.sizeChart),
    };
  }

  // ── Find My Size ──

  async recommend(
    userId: string,
    slug: string,
    preferenceOverride?: FitPreference,
  ): Promise<RecommendationView> {
    const [user, core, garment] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.prisma.bodyCore.findFirst({
        where: { userId, isCurrent: true },
        orderBy: { version: 'desc' },
        include: { measurements: true },
      }),
      this.prisma.garment.findUnique({
        where: { slug },
        include: { brand: true, sizeChart: { include: { entries: true } } },
      }),
    ]);
    if (!garment || !garment.isActive) throw new AppError('NOT_FOUND', { slug }, "We couldn't find that item.");
    if (!core || core.measurements.length === 0) {
      throw new AppError(
        'NOT_FOUND',
        { userId },
        'Scan your body first — your size is worked out from your Body Profile.',
      );
    }

    const preference = preferenceOverride ?? user.fitPreference;
    const chart = this.toChart(garment.sizeChart);
    const body = Object.fromEntries(
      core.measurements.map((m) => [m.name, { value: m.valueCm, confidence: m.confidence }]),
    );

    const result = await this.callFitEngine({
      body,
      garment: {
        category: garment.category.toLowerCase(),
        subcategory: garment.subcategory,
        fitIntent: garment.fitIntent.toLowerCase(),
        stretch: garment.stretch.toLowerCase(),
      },
      sizeChart: chart.sizes,
      preference: preference.toLowerCase(),
    });

    const row = await this.prisma.recommendation.create({
      data: {
        userId,
        garmentId: garment.id,
        bodyCoreId: core.id,
        recommendedSize: result.recommendedSize,
        alternativeSize: result.alternativeSize,
        fitScore: result.fitScore,
        confidence: result.confidence.value,
        betweenSizes: result.betweenSizes,
        preference,
        result: result as unknown as object,
        engineVersion: result.engineVersion,
      },
      include: { garment: { include: { brand: true } }, feedback: true },
    });
    return this.toRecommendation(row);
  }

  async listRecommendations(userId: string): Promise<RecommendationView[]> {
    const rows = await this.prisma.recommendation.findMany({
      where: { userId },
      include: { garment: { include: { brand: true } }, feedback: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // Latest recommendation per garment — re-running Find My Size replaces it.
    const seen = new Set<string>();
    return rows
      .filter((r) => (seen.has(r.garmentId) ? false : (seen.add(r.garmentId), true)))
      .map((r) => this.toRecommendation(r));
  }

  async addFeedback(userId: string, recommendationId: string, req: FitFeedbackRequest) {
    const rec = await this.prisma.recommendation.findFirst({ where: { id: recommendationId, userId } });
    if (!rec) throw new AppError('NOT_FOUND');
    await this.prisma.fitFeedback.create({
      data: {
        userId,
        recommendationId: rec.id,
        garmentId: rec.garmentId,
        sizeChosen: req.sizeChosen,
        outcome: req.outcome,
        comment: req.comment ?? null,
      },
    });
    return { ok: true };
  }

  // ── helpers ──

  private async callFitEngine(payload: unknown): Promise<FitResult> {
    const env = loadEnv();
    try {
      const res = await fetch(`${env.RECONSTRUCTION_URL.replace(/\/$/, '')}/fit/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.RECONSTRUCTION_API_KEY },
        body: JSON.stringify(payload),
        // Room for the optional Gemini explanation (≤12 s) on top of the engine.
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`fit ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as FitResult;
    } catch (err) {
      this.logger.error(`fit engine failed: ${String(err)}`);
      throw new AppError('INFERENCE_FAILED', undefined, "We couldn't work out your size right now. Please try again.");
    }
  }

  private toBrand(b: BrandRow) {
    return { id: b.id, slug: b.slug, name: b.name, description: b.description, accentHex: b.accentHex };
  }

  private toSummary(g: GarmentWithBrand): GarmentSummary {
    return {
      id: g.id,
      slug: g.slug,
      name: g.name,
      brand: this.toBrand(g.brand),
      category: g.category,
      subcategory: g.subcategory,
      gender: g.gender,
      fitIntent: g.fitIntent,
      stretch: g.stretch,
      material: g.material,
      priceCents: g.priceCents,
      currency: g.currency,
      colorName: g.colorName,
      colorHex: g.colorHex,
      imageUrl: !g.imageUrl
        ? null
        : g.imageUrl.startsWith(STORAGE_PREFIX)
          ? `${loadEnv().API_PUBLIC_URL.replace(/\/$/, '')}/v1/garments/${g.slug}/image`
          : g.imageUrl,
    };
  }

  private toChart(chart: SizeChartRow & { entries: SizeChartEntry[] }): SizeChartView {
    const bySize = new Map<string, { order: number; m: Record<string, [number, number]> }>();
    const dims: string[] = [];
    for (const e of chart.entries) {
      if (!dims.includes(e.dimension)) dims.push(e.dimension);
      const s = bySize.get(e.sizeLabel) ?? { order: e.sortOrder, m: {} };
      s.m[e.dimension] = [e.minCm, e.maxCm];
      bySize.set(e.sizeLabel, s);
    }
    const ORDER = ['chest', 'waist', 'hip', 'shoulder_width', 'neck', 'arm_length', 'inseam', 'thigh'];
    dims.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return {
      name: chart.name,
      dimensions: dims,
      sizes: [...bySize.entries()]
        .sort((a, b) => a[1].order - b[1].order)
        .map(([label, s]) => ({ label, measurements: s.m })),
    };
  }

  private toRecommendation(r: RecommendationWithRefs): RecommendationView {
    const res = r.result as unknown as FitResult;
    const fb = r.feedback[0];
    return {
      id: r.id,
      garment: this.toSummary(r.garment),
      bodyCoreId: r.bodyCoreId,
      recommendedSize: r.recommendedSize,
      alternativeSize: r.alternativeSize,
      fitScore: r.fitScore,
      fitLabel: res.fitLabel,
      betweenSizes: r.betweenSizes,
      confidence: res.confidence,
      preference: r.preference,
      dimensions: res.dimensions,
      sizes: res.sizes,
      noSizeFits: res.noSizeFits ?? false,
      explanation: res.explanation,
      explanationSource: res.explanationSource ?? 'rules',
      engineVersion: r.engineVersion,
      createdAt: r.createdAt.toISOString(),
      feedback: fb
        ? { outcome: fb.outcome, sizeChosen: fb.sizeChosen, createdAt: fb.createdAt.toISOString() }
        : null,
    };
  }
}
