class UserProfile {
  final String id;
  final String? email;
  final String? displayName;
  final double? heightCm;
  final double? weightKg;
  final int? birthYear;
  final String? sexAtBirth;
  final String dataRegion;

  UserProfile({
    required this.id,
    this.email,
    this.displayName,
    this.heightCm,
    this.weightKg,
    this.birthYear,
    this.sexAtBirth,
    required this.dataRegion,
  });

  factory UserProfile.fromJson(Map<String, dynamic> j) => UserProfile(
        id: j['id'] as String,
        email: j['email'] as String?,
        displayName: j['displayName'] as String?,
        heightCm: (j['heightCm'] as num?)?.toDouble(),
        weightKg: (j['weightKg'] as num?)?.toDouble(),
        birthYear: j['birthYear'] as int?,
        sexAtBirth: j['sexAtBirth'] as String?,
        dataRegion: (j['dataRegion'] as String?) ?? 'eu',
      );
}

class Consent {
  final String kind;
  final String version;
  final bool granted;
  final String? revokedAt;
  Consent(
      {required this.kind,
      required this.version,
      required this.granted,
      this.revokedAt});
  factory Consent.fromJson(Map<String, dynamic> j) => Consent(
        kind: j['kind'] as String,
        version: j['version'] as String,
        granted: j['granted'] as bool,
        revokedAt: j['revokedAt'] as String?,
      );
}
