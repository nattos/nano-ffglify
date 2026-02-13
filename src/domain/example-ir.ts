import { IRDocument, TextureFormat } from "../ir/types";

export const NOISE_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Simple Noise Generator' },
  comment: 'Demonstrates input inheritance, builtin_get (global_invocation_id is int3), and isOutput flag.',
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
          comment: 'BUILT-INS: global_invocation_id is int3. Swizzle to xy for 2D coords; int->float coercion is automatic in math ops.'
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
  meta: { name: 'Animated Raymarcher' },
  comment: 'Animated SDF with smooth blending, Lambert+Blinn-Phong shading, checkerboard floor, and exponential fog. Uses builtin_get(time) for animation.',
  entryPoint: 'fn_main_cpu',
  inputs: [
    { id: 'scale', type: 'float', default: 0.4, ui: { min: 0.05, max: 1.5, widget: 'slider' }, comment: 'Sphere radius.' }
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
      id: 'fn_ray_gpu',
      type: 'shader',
      comment: 'Raymarching kernel: orbiting sphere + ground plane, smin blending, shading, fog.',
      inputs: [],
      outputs: [],
      localVars: [
        { id: 't', type: 'float', initialValue: 0.01 },
        { id: 'hit', type: 'float', initialValue: 0.0 }
      ],
      nodes: [
        // ============================================================
        // Setup: screen coords, UV, aspect ratio
        // Coordinate system: pixel (0,0) = top-left, y increases downward.
        // UV maps to -1..1 with y flipped so +y = up (world space convention).
        // ============================================================
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'coords', op: 'vec_swizzle', vec: 'gid', channels: 'xy' },
        { id: 'size', op: 'resource_get_size', resource: 'output_ray' },
        { id: 'uv_raw', op: 'math_div', a: 'coords', b: 'size' },
        { id: 'uv_2', op: 'math_mul', a: 'uv_raw', b: 2.0 },
        { id: 'uv', op: 'math_sub', a: 'uv_2', b: 1.0 },
        { id: 'size_x', op: 'vec_swizzle', vec: 'size', channels: 'x' },
        { id: 'size_y', op: 'vec_swizzle', vec: 'size', channels: 'y' },
        { id: 'aspect', op: 'math_div', a: 'size_x', b: 'size_y' },

        // ============================================================
        // Camera: slightly elevated, looking down toward scene
        // uv_y is negated to flip screen-space y (top-down) to world y (up).
        // ============================================================
        { id: 'ro', op: 'float3', x: 0.0, y: 1.0, z: -3.0 },
        { id: 'uv_x', op: 'vec_swizzle', vec: 'uv', channels: 'x' },
        { id: 'uv_y', op: 'vec_swizzle', vec: 'uv', channels: 'y' },
        { id: 'uv_y_flip', op: 'math_mul', a: 'uv_y', b: -1.0 },
        { id: 'rd_x', op: 'math_mul', a: 'uv_x', b: 'aspect' },
        { id: 'rd_y', op: 'math_sub', a: 'uv_y_flip', b: 0.3 },
        { id: 'rd_raw', op: 'float3', x: 'rd_x', y: 'rd_y', z: 1.5 },
        { id: 'rd', op: 'vec_normalize', a: 'rd_raw' },

        // ============================================================
        // Animation: sphere orbits in xz plane, bobs vertically
        // ============================================================
        { id: 'val_time', op: 'builtin_get', name: 'time' },
        { id: 't_orbit', op: 'math_mul', a: 'val_time', b: 0.7 },
        { id: 'sin_orbit', op: 'math_sin', val: 't_orbit' },
        { id: 'cos_orbit', op: 'math_cos', val: 't_orbit' },
        { id: 'sc_x', op: 'math_mul', a: 'sin_orbit', b: 0.8 },
        { id: 'sc_z', op: 'math_mul', a: 'cos_orbit', b: 0.8 },
        { id: 't_bob', op: 'math_mul', a: 'val_time', b: 1.3 },
        { id: 'sin_bob', op: 'math_sin', val: 't_bob' },
        { id: 'sc_y_wave', op: 'math_mul', a: 'sin_bob', b: 0.1 },
        { id: 'sc_y', op: 'math_add', a: 'sc_y_wave', b: 0.15 },
        { id: 'sphere_center', op: 'float3', x: 'sc_x', y: 'sc_y', z: 'sc_z' },
        { id: 'sphere_radius', op: 'var_get', var: 'scale' },
        { id: 'k_sm', op: 'literal', val: 0.4 },

        // ============================================================
        // Init loop variables and start march
        // ============================================================
        { id: 't_init', op: 'var_set', var: 't', val: 0.01, exec_out: 'hit_init' },
        { id: 'hit_init', op: 'var_set', var: 'hit', val: 0.0, exec_out: 'march_loop' },
        {
          id: 'march_loop',
          op: 'flow_loop',
          count: 80,
          exec_body: 'body_anchor',
          exec_completed: 'final_store'
        },

        // ============================================================
        // Loop body: evaluate SDF (sphere + plane with smooth min)
        // ============================================================
        // Current point along ray
        { id: 'cur_t', op: 'var_get', var: 't' },
        { id: 'cur_ray', op: 'math_mul', a: 'rd', b: 'cur_t' },
        { id: 'cur_p', op: 'math_add', a: 'ro', b: 'cur_ray' },

        // Sphere SDF: length(p - center) - radius
        { id: 'p_sub_c', op: 'math_sub', a: 'cur_p', b: 'sphere_center' },
        { id: 'len_psc', op: 'vec_length', a: 'p_sub_c' },
        { id: 'd_sphere', op: 'math_sub', a: 'len_psc', b: 'sphere_radius' },

        // Ground plane SDF: p.y - (-0.5) = p.y + 0.5
        { id: 'cur_py', op: 'vec_swizzle', vec: 'cur_p', channels: 'y' },
        { id: 'd_plane', op: 'math_add', a: 'cur_py', b: 0.5 },

        // Smooth min: smin(a, b, k) = mix(a,b,h) - k*h*(1-h)
        //   where h = clamp(0.5 + 0.5*(a-b)/k, 0, 1)
        { id: 'sm_diff', op: 'math_sub', a: 'd_sphere', b: 'd_plane' },
        { id: 'sm_div', op: 'math_div', a: 'sm_diff', b: 'k_sm' },
        { id: 'sm_half', op: 'math_mul', a: 'sm_div', b: 0.5 },
        { id: 'sm_raw', op: 'math_add', a: 'sm_half', b: 0.5 },
        { id: 'sm_h', op: 'math_clamp', val: 'sm_raw', min: 0.0, max: 1.0 },
        { id: 'sm_lerp', op: 'math_mix', a: 'd_sphere', b: 'd_plane', t: 'sm_h' },
        { id: 'sm_inv', op: 'math_sub', a: 1.0, b: 'sm_h' },
        { id: 'sm_prod', op: 'math_mul', a: 'sm_h', b: 'sm_inv' },
        { id: 'sm_corr', op: 'math_mul', a: 'k_sm', b: 'sm_prod' },

        // total_d is the exec anchor for the loop body
        { id: 'body_anchor', op: 'math_sub', a: 'sm_lerp', b: 'sm_corr', exec_out: 'branch_hit' },

        // Hit check
        { id: 'is_hit', op: 'math_lt', a: 'body_anchor', b: 0.001 },
        {
          id: 'branch_hit',
          op: 'flow_branch',
          cond: 'is_hit',
          exec_true: 'set_hit',
          exec_false: 'advance_t'
        },
        { id: 'set_hit', op: 'var_set', var: 'hit', val: 1.0 },

        // Miss: advance ray
        { id: 'next_t', op: 'math_add', a: 'cur_t', b: 'body_anchor' },
        { id: 'advance_t', op: 'var_set', var: 't', val: 'next_t' },

        // ============================================================
        // Post-loop: compute hit point
        // ============================================================
        { id: 'final_t', op: 'var_get', var: 't' },
        { id: 'hit_ray', op: 'math_mul', a: 'rd', b: 'final_t' },
        { id: 'hit_p', op: 'math_add', a: 'ro', b: 'hit_ray' },

        // Recompute individual distances at hit point for blend factor
        { id: 'hp_sub_c', op: 'math_sub', a: 'hit_p', b: 'sphere_center' },
        { id: 'hp_len', op: 'vec_length', a: 'hp_sub_c' },
        { id: 'hp_d_sphere', op: 'math_sub', a: 'hp_len', b: 'sphere_radius' },
        { id: 'hp_py', op: 'vec_swizzle', vec: 'hit_p', channels: 'y' },
        { id: 'hp_d_plane', op: 'math_add', a: 'hp_py', b: 0.5 },

        // Blend factor (same smin h formula) — 0 = sphere, 1 = plane
        { id: 'bl_diff', op: 'math_sub', a: 'hp_d_sphere', b: 'hp_d_plane' },
        { id: 'bl_div', op: 'math_div', a: 'bl_diff', b: 'k_sm' },
        { id: 'bl_half', op: 'math_mul', a: 'bl_div', b: 0.5 },
        { id: 'bl_raw', op: 'math_add', a: 'bl_half', b: 0.5 },
        { id: 'blend_h', op: 'math_clamp', val: 'bl_raw', min: 0.0, max: 1.0 },

        // ============================================================
        // Normals: analytical blend (sphere normal + plane normal)
        // ============================================================
        { id: 'sphere_norm', op: 'vec_normalize', a: 'hp_sub_c' },
        { id: 'plane_norm', op: 'float3', x: 0.0, y: 1.0, z: 0.0 },
        { id: 'blended_norm', op: 'math_mix', a: 'sphere_norm', b: 'plane_norm', t: 'blend_h' },
        { id: 'normal', op: 'vec_normalize', a: 'blended_norm' },

        // ============================================================
        // Surface color: warm sphere + checkerboard floor
        // ============================================================
        { id: 'sphere_col', op: 'float3', x: 0.9, y: 0.45, z: 0.2 },

        // Checkerboard: fract((floor(x) + floor(z)) * 0.5) * 2 → 0 or 1
        { id: 'hp_x', op: 'vec_swizzle', vec: 'hit_p', channels: 'x' },
        { id: 'hp_z', op: 'vec_swizzle', vec: 'hit_p', channels: 'z' },
        { id: 'floor_x', op: 'math_floor', val: 'hp_x' },
        { id: 'floor_z', op: 'math_floor', val: 'hp_z' },
        { id: 'floor_sum', op: 'math_add', a: 'floor_x', b: 'floor_z' },
        { id: 'floor_half', op: 'math_mul', a: 'floor_sum', b: 0.5 },
        { id: 'floor_frac', op: 'math_fract', val: 'floor_half' },
        { id: 'checker', op: 'math_mul', a: 'floor_frac', b: 2.0 },
        { id: 'floor_dark', op: 'float3', x: 0.35, y: 0.35, z: 0.4 },
        { id: 'floor_light', op: 'float3', x: 0.55, y: 0.55, z: 0.6 },
        { id: 'floor_col', op: 'math_mix', a: 'floor_dark', b: 'floor_light', t: 'checker' },

        // Blend surface color by proximity
        { id: 'surface_col', op: 'math_mix', a: 'sphere_col', b: 'floor_col', t: 'blend_h' },

        // ============================================================
        // Lighting: Lambert diffuse + Blinn-Phong specular
        // ============================================================
        { id: 'light_raw', op: 'float3', x: 0.6, y: 0.8, z: -0.4 },
        { id: 'light_dir', op: 'vec_normalize', a: 'light_raw' },
        { id: 'ndotl_raw', op: 'vec_dot', a: 'normal', b: 'light_dir' },
        { id: 'ndotl', op: 'math_max', a: 'ndotl_raw', b: 0.05 },

        // Specular: half-vector method
        { id: 'neg_rd', op: 'math_mul', a: 'rd', b: -1.0 },
        { id: 'half_raw', op: 'math_add', a: 'light_dir', b: 'neg_rd' },
        { id: 'half_dir', op: 'vec_normalize', a: 'half_raw' },
        { id: 'ndoth_raw', op: 'vec_dot', a: 'normal', b: 'half_dir' },
        { id: 'ndoth', op: 'math_max', a: 'ndoth_raw', b: 0.0 },
        { id: 'spec_pow', op: 'math_pow', a: 'ndoth', b: 32.0 },
        { id: 'specular', op: 'math_mul', a: 'spec_pow', b: 0.4 },

        // Combine diffuse and specular
        { id: 'diff_contrib', op: 'math_mul', a: 'surface_col', b: 'ndotl' },
        { id: 'spec_vec', op: 'float3', x: 'specular', y: 'specular', z: 'specular' },
        { id: 'lit_color', op: 'math_add', a: 'diff_contrib', b: 'spec_vec' },

        // ============================================================
        // Fog: exponential distance fog
        // ============================================================
        { id: 'fog_neg', op: 'math_mul', a: 'final_t', b: -0.15 },
        { id: 'fog_fac', op: 'math_exp', val: 'fog_neg' },
        { id: 'fog_col', op: 'float3', x: 0.55, y: 0.62, z: 0.78 },
        { id: 'fogged', op: 'math_mix', a: 'fog_col', b: 'lit_color', t: 'fog_fac' },

        // ============================================================
        // Final output: blend hit/miss, write to texture
        // ============================================================
        { id: 'did_hit', op: 'var_get', var: 'hit' },
        { id: 'final_rgb', op: 'math_mix', a: 'fog_col', b: 'fogged', t: 'did_hit' },
        { id: 'out_r', op: 'vec_swizzle', vec: 'final_rgb', channels: 'x' },
        { id: 'out_g', op: 'vec_swizzle', vec: 'final_rgb', channels: 'y' },
        { id: 'out_b', op: 'vec_swizzle', vec: 'final_rgb', channels: 'z' },
        { id: 'out_rgba', op: 'float4', x: 'out_r', y: 'out_g', z: 'out_b', w: 1.0 },
        { id: 'final_store', op: 'texture_store', tex: 'output_ray', coords: 'coords', value: 'out_rgba' }
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
