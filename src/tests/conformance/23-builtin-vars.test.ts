
import { describe } from 'vitest';
import { runGraphTest, runGraphErrorTest, availableBackends, cpuBackends } from './test-runner';

describe('Conformance: Built-in Variables', () => {
  const builtins = [
    { name: 'time', val: 123.45 },
    { name: 'delta_time', val: 0.016 },
    { name: 'bpm', val: 128.0 },
    { name: 'beat_number', val: 4.0 },
    { name: 'beat_delta', val: 0.25 },
  ];

  builtins.forEach(({ name, val }) => {
    runGraphTest(`should return ${name}`, [
      { id: 'res', op: 'builtin_get', name }
    ], 'res', val, availableBackends, new Map([[name, val]]));
  });

  if (cpuBackends.length > 0) {
    describe('GPU-only Built-ins on CPU', () => {
      const gpuBuiltins = [
        { name: 'position', type: 'float4' },
        { name: 'vertex_index', type: 'int' },
        { name: 'instance_index', type: 'int' },
        { name: 'global_invocation_id', type: 'float3' },
        { name: 'local_invocation_id', type: 'float3' },
        { name: 'workgroup_id', type: 'float3' },
        { name: 'local_invocation_index', type: 'int' },
        { name: 'num_workgroups', type: 'float3' },
        { name: 'frag_coord', type: 'float4' },
        { name: 'front_facing', type: 'bool' }, // Use 'bool' for local variable type
      ];

      gpuBuiltins.forEach(({ name, type }) => {
        runGraphErrorTest(`should FAIL when ${name} is used on CPU`, [
          { id: 'res', op: 'builtin_get', name }
        ], new RegExp(`GPU Built-in '${name}' is not available in CPU context|not allowed in CPU context|Builtin '${name}' is not allowed`), [], [], [{ id: 'res', type }], cpuBackends);
      });
    });
  }
});
