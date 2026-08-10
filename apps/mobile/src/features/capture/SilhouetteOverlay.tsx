import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';
import { colors } from '../../theme/tokens';

/**
 * A-pose silhouette guide.
 *
 * Framing is the cheapest accuracy lever available: if the subject fills the
 * guide, they are the right distance away, fully in frame, and roughly in the
 * pose the reconstruction expects. Getting that right at capture time is far
 * cheaper than trying to recover from it downstream — and often impossible.
 */
export function SilhouetteOverlay({
  state,
}: {
  state: 'ok' | 'adjust' | 'bad';
}): React.JSX.Element {
  const { width, height } = useWindowDimensions();

  const tint =
    state === 'ok' ? colors.guideOk : state === 'adjust' ? colors.guideAdjust : colors.guideBad;

  // Guide occupies the middle 80% vertically so head and feet have margin.
  const guideH = height * 0.8;
  const guideW = guideH * 0.42;
  const cx = width / 2;
  const top = (height - guideH) / 2;

  const headR = guideH * 0.062;
  const headCy = top + headR * 1.2;
  const shoulderY = top + guideH * 0.2;
  const hipY = top + guideH * 0.52;
  const footY = top + guideH;

  const halfShoulder = guideW * 0.42;
  const halfHip = guideW * 0.34;

  // Torso outline, plus A-pose arms and parted legs.
  const torso = [
    `M ${cx - halfShoulder} ${shoulderY}`,
    `C ${cx - halfShoulder * 1.02} ${shoulderY + guideH * 0.14}, ${cx - halfHip * 1.06} ${hipY - guideH * 0.06}, ${cx - halfHip} ${hipY}`,
    `L ${cx + halfHip} ${hipY}`,
    `C ${cx + halfHip * 1.06} ${hipY - guideH * 0.06}, ${cx + halfShoulder * 1.02} ${shoulderY + guideH * 0.14}, ${cx + halfShoulder} ${shoulderY}`,
    'Z',
  ].join(' ');

  const armL = `M ${cx - halfShoulder} ${shoulderY + guideH * 0.01} L ${cx - guideW * 0.86} ${hipY + guideH * 0.02}`;
  const armR = `M ${cx + halfShoulder} ${shoulderY + guideH * 0.01} L ${cx + guideW * 0.86} ${hipY + guideH * 0.02}`;
  const legL = `M ${cx - halfHip * 0.6} ${hipY} L ${cx - halfHip * 0.82} ${footY}`;
  const legR = `M ${cx + halfHip * 0.6} ${hipY} L ${cx + halfHip * 0.82} ${footY}`;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={width} height={height}>
        {/* Dim outside the guide so the eye goes to the framing area. */}
        <Rect x={0} y={0} width={width} height={top} fill="rgba(0,0,0,0.45)" />
        <Rect x={0} y={footY} width={width} height={height - footY} fill="rgba(0,0,0,0.45)" />

        <Circle
          cx={cx}
          cy={headCy}
          r={headR}
          stroke={tint}
          strokeWidth={2.5}
          strokeDasharray="7 6"
          fill="none"
        />
        <Path d={torso} stroke={tint} strokeWidth={2.5} strokeDasharray="7 6" fill="none" />
        {[armL, armR, legL, legR].map((d, i) => (
          <Path
            key={i}
            d={d}
            stroke={tint}
            strokeWidth={2.5}
            strokeDasharray="7 6"
            strokeLinecap="round"
            fill="none"
          />
        ))}

        {/* Ground line — helps users judge whether their feet are in frame. */}
        <Ellipse
          cx={cx}
          cy={footY}
          rx={guideW * 0.5}
          ry={guideH * 0.012}
          stroke={tint}
          strokeWidth={1.5}
          opacity={0.5}
          fill="none"
        />
      </Svg>
    </View>
  );
}
