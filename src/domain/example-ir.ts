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
      size: { mode: 'viewport' },
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

export const EFFECT_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Simple Effect' },
  entryPoint: 'fn_main_cpu',
  inputs: [
    { id: 'input_visual', type: 'texture2d', format: 'rgba8', comment: 'Input video stream' },
    { id: 'intensity', type: 'float', default: 1.0, ui: { min: 0.0, max: 1.0, widget: 'slider' } }
  ],
  resources: [
    {
      id: 'output_tex',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'viewport' },
      isOutput: true,
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
    }
  ],
  functions: [
    {
      id: 'fn_main_cpu',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'size', op: 'resource_get_size', resource: 'output_tex' },
        { id: 'dispatch', op: 'cmd_dispatch', func: 'fn_effect_gpu', dispatch: 'size' }
      ]
    },
    {
      id: 'fn_effect_gpu',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'coords', op: 'vec_swizzle', vec: 'gid', channels: 'xy' },
        { id: 'size', op: 'resource_get_size', resource: 'output_tex' },

        // Sampling normalization
        { id: 'uv', op: 'math_div', a: 'coords', b: 'size' },

        // Sample input
        { id: 'color', op: 'texture_sample', tex: 'input_visual', coords: 'uv' },

        // Grayscale conversion
        { id: 'lum_coeffs', op: 'float3', x: 0.2126, y: 0.7152, z: 0.0722 },
        { id: 'rgb', op: 'vec_swizzle', vec: 'color', channels: 'xyz' },
        { id: 'luma', op: 'vec_dot', a: 'rgb', b: 'lum_coeffs' },
        { id: 'gray_vec', op: 'float3', x: 'luma', y: 'luma', z: 'luma' },

        // Mix based on intensity
        { id: 'val_intensity', op: 'var_get', var: 'intensity' },
        { id: 'final_rgb', op: 'math_mix', a: 'rgb', b: 'gray_vec', t: 'val_intensity' },

        { id: 'r', op: 'vec_swizzle', vec: 'final_rgb', channels: 'x' },
        { id: 'g', op: 'vec_swizzle', vec: 'final_rgb', channels: 'y' },
        { id: 'b', op: 'vec_swizzle', vec: 'final_rgb', channels: 'z' },
        { id: 'out_color', op: 'float4', x: 'r', y: 'g', z: 'b', w: 1.0 },

        { id: 'store', op: 'texture_store', tex: 'output_tex', coords: 'coords', value: 'out_color' }
      ]
    }
  ]
};

export const MIXER_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Texture Mixer' },
  entryPoint: 'fn_main_cpu',
  inputs: [
    { id: 'tex_a', type: 'texture2d', format: 'rgba8', label: 'Layer A' },
    { id: 'tex_b', type: 'texture2d', format: 'rgba8', label: 'Layer B' },
    { id: 'opacity', type: 'float', default: 0.5, ui: { min: 0.0, max: 1.0, widget: 'slider' } }
  ],
  resources: [
    {
      id: 'output_mix',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'viewport' },
      isOutput: true,
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
    }
  ],
  functions: [
    {
      id: 'fn_main_cpu',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'size', op: 'resource_get_size', resource: 'output_mix' },
        { id: 'dispatch', op: 'cmd_dispatch', func: 'fn_mix_gpu', dispatch: 'size' }
      ]
    },
    {
      id: 'fn_mix_gpu',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'coords', op: 'vec_swizzle', vec: 'gid', channels: 'xy' },
        { id: 'size', op: 'resource_get_size', resource: 'output_mix' },
        { id: 'uv', op: 'math_div', a: 'coords', b: 'size' },

        { id: 'col_a', op: 'texture_sample', tex: 'tex_a', coords: 'uv' },
        { id: 'col_b', op: 'texture_sample', tex: 'tex_b', coords: 'uv' },

        { id: 'val_opacity', op: 'var_get', var: 'opacity' },
        { id: 'mixed', op: 'math_mix', a: 'col_a', b: 'col_b', t: 'val_opacity' },

        { id: 'store', op: 'texture_store', tex: 'output_mix', coords: 'coords', value: 'mixed' }
      ]
    }
  ]
};

