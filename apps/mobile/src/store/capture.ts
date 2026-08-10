import { create } from 'zustand';

/** Local capture state. Nothing here leaves the device until the user confirms. */
interface CaptureState {
  photos: string[];
  videoUri: string | null;
  /**
   * True when the video came from the front camera, whose preview (and
   * therefore its frames) are mirrored. Photos are un-mirrored on-device at
   * capture time; a video cannot be flipped cheaply here, so the flag travels
   * with the upload and the server flips frames during extraction.
   */
  videoMirrored: boolean;
  /** Populated during upload so a retry can resume rather than restart. */
  sessionId: string | null;
  uploadProgress: number;

  addPhoto: (uri: string) => void;
  removePhoto: (uri: string) => void;
  setVideo: (uri: string, mirrored: boolean) => void;
  setSessionId: (id: string | null) => void;
  setUploadProgress: (v: number) => void;
  reset: () => void;
}

export const useCaptureStore = create<CaptureState>((set) => ({
  photos: [],
  videoUri: null,
  videoMirrored: false,
  sessionId: null,
  uploadProgress: 0,

  addPhoto: (uri) => set((s) => ({ photos: [...s.photos, uri] })),
  removePhoto: (uri) => set((s) => ({ photos: s.photos.filter((p) => p !== uri) })),
  setVideo: (uri, mirrored) => set({ videoUri: uri, videoMirrored: mirrored }),
  setSessionId: (id) => set({ sessionId: id }),
  setUploadProgress: (uploadProgress) => set({ uploadProgress }),
  reset: () =>
    set({
      photos: [],
      videoUri: null,
      videoMirrored: false,
      sessionId: null,
      uploadProgress: 0,
    }),
}));
