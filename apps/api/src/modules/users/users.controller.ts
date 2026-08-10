import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  GrantConsentRequest,
  UpdateProfileRequest,
  type Consent,
  type UserProfile,
} from '@tailorai/contracts';
import { UsersService } from './users.service';
import { zodBody } from '../../common/zod.pipe';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator';

@Controller({ path: 'me', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async me(@CurrentUser() user: AuthedUser): Promise<UserProfile> {
    return this.users.getProfile(user.id);
  }

  @Patch()
  async update(
    @CurrentUser() user: AuthedUser,
    @Body(zodBody(UpdateProfileRequest)) body: UpdateProfileRequest,
  ): Promise<UserProfile> {
    return this.users.updateProfile(user.id, body);
  }

  @Get('consents')
  async consents(@CurrentUser() user: AuthedUser): Promise<Consent[]> {
    return this.users.listConsents(user.id);
  }

  @Post('consents')
  async grantConsent(
    @CurrentUser() user: AuthedUser,
    @Body(zodBody(GrantConsentRequest)) body: GrantConsentRequest,
    @Req() req: Request,
  ): Promise<Consent> {
    return this.users.recordConsent(user.id, body, {
      // Proof of consent, required by BIPA. Stored on the ledger row.
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Get('export')
  async exportData(@CurrentUser() user: AuthedUser): Promise<Record<string, unknown>> {
    return this.users.exportData(user.id);
  }

  @Delete()
  @HttpCode(204)
  async deleteAccount(@CurrentUser() user: AuthedUser): Promise<void> {
    await this.users.deleteAccount(user.id);
  }
}
