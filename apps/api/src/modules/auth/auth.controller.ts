import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { RefreshRequest, SessionRequest, type SessionResponse } from '@tailorai/contracts';
import { AuthService } from './auth.service';
import { zodBody } from '../../common/zod.pipe';
import { Public } from '../../common/auth.guard';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('session')
  @HttpCode(200)
  async session(
    @Body(zodBody(SessionRequest)) body: SessionRequest,
  ): Promise<SessionResponse> {
    return this.auth.createSession(body.token);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(zodBody(RefreshRequest)) body: RefreshRequest,
  ): Promise<SessionResponse> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() user: AuthedUser,
    @Body() body: { refreshToken?: string },
  ): Promise<void> {
    await this.auth.logout(user.id, body?.refreshToken);
  }
}
