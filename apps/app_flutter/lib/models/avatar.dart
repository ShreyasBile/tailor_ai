class MeshStats {
  final int vertexCount, triangleCount, fileSizeBytes;
  final int? textureRes;
  MeshStats(this.vertexCount, this.triangleCount, this.fileSizeBytes, this.textureRes);
  factory MeshStats.fromJson(Map<String, dynamic> j) => MeshStats(
      (j['vertexCount'] ?? 0) as int,
      (j['triangleCount'] ?? 0) as int,
      (j['fileSizeBytes'] ?? 0) as int,
      j['textureRes'] as int?);
}

class Coverage {
  final double front, back, left, right, inpaintedFraction;
  Coverage(this.front, this.back, this.left, this.right, this.inpaintedFraction);
  factory Coverage.fromJson(Map<String, dynamic> j) => Coverage(
      (j['front'] as num).toDouble(),
      (j['back'] as num).toDouble(),
      (j['left'] as num).toDouble(),
      (j['right'] as num).toDouble(),
      (j['inpaintedFraction'] as num).toDouble());
}

class AvatarRender {
  final String id, bodyCoreId, rendererVersion;
  final MeshStats stats;
  final bool isTextured, isDegraded;
  final Coverage? coverage;
  final String? glbUrl, thumbnailUrl;

  AvatarRender({
    required this.id,
    required this.bodyCoreId,
    required this.rendererVersion,
    required this.stats,
    required this.isTextured,
    required this.isDegraded,
    this.coverage,
    this.glbUrl,
    this.thumbnailUrl,
  });

  factory AvatarRender.fromJson(Map<String, dynamic> j) {
    String? signed(dynamic v) =>
        v is Map<String, dynamic> ? v['url'] as String? : null;
    final assets = (j['assets'] ?? {}) as Map<String, dynamic>;
    return AvatarRender(
      id: j['id'] as String,
      bodyCoreId: j['bodyCoreId'] as String,
      rendererVersion: (j['rendererVersion'] ?? '') as String,
      stats: MeshStats.fromJson((j['stats'] ?? {}) as Map<String, dynamic>),
      isTextured: (j['isTextured'] ?? false) as bool,
      isDegraded: (j['isDegraded'] ?? false) as bool,
      coverage: j['coverage'] is Map<String, dynamic>
          ? Coverage.fromJson(j['coverage'] as Map<String, dynamic>)
          : null,
      glbUrl: signed(assets['glb']),
      thumbnailUrl: signed(assets['thumbnail']),
    );
  }
}

class BodyCore {
  final String id;
  final int version;
  final bool isCurrent;
  final String bodyModel;
  final String scaleSource;
  final double? heightCm;
  final double? overallQuality;
  final int frameCount;
  final String captureMode;
  final String createdAt;

  BodyCore({
    required this.id,
    required this.version,
    required this.isCurrent,
    required this.bodyModel,
    required this.scaleSource,
    this.heightCm,
    this.overallQuality,
    required this.frameCount,
    required this.captureMode,
    required this.createdAt,
  });

  factory BodyCore.fromJson(Map<String, dynamic> j) {
    final scale = (j['scale'] ?? {}) as Map<String, dynamic>;
    final q = (j['quality'] ?? {}) as Map<String, dynamic>;
    return BodyCore(
      id: j['id'] as String,
      version: (j['version'] ?? 1) as int,
      isCurrent: (j['isCurrent'] ?? false) as bool,
      bodyModel: (j['bodyModel'] ?? 'MHR') as String,
      scaleSource: (scale['source'] ?? 'STATISTICAL_PRIOR') as String,
      heightCm: (scale['heightCm'] as num?)?.toDouble(),
      overallQuality: (q['overall'] as num?)?.toDouble(),
      frameCount: (q['frameCount'] ?? 0) as int,
      captureMode: (q['captureMode'] ?? 'PHOTO_SET') as String,
      createdAt: (j['createdAt'] ?? '') as String,
    );
  }
}
