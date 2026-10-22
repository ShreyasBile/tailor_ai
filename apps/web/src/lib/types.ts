// Wire types come from the shared contracts package — one source of truth.
export type {
  UserProfile,
  Job,
  JobStageView,
  ScanReport,
  ScanIssue,
  ScanView,
  MeasurementDetail,
  MeasurementsResponse,
  AvatarRender,
  BodyCore,
  GarmentSummary,
  GarmentDetail,
  GarmentCategory,
  RecommendationView,
  FitDimension,
  FitPreference,
  Consent,
} from '@tailorai/contracts';

export const VIEWS = ['front', 'back', 'left', 'right'] as const;
export type View = (typeof VIEWS)[number];
