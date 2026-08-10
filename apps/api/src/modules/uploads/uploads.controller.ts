import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  CompleteUploadRequest,
  CreateSessionRequest,
  CreateUploadRequest,
  type CaptureSession,
  type CreateUploadResponse,
  type UploadStatus,
} from '@tailorai/contracts';
import { UploadsService } from './uploads.service';
import { zodBody } from '../../common/zod.pipe';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator';

@Controller({ version: '1' })
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('capture-sessions')
  async createSession(
    @CurrentUser() user: AuthedUser,
    @Body(zodBody(CreateSessionRequest)) body: CreateSessionRequest,
  ): Promise<CaptureSession> {
    return this.uploads.createSession(user.id, body);
  }

  @Get('capture-sessions/:id')
  async getSession(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CaptureSession> {
    return this.uploads.getSession(user.id, id);
  }

  @Post('capture-sessions/:id/uploads')
  async createUpload(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body(zodBody(CreateUploadRequest)) body: CreateUploadRequest,
  ): Promise<CreateUploadResponse> {
    return this.uploads.createUpload(user.id, sessionId, body);
  }

  @Post('capture-sessions/:id/finalise')
  async finalise(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) sessionId: string,
  ): Promise<CaptureSession> {
    return this.uploads.finaliseSession(user.id, sessionId);
  }

  @Get('uploads/:uploadId')
  async status(
    @CurrentUser() user: AuthedUser,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
  ): Promise<UploadStatus> {
    return this.uploads.getUploadStatus(user.id, uploadId);
  }

  @Post('uploads/:uploadId/complete')
  async complete(
    @CurrentUser() user: AuthedUser,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Body(zodBody(CompleteUploadRequest)) body: CompleteUploadRequest,
  ): Promise<{ assetId: string }> {
    return this.uploads.completeUpload(user.id, uploadId, body);
  }

  @Delete('uploads/:uploadId')
  @HttpCode(204)
  async abort(
    @CurrentUser() user: AuthedUser,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
  ): Promise<void> {
    await this.uploads.abortUpload(user.id, uploadId);
  }
}
