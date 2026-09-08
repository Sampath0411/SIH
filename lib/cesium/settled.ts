import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';

/**
 * Geometry that is STATIC between user actions, and re-baked on them.
 *
 * THE TRAP. A polygon whose `hierarchy`, `height` or `extrudedHeight` is a
 * CallbackProperty is on Cesium's DYNAMIC updater path, and that path does
 * not ask whether the value changed: every rendered frame it destroys the
 * entity's Primitive, re-tessellates the polygon on the main thread
 * (`asynchronous: false`) and uploads fresh vertex buffers. A tower's
 * flats, its parking bays and its storey blocks -- a few hundred polygons --
 * did exactly that on every frame a building was selected, whether or not
 * the explode slider had moved in the last hour. Orbiting a selected
 * building cost ~70 ms of JS per frame more than orbiting the city.
 *
 * Yet the values DO change: the explode slider, the section plane and the
 * isolate lift all move geometry, and they all come from the store. So the
 * geometry is a pure function of a handful of store fields, and it can be
 * baked into ConstantProperty objects that are re-evaluated exactly when
 * those fields change. A ConstantProperty keeps the entity on the STATIC
 * path -- one batched primitive per data source, built in a worker -- and
 * `setValue` raises definitionChanged only when the value actually differs,
 * so a sync that finds nothing moved costs a comparison per property.
 *
 * During a slider drag the batch is rebuilt per store write rather than per
 * frame, in a worker, and Cesium keeps the previous primitive on screen
 * until the new one is ready -- so the drag reads as smooth and the scene
 * never blinks.
 *
 * Usage: create one set per build pass, hand every geometry property out of
 * `scalar` / `value`, keep the set in a ref, and call `sync()` from the
 * effects that push store state into the layer's closure.
 */
export interface SettledSet {
  /** A number-valued property: heights, widths. */
  scalar(read: () => number): Cesium.ConstantProperty;
  /**
   * An object-valued property: a PolygonHierarchy, a positions array. The
   * reader should return the SAME object while nothing changed -- identity is
   * what decides whether the batch is rebuilt.
   */
  value<T>(read: () => T): Cesium.ConstantProperty;
  /** Re-read every property; only those whose value moved raise a change. */
  sync(): boolean;
  /** Forget every property (the data source they belong to is gone). */
  dispose(): void;
}

export function createSettledSet(): SettledSet {
  const readers: Array<() => boolean> = [];
  const track = (prop: Cesium.ConstantProperty, read: () => unknown) => {
    readers.push(() => {
      const next = read();
      if (prop.getValue() === next) return false;
      prop.setValue(next);
      return true;
    });
    return prop;
  };
  return {
    scalar: (read) => track(new Cesium.ConstantProperty(read()), read),
    value: (read) => track(new Cesium.ConstantProperty(read()), read),
    sync: () => {
      let moved = false;
      for (const r of readers) if (r()) moved = true;
      return moved;
    },
    dispose: () => { readers.length = 0; },
  };
}

/**
 * A time to hand a CallbackProperty when asking it for its current value.
 * The callbacks this module deals with ignore it.
 */
export const NOW = Cesium.JulianDate.now();

/**
 * A reader for `value()` whose result is REBUILT only when a scalar key
 * moves: a positions array that depends on one height, say. Returning the
 * same array while the key is unchanged is what keeps the batch from being
 * rebuilt on a sync that found nothing to do.
 */
export function keyedValue<T>(key: () => number, build: (k: number) => T): () => T {
  let lastKey = Number.NaN;
  let cached: T | undefined;
  return () => {
    const k = key();
    if (k !== lastKey || cached === undefined) {
      lastKey = k;
      cached = build(k);
    }
    return cached;
  };
}
