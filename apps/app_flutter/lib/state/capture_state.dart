import 'package:flutter/foundation.dart';

/// Local capture state. Nothing here leaves the device until the user confirms.
class CaptureState extends ChangeNotifier {
  final List<String> photos = [];
  String? videoPath;
  bool videoMirrored = false;

  void addPhoto(String path) {
    photos.add(path);
    notifyListeners();
  }

  void removeLast() {
    if (photos.isNotEmpty) {
      photos.removeLast();
      notifyListeners();
    }
  }

  void setVideo(String path, bool mirrored) {
    videoPath = path;
    videoMirrored = mirrored;
    notifyListeners();
  }

  void reset() {
    photos.clear();
    videoPath = null;
    videoMirrored = false;
    notifyListeners();
  }
}
