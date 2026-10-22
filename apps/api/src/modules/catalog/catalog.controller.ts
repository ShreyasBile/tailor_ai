import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  FitFeedbackRequest,
  GarmentCategory,
  RecommendRequest,
  type GarmentDetail,
  type GarmentSummary,
  type RecommendationView,
} from '@tailorai/contracts';
import { CatalogService } from './catalog.service';
import { zodBody } from '../../common/zod.pipe';
import { Public } from '../../common/auth.guard';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator';

@Controller({ version: '1' })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ── Catalogue (public: browsing needs no account) ──

  @Public()
  @Get('garments')
  async garments(
    @Query('category') category?: string,
    @Query('gender') gender?: string,
    @Query('brand') brand?: string,
  ): Promise<GarmentSummary[]> {
    const cat = GarmentCategory.safeParse(category?.toUpperCase());
    return this.catalog.listGarments({
      category: cat.success ? cat.data : undefined,
      gender: gender || undefined,
      brand: brand || undefined,
    });
  }

  @Public()
  @Get('garments/:slug')
  async garment(@Param('slug') slug: string): Promise<GarmentDetail> {
    return this.catalog.getGarment(slug);
  }

  @Public()
  @Get('brands')
  async brands() {
    return this.catalog.listBrands();
  }

  // ── Find My Size ──

  @Post('garments/:slug/recommend')
  async recommend(
    @CurrentUser() user: AuthedUser,
    @Param('slug') slug: string,
    @Body(zodBody(RecommendRequest)) body: RecommendRequest,
  ): Promise<RecommendationView> {
    return this.catalog.recommend(user.id, slug, body.preference);
  }

  @Get('me/recommendations')
  async recommendations(@CurrentUser() user: AuthedUser): Promise<RecommendationView[]> {
    return this.catalog.listRecommendations(user.id);
  }

  @Post('recommendations/:id/feedback')
  async feedback(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(FitFeedbackRequest)) body: FitFeedbackRequest,
  ) {
    return this.catalog.addFeedback(user.id, id, body);
  }
}
