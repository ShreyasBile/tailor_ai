import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  CreateExportRequest,
  type AvatarRender,
  type BodyCore,
  type ExportRecord,
  type MeasurementsResponse,
} from '@tailorai/contracts';
import { AvatarsService } from './avatars.service';
import { zodBody } from '../../common/zod.pipe';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator';

@Controller({ version: '1' })
export class AvatarsController {
  constructor(private readonly avatars: AvatarsService) {}

  // ── The permanent profile ──

  @Get('me/body-core')
  async currentCore(
    @CurrentUser() user: AuthedUser,
    @Query('include') include?: string,
  ): Promise<BodyCore> {
    return this.avatars.getCurrentCore(user.id, include === 'params');
  }

  @Get('me/body-core/history')
  async coreHistory(@CurrentUser() user: AuthedUser): Promise<BodyCore[]> {
    return this.avatars.getCoreHistory(user.id);
  }

  @Get('me/measurements')
  async measurements(@CurrentUser() user: AuthedUser): Promise<MeasurementsResponse> {
    return this.avatars.getMeasurements(user.id);
  }

  // ── Renders ──

  @Get('me/avatar')
  async latest(@CurrentUser() user: AuthedUser): Promise<AvatarRender> {
    return this.avatars.getLatestRender(user.id);
  }

  /** MakeHuman helper layers for the latest avatar (3D fitting room). */
  @Get('me/avatar/helpers')
  async helpers(@CurrentUser() user: AuthedUser): Promise<{ count: number; positions: string; bodyCoreId: string }> {
    return this.avatars.getBodyHelpers(user.id);
  }

  @Get('avatars/:id')
  async getRender(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AvatarRender> {
    return this.avatars.getRender(user.id, id);
  }

  @Post('avatars/:id/exports')
  async createExport(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(CreateExportRequest)) body: CreateExportRequest,
  ): Promise<ExportRecord> {
    return this.avatars.createExport(user.id, id, body.format);
  }

  @Get('exports/:id')
  async getExport(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ExportRecord> {
    return this.avatars.getExport(user.id, id);
  }
}