export const RAYMARCH_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Basic Raymarcher' },
  entryPoint: 'fn_main_cpu',
  inputs: [
    { id: 'time', type: 'float', default: 0.0 }
  ],
  resources: [
    {
      id: 'output_ray',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'viewport' },
      isOutput: true,
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
    }
  ],
  functions: [
    {
      id: 'fn_main_cpu',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'size', op: 'resource_get_size', resource: 'output_ray' },
        { id: 'dispatch', op: 'cmd_dispatch', func: 'fn_ray_gpu', dispatch: 'size' }
      ]
    },
    {
      id: 'fn_sdf',
      type: 'shader',
      comment: 'Signed Distance Function for a sphere',
      inputs: [
        { id: 'p', type: 'float3' }
      ],
      outputs: [
        { id: 'dist', type: 'float' }
      ],
      localVars: [],
      nodes: [
        { id: 'radius', op: 'literal', val: 0.5 },
        { id: 'len', op: 'vec_length', a: 'p' },
        { id: 'd', op: 'math_sub', a: 'len', b: 'radius' },
        { id: 'ret', op: 'func_return', val: 'd' }
      ]
    },
    {
      id: 'fn_ray_gpu',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [
        { id: 't', type: 'float', initialValue: 0.0 },
        { id: 'hit', type: 'float', initialValue: 0.0 }, // Changed to float to avoid MSL bool issues
        { id: 'p', type: 'float3', initialValue: [0, 0, -2] },
        { id: 'i', type: 'int', initialValue: 0 }
      ],
      nodes: [
        // Setup Rays
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'coords', op: 'vec_swizzle', vec: 'gid', channels: 'xy' },
        { id: 'size', op: 'resource_get_size', resource: 'output_ray' },
        { id: 'uv', op: 'math_div', a: 'coords', b: 'size' },

        // Remap UV to -1..1
        { id: 'uv2', op: 'math_mul', a: 'uv', b: 2.0 },
        { id: 'uv_centered', op: 'math_sub', a: 'uv2', b: 1.0 },

        // Ray Origin / Direction
        { id: 'ro', op: 'float3', x: 0.0, y: 0.0, z: -2.0 },
        { id: 'rd_x', op: 'vec_swizzle', vec: 'uv_centered', channels: 'x' },
        { id: 'rd_y', op: 'vec_swizzle', vec: 'uv_centered', channels: 'y' },
        { id: 'rd', op: 'float3', x: 'rd_x', y: 'rd_y', z: 1.0 },
        { id: 'rd_norm', op: 'vec_normalize', a: 'rd' },

        // Init loop vars
        { id: 't_init', op: 'var_set', var: 't', val: 0.0 },
        { id: 'hit_init', op: 'var_set', var: 'hit', val: 0.0 },

        // Raymarch Loop
        {
          id: 'march_loop',
          op: 'flow_loop',
          start: 0,
          end: 32,
          exec_body: 'dist_calc',
          exec_completed: 'final_store' // Jump to store on completion
        },

        // BODY
        { id: 'cur_t', op: 'var_get', var: 't' },
        { id: 'cur_ray', op: 'math_mul', a: 'rd_norm', b: 'cur_t' },
        { id: 'cur_p', op: 'math_add', a: 'ro', b: 'cur_ray' },

        // Inlined SDF (Sphere)
        // d = length(p) - radius
        { id: 'radius', op: 'literal', val: 0.5 },
        { id: 'p_len', op: 'vec_length', a: 'cur_p' },
        { id: 'dist_calc', op: 'math_sub', a: 'p_len', b: 'radius', exec_out: 'branch_hit' }, // Executable anchor

        // Check hit
        { id: 'epsilon', op: 'literal', val: 0.001 },
        { id: 'is_hit', op: 'math_lt', a: 'dist_calc', b: 'epsilon' },

        {
          id: 'branch_hit',
          op: 'flow_branch',
          cond: 'is_hit',
          exec_true: 'hit_true',
          exec_false: 't_update'
        },

        { id: 'hit_true', op: 'var_set', var: 'hit', val: 1.0 },

        // Miss: t += dist
        { id: 'next_t', op: 'math_add', a: 'cur_t', b: 'dist_calc' },
        { id: 't_update', op: 'var_set', var: 't', val: 'next_t' },

        // COMPLETED
        { id: 'did_hit', op: 'var_get', var: 'hit' },

        // Color based on hit
        { id: 'col_hit', op: 'float4', x: 1.0, y: 0.0, z: 0.0, w: 1.0 },
        { id: 'col_miss', op: 'float4', x: 0.0, y: 0.0, z: 0.0, w: 1.0 },

        {
          id: 'final_color',
          op: 'math_mix',
          a: 'col_miss',
          b: 'col_hit',
          t: 'did_hit'
        },

        // Re-fetch coords for store (to avoid scope issues if blocked in loop)
        // Ideally we reuse 'coords', but if codegen places it in loop, we might need a fresh fetch or just risk it.
        // Let's try reusing 'coords' first. If it fails on MSL, we duplicate.
        { id: 'final_store', op: 'texture_store', tex: 'output_ray', coords: 'coords', value: 'final_color' }
      ]
    }
  ]
};

export const ALL_EXAMPLES = {
  noise_shader: NOISE_SHADER,
  effect_shader: EFFECT_SHADER,
  mixer_shader: MIXER_SHADER,
  raymarch_shader: RAYMARCH_SHADER,
};
