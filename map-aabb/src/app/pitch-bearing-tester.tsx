import ShapeTester from './shape-tester';

/** Dedicated manual regression surface for camera-dependent transforms. */
export function PitchBearingTester() {
  return <ShapeTester diagnostics initialPitch={45} initialBearing={45} />;
}

export default PitchBearingTester;
