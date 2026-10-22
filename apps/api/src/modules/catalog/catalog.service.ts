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
  type RecommendationView,
  type SizeChartView,
} from '@tailorai/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { loadEnv } from '../../config/env';

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
  engineVersion: string;
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(private readonly prisma: PrismaService) {}

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
        signal: AbortSignal.timeout(15_000),
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
      explanation: res.explanation,
      engineVersion: r.engineVersion,
      createdAt: r.createdAt.toISOString(),
      feedback: fb
        ? { outcome: fb.outcome, sizeChosen: fb.sizeChosen, createdAt: fb.createdAt.toISOString() }
        : null,
    };
  }
}
