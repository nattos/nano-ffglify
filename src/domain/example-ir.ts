import { IRDocument, TextureFormat } from "../ir/types";

export const NOISE_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Simple Noise Generator' },
  comment: 'Demonstrates pitfalls like built-in swizzling, input inheritance, and isOutput flag.',
  entryPoint: 'fn_main_cpu',

  inputs: [
    { id: 'scale', type: 'float', default: 10.0, comment: 'Global scale for noise frequency.' },
    { id: 'time', type: 'float', default: 0.0, comment: 'Global time for noise animation.' }
  ],

  resources: [
    {
      id: 'output_tex',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'fixed', value: [256, 256] },
      isOutput: true,
      comment: `Primary display output. Note that mode: 'fixed' means it has own dimensions, 'viewport' means it follows the display. isOutput: true marks the texture resource as the primary output, usually the one that will be displayed.`,
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: true }
    }
  ],

  functions: [
    {
      id: 'fn_main_cpu',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      comment: 'Root CPU entry point. Handles high-level dispatch logic.',
      nodes: [
        {
          id: 'get_tex_size',
          op: 'resource_get_size',
          resource: 'output_tex',
          comment: 'PITFALL: Shaders expect workgroup-normalized dispatch sizes. resource_get_size provides raw dimensions.'
        },
        {
          id: 'dispatch_noise',
          op: 'cmd_dispatch',
          func: 'fn_noise_gpu',
          dispatch: 'get_tex_size',
          comment: 'DISPATCH: Global inputs (scale, time) are automatically inherited.'
        }
      ]
    },
    {
      id: 'fn_noise_gpu',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      comment: 'Compute kernel for noise generation.',
      nodes: [
        {
          id: 'in_gid',
          op: 'builtin_get',
          name: 'global_invocation_id',
          comment: 'BUILT-INS: global_invocation_id is a vec3<u32>. Always swizzle to \'xy\' and cast to float if doing math.'
        },
        {
          id: 'pixel_coords',
          op: 'vec_swizzle',
          vec: 'in_gid',
          channels: 'xy',
          comment: 'Cast to 2D coordinates for texture access.'
        },
        {
          id: 'tex_dims',
          op: 'resource_get_size',
          resource: 'output_tex',
          comment: 'RESISTANCE TO HARDCODING: Always use the resource size for normalization.'
        },
        { id: 'uv', op: 'math_div', a: 'pixel_coords', b: 'tex_dims' },

        {
          id: 'val_scale',
          op: 'var_get',
          var: 'scale',
          comment: 'INPUT INHERITANCE: Getting globals via var_get.'
        },
        { id: 'scaled_uv', op: 'math_mul', a: 'uv', b: 'val_scale' },

        { id: 'val_time', op: 'var_get', var: 'time' },
        { id: 'time_offset', op: 'float2', x: 'val_time', y: 'val_time' },
        { id: 'uv_animated', op: 'math_add', a: 'scaled_uv', b: 'time_offset' },

        { id: 'hash_const', op: 'float2', x: 12.9898, y: 78.233 },
        { id: 'dot_prod', op: 'vec_dot', a: 'uv_animated', b: 'hash_const' },
        { id: 'sin_res', op: 'math_sin', val: 'dot_prod' },
        { id: 'noise_raw', op: 'math_mul', a: 'sin_res', b: 43758.5453 },
        { id: 'noise_final', op: 'math_fract', val: 'noise_raw' },

        { id: 'rgba_out', op: 'float4', x: 'noise_final', y: 'noise_final', z: 'noise_final', w: 1.0 },

        {
          id: 'op_store',
          op: 'texture_store',
          tex: 'output_tex',
          coords: 'pixel_coords',
          value: 'rgba_out',
          comment: 'STORAGE: Coordinates should be floats or ints; system handles casting.'
        }
      ]
    }
  ]
};

export const ALL_EXAMPLES = {
  noise_shader: NOISE_SHADER,
};
