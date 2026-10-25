import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateGarmentRequest,
  ProductPhotoRequest,
  ReadSizeChartRequest,
  type AdminStatus,
  type GeneratedImage,
  type ReadSizeChartResponse,
} from '@tailorai/contracts';
import { AdminService } from './admin.service';
import { zodBody } from '../../common/zod.pipe';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator';

@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('status')
  async status(@CurrentUser() user: AuthedUser): Promise<AdminStatus> {
    return this.admin.status(user.id);
  }

  // Reading creates nothing: 200, not Nest's POST default of 201.
  @Post('size-chart/read')
  @HttpCode(200)
  async readSizeChart(
    @CurrentUser() user: AuthedUser,
    @Body(zodBody(ReadSizeChartRequest)) body: ReadSizeChartRequest,
  ): Promise<ReadSizeChartResponse> {
    await this.admin.assertAdmin(user.id);
    return this.admin.readSizeChart(body);
  }

  @Post('product-photo')
  @HttpCode(200)
  async productPhoto(
    @CurrentUser() user: AuthedUser,
    @Body(zodBody(ProductPhotoRequest)) body: ProductPhotoRequest,
  ): Promise<GeneratedImage> {
    await this.admin.assertAdmin(user.id);
    return this.admin.productPhoto(body);
  }

  @Post('garments')
  async createGarment(
    @CurrentUser() user: AuthedUser,
    @Body(zodBody(CreateGarmentRequest)) body: CreateGarmentRequest,
  ): Promise<{ slug: string }> {
    await this.admin.assertAdmin(user.id);
    return this.admin.createGarment(body);
  }
}
