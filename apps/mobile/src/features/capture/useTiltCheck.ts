import { useEffect, useState } from 'react';
import { Accelerometer } from 'expo-sensors';

/**
 * Phone-upright check.
 *
 * A tilted phone introduces perspective distortion that biases the whole
 * reconstruction — the model comes out systematically wrong in a way no
 * downstream stage can undo, because it looks like a real body shape. Cheap to
 * detect, so we detect it.
 */
export interface TiltState {
  /** Degrees from vertical. 0 = perfectly upright. */
  tiltDeg: number;
  isUpright: boolean;
  available: boolean;
}

const UPRIGHT_TOLERANCE_DEG = 12;

export function useTiltCheck(active: boolean): TiltState {
  const [state, setState] = useState<TiltState>({
    tiltDeg: 0,
    isUpright: true,
    available: false,
  });

  useEffect(() => {
    if (!active) return;

    let subscription: { remove: () => void } | null = null;
    let cancelled = false;

    const start = async (): Promise<void> => {
      const available = await Accelerometer.isAvailableAsync().catch(() => false);
      if (cancelled) return;

      if (!available) {
        setState({ tiltDeg: 0, isUpright: true, available: false });
        return;
      }

      Accelerometer.setUpdateInterval(200);

      subscription = Accelerometer.addListener(({ x, y, z }) => {
        // Angle between the phone's -Y axis (its "up") and gravity.
        const magnitude = Math.sqrt(x * x + y * y + z * z) || 1;
        const tiltRad = Math.acos(Math.min(1, Math.max(-1, -y / magnitude)));
        const tiltDeg = Math.abs((tiltRad * 180) / Math.PI);

        setState({
          tiltDeg,
          isUpright: tiltDeg <= UPRIGHT_TOLERANCE_DEG,
          available: true,
        });
      });
    };

    void start();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [active]);

  return state;
}
