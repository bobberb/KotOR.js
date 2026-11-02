import { describe, expect, jest, test } from '@jest/globals';

// Only the animation-node runtime needs the 3D model; the exporter does not.
jest.mock('@/three/odyssey', () => ({ OdysseyModel3D: class {} }));
jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/loaders', () => ({ ResourceLoader: {}, TextureLoader: {} }));
jest.mock('@/loaders/ResourceLoader', () => ({ ResourceLoader: {} }));
// OdysseyModelNode <-> OdysseyModelAnimationNode is an import cycle; entering
// from the subclass lets the base class finish defining first.
import '@/odyssey/OdysseyModelAnimationNode';
import { exportOdysseyModelAscii } from '@/odyssey/export/odysseyModelAscii';
import { OdysseyModelClass } from '@/enums/odyssey/OdysseyModelClass';

/**
 * Owner of __snapshots__/odysseyModelAscii.test.ts.snap. The snapshot was
 * committed in d863bd4 without the test that wrote it, so every jest run
 * reported it obsolete and exited 1. The test name is kept verbatim so the
 * committed snapshot, not a freshly written one, is what this asserts against.
 *
 * Pins the MDL ASCII banner and model header lines that MDLedit-compatible
 * readers (and our own odysseyModelAsciiParser) key on.
 */
function minimalModel(): any {
  return {
    geometryHeader: { modelName: 'testgeom', rootNodeOffset: 0 },
    modelHeader: {
      superModelName: '',
      classification: OdysseyModelClass.OTHER,
      subClassification: 0,
      fogged: false,
      scale: 1,
      animRootOffset: 0,
      boundingMinX: 0, boundingMinY: 0, boundingMinZ: 0,
      boundingMaxX: 0, boundingMaxY: 0, boundingMaxZ: 0,
      radius: 0,
    },
    asciiCompressQuaternions: 0,
    names: [],
    animations: [],
  };
}

describe('odysseyModelAscii', () => {
  test('model banner + header lines snapshot (helpers only)', () => {
    const ascii = exportOdysseyModelAscii(minimalModel(), { includeAnimations: false });
    const lines = ascii.split(/\r?\n/);
    const header = lines.slice(0, lines.indexOf('# GEOM ASCII')).join('\n').trimEnd();
    expect(header).toMatchSnapshot();
  });
});
