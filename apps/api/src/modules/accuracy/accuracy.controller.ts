import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  TapeCheckRequest,
  type AccuracyReport,
  type TapeCheckView,
} from '@tailorai/contracts';
import { AccuracyService } from './accuracy.service';
import { zodBody } from '../../common/zod.pipe';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator';

@Controller({ version: '1' })
export class AccuracyController {
  constructor(private readonly accuracy: AccuracyService) {}

  /** Tape measurements to compare with the current scan. */
  @Post('me/tape-checks')
  async create(
    @CurrentUser() user: AuthedUser,
    @Body(zodBody(TapeCheckRequest)) body: TapeCheckRequest,
  ): Promise<TapeCheckView> {
    return this.accuracy.create(user.id, body);
  }

  @Get('me/tape-checks')
  async list(@CurrentUser() user: AuthedUser): Promise<TapeCheckView[]> {
    return this.accuracy.list(user.id);
  }

  /** Aggregate scan-vs-tape accuracy across every tester (no personal data). */
  @Get('accuracy/report')
  async report(): Promise<AccuracyReport> {
    return this.accuracy.report();
  }
}
