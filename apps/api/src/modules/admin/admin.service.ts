import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  type AdminStatus,
  type CreateGarmentRequest,
  type GeneratedImage,
  type ProductPhotoRequest,
  type ReadSizeChartRequest,
  type ReadSizeChartResponse,
} from '@tailorai/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { loadEnv } from '../../config/env';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48);
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async status(userId: string): Promise<AdminStatus> {
    const env = loadEnv();
    return { isAdmin: await this.isAdmin(userId), geminiEnabled: Boolean(env.GEMINI_API_KEY?.trim()) };
  }

  async assertAdmin(userId: string): Promise<void> {
    if (!(await this.isAdmin(userId))) throw new AppError('FORBIDDEN', undefined, 'Only catalogue admins can add outfits.');
  }

  private async isAdmin(userId: string): Promise<boolean> {
    const env = loadEnv();
    if (env.ADMIN_EMAILS.length === 0) {
      // Open only on a local development stack with dev sign-in.
      return env.NODE_ENV === 'development' && env.AUTH_PROVIDER === 'local';
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const email = user?.email?.toLowerCase();
    return Boolean(email && env.ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(email));
  }

  /** Gemini reads a size-chart image (via the reconstruction service). */
  async readSizeChart(req: ReadSizeChartRequest): Promise<ReadSizeChartResponse> {
    const env = loadEnv();
    let res: Response;
    try {
      res = await fetch(`${env.RECONSTRUCTION_URL.replace(/\/$/, '')}/catalog/read-size-chart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.RECONSTRUCTION_API_KEY },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      this.logger.error(`size-chart read failed: ${String(err)}`);
      throw new AppError('INFERENCE_FAILED', undefined, "We couldn't read that chart right now. Please try again.");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: { code?: string; message?: string } } | null;
      const message = body?.detail?.message ?? "We couldn't read that chart.";
      if (res.status === 503) throw new AppError('GPU_UNAVAILABLE', undefined, message);
      throw new AppError('VALIDATION_FAILED', { code: body?.detail?.code }, message);
    }
    return (await res.json()) as ReadSizeChartResponse;
  }

  /** A product photo from the outfit's details (Gemini), returned for preview. */
  async productPhoto(req: ProductPhotoRequest): Promise<GeneratedImage> {
    const env = loadEnv();
    let res: Response;
    try {
      res = await fetch(`${env.RECONSTRUCTION_URL.replace(/\/$/, '')}/catalog/product-photo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.RECONSTRUCTION_API_KEY },
        body: JSON.stringify({ garment: req }),
        signal: AbortSignal.timeout(270_000),
      });
    } catch (err) {
      this.logger.error(`product photo failed: ${String(err)}`);
      throw new AppError('INFERENCE_FAILED', undefined, "We couldn't create a photo right now. Please try again.");
    }
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { detail?: { message?: string } } | null)?.detail;
      if (res.status === 402) throw new AppError('QUOTA_EXCEEDED', undefined, detail?.message);
      throw new AppError('INFERENCE_FAILED', { status: res.status }, "We couldn't create a photo right now.");
    }
    return (await res.json()) as GeneratedImage;
  }

  /** Brand (existing or new) → size chart → garment, in one transaction. */
  async createGarment(req: CreateGarmentRequest): Promise<{ slug: string }> {
    const sizes = req.sizeChart.sizes.filter((s) => Object.keys(s.measurements).length > 0);
    if (sizes.length === 0) throw new AppError('VALIDATION_FAILED', undefined, 'Add at least one size with a measurement.');
    const labels = sizes.map((s) => s.label.trim());
    if (new Set(labels).size !== labels.length) {
      throw new AppError('VALIDATION_FAILED', undefined, 'Each size label must be different.');
    }

    return this.prisma.$transaction(async (tx) => {
      const brand =
        'slug' in req.brand
          ? await tx.brand.findUnique({ where: { slug: req.brand.slug } })
          : await tx.brand.upsert({
              where: { slug: slugify(req.brand.name) },
              update: {},
              create: {
                slug: slugify(req.brand.name),
                name: req.brand.name.trim(),
                description: req.brand.description ?? null,
                accentHex: req.brand.accentHex,
              },
            });
      if (!brand) throw new AppError('NOT_FOUND', undefined, 'That brand does not exist.');

      let slug = `${brand.slug}-${slugify(req.name)}`.slice(0, 60);
      for (let n = 2; await tx.garment.findUnique({ where: { slug } }); n++) {
        slug = `${brand.slug}-${slugify(req.name)}`.slice(0, 56) + `-${n}`;
      }

      // A generated photo goes to the private bucket (served via the API);
      // a pasted https link is stored as given.
      let imageUrl: string | null = req.imageUrl ?? null;
      if (req.imageBase64) {
        const bytes = Buffer.from(req.imageBase64, 'base64');
        const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        if (!isJpeg && !isPng) throw new AppError('VALIDATION_FAILED', undefined, 'The photo must be a JPEG or PNG.');
        const key = `catalog/${slug}.${isPng ? 'png' : 'jpg'}`;
        await this.storage.putObject(key, bytes, isPng ? 'image/png' : 'image/jpeg');
        imageUrl = `storage:${key}`;
      }

      const chart = await tx.sizeChart.create({
        data: { brandId: brand.id, name: slug, category: req.category },
      });
      await tx.sizeChartEntry.createMany({
        data: sizes.flatMap((s, order) =>
          Object.entries(s.measurements).map(([dimension, [minCm, maxCm]]) => ({
            sizeChartId: chart.id,
            sizeLabel: s.label.trim(),
            sortOrder: order,
            dimension,
            minCm,
            maxCm,
          })),
        ),
      });
      await tx.garment.create({
        data: {
          slug,
          brandId: brand.id,
          sizeChartId: chart.id,
          name: req.name.trim(),
          category: req.category,
          subcategory: req.subcategory.trim(),
          gender: req.gender,
          fitIntent: req.fitIntent,
          stretch: req.stretch,
          material: req.material.trim(),
          description: req.description.trim(),
          priceCents: req.priceCents,
          currency: req.currency.toUpperCase(),
          colorName: req.colorName.trim(),
          colorHex: req.colorHex,
          imageUrl,
          isActive: true,
        },
      });
      this.logger.log(`garment added: ${slug} (${sizes.length} sizes)`);
      return { slug };
    });
  }
}
