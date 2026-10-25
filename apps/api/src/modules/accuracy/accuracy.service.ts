import { Injectable } from '@nestjs/common';
import {
  AppError,
  type AccuracyReport,
  type TapeCheckRequest,
  type TapeCheckView,
  type TapeComparison,
} from '@tailorai/contracts';
import type { BodyCore, BodyMeasurement, TapeCheck } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const LABELS: Record<string, string> = {
  chest: 'Chest', waist: 'Waist', hip: 'Hip', shoulder_width: 'Shoulder width', inseam: 'Inseam',
  thigh: 'Thigh', arm_length: 'Arm length', neck: 'Neck', torso_length: 'Torso length', calf: 'Calf',
};
const ORDER = Object.keys(LABELS);

/**
 * Agreement we aim for between scan and tape. Two people measuring the same
 * body with a tape typically differ by 1–3 cm on girths and 1–2 cm on
 * lengths, so a scan inside these bounds is as good as a second tape.
 */
const TARGET_CM: Record<string, number> = {
  chest: 3, waist: 3, hip: 3, thigh: 3, calf: 2, neck: 2,
  shoulder_width: 2, inseam: 2, arm_length: 2, torso_length: 3,
};

type CoreWithMeasurements = BodyCore & { measurements: BodyMeasurement[] };

@Injectable()
export class AccuracyService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, req: TapeCheckRequest): Promise<TapeCheckView> {
    const core = await this.currentCore(userId);
    const values = Object.fromEntries(Object.entries(req.values).filter(([k]) => k in LABELS));
    if (Object.keys(values).length === 0) {
      throw new AppError('VALIDATION_FAILED', undefined, 'Enter at least one tape measurement.');
    }
    const row = await this.prisma.tapeCheck.create({
      data: { userId, bodyCoreId: core.id, values, note: req.note ?? null },
    });
    return this.toView(row, core);
  }

  async list(userId: string): Promise<TapeCheckView[]> {
    const rows = await this.prisma.tapeCheck.findMany({
      where: { userId },
      include: { bodyCore: { include: { measurements: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map((r) => this.toView(r, r.bodyCore));
  }

  /**
   * Accuracy across everyone who has checked: each person's latest check,
   * scan vs tape per measurement. This is the study table — it replaces the
   * benchmark estimates with errors measured on real users.
   */
  async report(): Promise<AccuracyReport> {
    const rows = await this.prisma.tapeCheck.findMany({
      include: { bodyCore: { include: { measurements: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.userId)) latest.set(r.userId, r);

    const errors = new Map<string, number[]>();
    for (const r of latest.values()) {
      for (const c of this.compare(r.values as Record<string, number>, r.bodyCore)) {
        errors.set(c.name, [...(errors.get(c.name) ?? []), c.errorCm]);
      }
    }
    const pct = (xs: number[], lim: number) => Math.round((100 * xs.filter((e) => Math.abs(e) <= lim).length) / xs.length);
    const round1 = (x: number) => Math.round(x * 10) / 10;

    const feedback = await this.prisma.fitFeedback.groupBy({ by: ['outcome'], _count: { _all: true } });
    const total = feedback.reduce((s, f) => s + f._count._all, 0);
    const perfect = feedback.find((f) => f.outcome === 'PERFECT')?._count._all ?? 0;

    return {
      people: latest.size,
      checks: rows.length,
      rows: ORDER.filter((n) => errors.has(n)).map((name) => {
        const xs = errors.get(name)!;
        return {
          name,
          label: LABELS[name]!,
          n: xs.length,
          maeCm: round1(xs.reduce((s, e) => s + Math.abs(e), 0) / xs.length),
          biasCm: round1(xs.reduce((s, e) => s + e, 0) / xs.length),
          within2Pct: pct(xs, 2),
          within4Pct: pct(xs, 4),
          targetCm: TARGET_CM[name] ?? 3,
        };
      }),
      sizeFeedback: { total, perfectPct: total ? Math.round((100 * perfect) / total) : null },
    };
  }

  // ── helpers ──

  private async currentCore(userId: string): Promise<CoreWithMeasurements> {
    const core = await this.prisma.bodyCore.findFirst({
      where: { userId, isCurrent: true },
      orderBy: { version: 'desc' },
      include: { measurements: true },
    });
    if (!core || core.measurements.length === 0) {
      throw new AppError('NOT_FOUND', { userId }, 'Scan your body first — then compare it with a tape measure.');
    }
    return core;
  }

  private compare(values: Record<string, number>, core: CoreWithMeasurements): TapeComparison[] {
    const scan = new Map(core.measurements.map((m) => [m.name, m]));
    return ORDER.filter((n) => typeof values[n] === 'number' && scan.has(n)).map((name) => {
      const m = scan.get(name)!;
      const tape = values[name]!;
      const error = Math.round((m.valueCm - tape) * 10) / 10;
      const target = TARGET_CM[name] ?? 3;
      return {
        name,
        label: LABELS[name]!,
        scanCm: Math.round(m.valueCm * 10) / 10,
        tapeCm: tape,
        errorCm: error,
        targetCm: target,
        withinTarget: Math.abs(error) <= target,
        typicalErrorCm: m.typicalErrorCm,
      };
    });
  }

  private toView(row: TapeCheck, core: CoreWithMeasurements): TapeCheckView {
    const rows = this.compare(row.values as Record<string, number>, core);
    return {
      id: row.id,
      bodyCoreId: core.id,
      bodyVersion: core.version,
      note: row.note,
      rows,
      meanAbsErrorCm: rows.length
        ? Math.round((10 * rows.reduce((s, r) => s + Math.abs(r.errorCm), 0)) / rows.length) / 10
        : null,
      withinTargetPct: rows.length ? Math.round((100 * rows.filter((r) => r.withinTarget).length) / rows.length) : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
