/// A single measurement with its placement on the body (for the highlight).
class MeasurementRegion {
  final String key; // e.g. 'waist'
  final double value; // cm
  final String kind; // girth | width | length
  final double? y; // fraction of stature from the ground (girth/width)
  final double? y0, y1; // vertical span (length)
  final String side; // torso | arm | leg | full

  MeasurementRegion({
    required this.key,
    required this.value,
    required this.kind,
    required this.side,
    this.y,
    this.y0,
    this.y1,
  });

  /// Human label, e.g. 'shoulder_to_crotch' -> 'Shoulder to crotch'.
  String get label {
    final words = key.split('_');
    return words
        .map((w) => w.isEmpty ? w : '${w[0].toUpperCase()}${w.substring(1)}')
        .join(' ');
  }
}

class Measurements {
  final String bodyCoreId;
  final bool estimated;
  final double? confidence;
  final String scaleSource;
  final double? heightCm;
  final List<MeasurementRegion> items;

  Measurements({
    required this.bodyCoreId,
    required this.estimated,
    required this.confidence,
    required this.scaleSource,
    required this.heightCm,
    required this.items,
  });

  factory Measurements.fromJson(Map<String, dynamic> j) {
    final regions = (j['regions'] as Map<String, dynamic>? ?? {});
    // Display order: the ones people care about first.
    const order = [
      'chest', 'waist', 'hip', 'thigh', 'calf', 'ankle',
      'bicep', 'forearm', 'wrist', 'shoulder_breadth',
      'height', 'arm_length', 'leg_length', 'shoulder_to_crotch',
    ];
    final items = <MeasurementRegion>[];
    for (final key in order) {
      final r = regions[key] as Map<String, dynamic>?;
      if (r == null) continue;
      items.add(MeasurementRegion(
        key: key,
        value: (r['value'] as num).toDouble(),
        kind: r['kind'] as String,
        side: (r['side'] as String?) ?? 'torso',
        y: (r['y'] as num?)?.toDouble(),
        y0: (r['y0'] as num?)?.toDouble(),
        y1: (r['y1'] as num?)?.toDouble(),
      ));
    }
    return Measurements(
      bodyCoreId: j['bodyCoreId'] as String,
      estimated: (j['estimated'] as bool?) ?? true,
      confidence: (j['confidence'] as num?)?.toDouble(),
      scaleSource: (j['scaleSource'] as String?) ?? 'STATISTICAL_PRIOR',
      heightCm: (j['heightCm'] as num?)?.toDouble(),
      items: items,
    );
  }
}
