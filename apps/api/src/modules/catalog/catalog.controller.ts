import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Redirect } from '@nestjs/common';
import {
  FitFeedbackRequest,
  GarmentCategory,
  PhotoTryOnRequest,
  RecommendRequest,
  type GarmentDetail,
  type GeneratedImage,
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

  /** Uploaded product photos live in the private bucket: redirect to a signed URL. */
  @Public()
  @Get('garments/:slug/image')
  @Redirect()
  async image(@Param('slug') slug: string) {
    return { url: await this.catalog.imageRedirect(slug), statusCode: 302 };
  }

  /** The shopper's scan photo wearing this item (Gemini). Consent per request. */
  @Post('garments/:slug/photo-tryon')
  @HttpCode(200)
  async photoTryOn(
    @CurrentUser() user: AuthedUser,
    @Param('slug') slug: string,
    @Body(zodBody(PhotoTryOnRequest)) _body: PhotoTryOnRequest,
  ): Promise<GeneratedImage> {
    return this.catalog.photoTryOn(user.id, slug);
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
