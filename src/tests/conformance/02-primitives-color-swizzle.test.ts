/**
 * @vitest-environment node
 *
 * NOTE: This file was split from 02-primitives.test.ts to avoid Vitest worker crashes
 * caused by the cumulative load of many WebGPU test definitions in a single process.
 */
import { describe, expect } from 'vitest';
import { runParametricTest, availableBackends } from './test-runner';

describe('Conformance: Color and Swizzles', () => {

  const bufferDef = {
    id: 'b_result',
    type: 'buffer',
    dataType: 'float',
    size: { mode: 'fixed', value: 100 },
    persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
  };

  interface TestCase {
    op: string;
    args: Record<string, any>;
    expected: any;
  }

  const runBatchTest = (suiteName: string, cases: TestCase[]) => {
    availableBackends.forEach(backend => {
      let currentOffset = 0;
      const nodesWithMeta = cases.map((c, i) => {
        const size = Array.isArray(c.expected) ? c.expected.length : 1;
        let dataType = 'float';
        if (size === 2) dataType = 'vec2<float>';
        if (size === 3) dataType = 'vec3<float>';
        if (size === 4) dataType = 'vec4<float>';

        const nodeOffset = currentOffset;
        currentOffset += size;

        if (typeof c.expected === 'boolean') {
          dataType = 'bool';
        }

        return { index: i, offset: nodeOffset, dataType, ...c };
      });

      const nodes = nodesWithMeta.flatMap((meta) => {
        const ops = [];
        ops.push({ id: `op_${meta.index}`, op: meta.op, ...meta.args });

        let storeValueId = `op_${meta.index}`;
        if (typeof meta.expected === 'boolean') {
          ops.push({ id: `cast_${meta.index}`, op: 'static_cast_float', val: storeValueId });
          storeValueId = `cast_${meta.index}`;
        }

        if (meta.dataType.startsWith('vec') || meta.dataType.startsWith('float2') || meta.dataType.startsWith('float3') || meta.dataType.startsWith('float4')) {
          const size = Array.isArray(meta.expected) ? meta.expected.length : 1;
          const channels = ['x', 'y', 'z', 'w'];
          for (let k = 0; k < size; k++) {
            const compId = `comp_${meta.index}_${k}`;
            ops.push({ id: compId, op: 'vec_swizzle', vec: storeValueId, channels: channels[k] });
            ops.push({ id: `store_${meta.index}_${k}`, op: 'buffer_store', buffer: 'b_result', index: meta.offset + k, value: compId });
          }
        } else {
          ops.push({ id: `store_${meta.index}_0`, op: 'buffer_store', buffer: 'b_result', index: meta.offset, value: storeValueId });
        }
        return ops;
      });

      const storeNodes = nodes.filter(n => n.op === 'buffer_store');

      const execEdges = storeNodes.map((node, i) => {
        if (i === 0) return null;
        const prev = storeNodes[i - 1];
        return {
          from: prev.id, portOut: 'exec_out',
          to: node.id, portIn: 'exec_in',
          type: 'execution'
        };
      }).filter(Boolean) as any[];

      runParametricTest(suiteName, nodes, (ctx) => {
        const res = ctx.getResource('b_result');

        nodesWithMeta.forEach((meta) => {
          const { expected, offset } = meta;
          const valAtOffset = res.data?.[offset];

          try {
            if (Array.isArray(expected)) {
              if (Array.isArray(valAtOffset)) {
                expect(valAtOffset).toHaveLength(expected.length);
                (valAtOffset as number[]).forEach((v, idx) => expect(v).toBeCloseTo(expected[idx], 5));
              } else {
                const slice = res.data?.slice(offset, offset + expected.length) || [];
                expect(slice).toHaveLength(expected.length);
                (slice as number[]).forEach((v, idx) => expect(v).toBeCloseTo(expected[idx], 5));
              }
            } else if (typeof expected === 'number') {
              expect(valAtOffset).toBeCloseTo(expected, 5);
            } else if (typeof expected === 'boolean') {
              if (typeof valAtOffset === 'number') {
                const boolVal = valAtOffset !== 0;
                expect(boolVal).toEqual(expected);
              } else {
                expect(valAtOffset).toEqual(expected);
              }
            } else {
              expect(valAtOffset).toEqual(expected);
            }
          } catch (e: any) {
            const raw = Array.isArray(expected)
              ? (Array.isArray(valAtOffset) ? valAtOffset : res.data?.slice(offset, offset + expected.length))
              : valAtOffset;
            throw new Error(`Test Case '${meta.op}' #${meta.index} failed.\nargs: ${JSON.stringify(meta.args)}\nExpected: ${JSON.stringify(expected)}\nReceived at offset ${offset}: ${JSON.stringify(raw)}\nOriginal: ${e.message}`);
          }
        });
      }, [bufferDef], execEdges, [], [], [backend]);
    });
  };

  runBatchTest('Color Operations', [
    {
      op: 'color_mix',
      args: { a: [1, 0, 0, 1], b: [0, 1, 0, 0.5] },
      expected: [0.5, 0.5, 0, 1]
    },
    {
      op: 'color_mix',
      args: { a: [0, 0, 0, 0], b: [0, 0, 1, 0.5] },
      expected: [0, 0, 1, 0.5]
    }
  ]);

  runBatchTest('Constructors and Swizzles', [
    { op: 'float2', args: { x: 1, y: 2 }, expected: [1, 2] },
    { op: 'float3', args: { x: 1, y: 2, z: 3 }, expected: [1, 2, 3] },
    { op: 'float4', args: { x: 1, y: 2, z: 3, w: 4 }, expected: [1, 2, 3, 4] },
    { op: 'vec_swizzle', args: { vec: [1, 2, 3, 4], channels: 'x' }, expected: 1 },
    { op: 'vec_swizzle', args: { vec: [1, 2, 3, 4], channels: 'wzyx' }, expected: [4, 3, 2, 1] },
    { op: 'vec_swizzle', args: { vec: [1, 2], channels: 'yxy' }, expected: [2, 1, 2] },
    { op: 'vec_get_element', args: { vec: [10, 20, 30], index: 1 }, expected: 20 },
  ]);

});
