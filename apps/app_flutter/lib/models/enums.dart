/// Human-readable pipeline stage labels. Keyed by the API's StageName.
const stageLabels = <String, String>{
  'S1_VALIDATE': 'Checking your photos',
  'S2_EXTRACT': 'Reading your video',
  'S3_SELECT': 'Picking the best frames',
  'S4_SEGMENT': 'Finding you in the frame',
  'S5_BODY_INFERENCE': 'Building your body model',
  'S6_FUSE': 'Combining every angle',
  'S7_SCALE': 'Working out your proportions',
  'S8_RETARGET': 'Refining the model',
  'S9_UNWRAP': 'Preparing the surface',
  'S10_TEXTURE_BAKE': 'Painting your texture',
  'S11_OPTIMISE': 'Polishing the mesh',
  'S12_EXPORT': 'Packaging your avatar',
};

const scaleExplanation = <String, String>{
  'USER_HEIGHT': 'Sized from the height you gave us',
  'ARKIT_DEPTH': 'Sized using your phone’s depth sensor',
  'REFERENCE_OBJECT': 'Sized from a reference object in frame',
  'STATISTICAL_PRIOR': 'Estimated from population averages — add your height for accuracy',
};

bool isTerminalStatus(String s) =>
    s == 'COMPLETED' || s == 'FAILED' || s == 'CANCELLED';
