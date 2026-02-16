import { IRDocument, TextureFormat, DataType, BuiltinName } from "../ir/types";

export const NOISE_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Simple Noise Generator' },
  comment: 'Animated hash-based noise. Demonstrates builtin_get, input inheritance via var_get, and isOutput flag.',
  entryPoint: 'fn_main_cpu',

  inputs: [
    { id: 'scale', type: 'float', default: 10.0, comment: 'Noise frequency scale.' }
  ],

  resources: [
    {
      id: 'output_tex',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'viewport' },
      isOutput: true,
      comment: "Primary display output. mode: 'viewport' follows display size. isOutput: true marks this as the displayed texture.",
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
      comment: 'CPU entry point: dispatches the noise compute kernel.',
      nodes: [
        { id: 'get_tex_size', op: 'resource_get_size', resource: 'output_tex' },
        { id: 'dispatch_noise', op: 'cmd_dispatch', func: 'fn_noise_gpu', threads: 'get_tex_size', comment: 'Global inputs (scale) are automatically inherited by the shader.' }
      ]
    },
    {
      id: 'fn_noise_gpu',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      comment: 'Compute kernel: hash-based noise with time animation.',
      nodes: [
        { id: 'c_coords', op: 'comment', comment: 'normalized_global_invocation_id gives float3(gid)/float3(grid_size). Swizzle .xy for UV.' },
        { id: 'in_gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },

        { id: 'val_scale', op: 'var_get', var: 'scale', comment: 'Global inputs accessed via var_get.' },
        { id: 'scaled_uv', op: 'math_mul', a: 'nuv.xy', b: 'val_scale' },

        { id: 'c_anim', op: 'comment', comment: 'Animate by offsetting UV with builtin time.' },
        { id: 'val_time', op: 'builtin_get', name: 'time' },
        { id: 'time_offset', op: 'float2', xy: 'val_time' },
        { id: 'uv_animated', op: 'math_add', a: 'scaled_uv', b: 'time_offset' },

        { id: 'c_hash', op: 'comment', comment: 'Hash-based pseudo-noise: fract(sin(dot(uv, magic)) * 43758.5453)' },
        { id: 'hash_const', op: 'float2', x: 12.9898, y: 78.233 },
        { id: 'dot_prod', op: 'vec_dot', a: 'uv_animated', b: 'hash_const' },
        { id: 'sin_res', op: 'math_sin', val: 'dot_prod' },
        { id: 'noise_raw', op: 'math_mul', a: 'sin_res', b: 43758.5453 },
        { id: 'noise_final', op: 'math_fract', val: 'noise_raw' },

        { id: 'rgba_out', op: 'float4', xyz: 'noise_final', w: 1.0 },
        { id: 'op_store', op: 'texture_store', tex: 'output_tex', coords: 'in_gid.xy', value: 'rgba_out' }
      ]
    }
  ]
};

export const EFFECT_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Simple Effect' },
  comment: 'Adjustable grayscale desaturation on an input texture. Demonstrates texture inputs and intensity slider.',
  entryPoint: 'fn_main_cpu',
  inputs: [
    { id: 'input_visual', type: 'texture2d', format: 'rgba8', comment: 'Input video stream.' },
    { id: 'intensity', type: 'float', default: 1.0, ui: { min: 0.0, max: 1.0, widget: 'slider' }, comment: 'Desaturation amount: 0 = original, 1 = full grayscale.' }
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
        { id: 'dispatch', op: 'cmd_dispatch', func: 'fn_effect_gpu', threads: 'size' }
      ]
    },
    {
      id: 'fn_effect_gpu',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      comment: 'Compute kernel: per-pixel grayscale desaturation.',
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },

        { id: 'color', op: 'texture_sample', tex: 'input_visual', coords: 'nuv.xy' },

        { id: 'c_gray', op: 'comment', comment: 'Grayscale via perceptual luminance weights (BT.709).' },
        { id: 'lum_coeffs', op: 'float3', x: 0.2126, y: 0.7152, z: 0.0722 },
        { id: 'luma', op: 'vec_dot', a: 'color.xyz', b: 'lum_coeffs' },
        { id: 'gray_vec', op: 'float3', xyz: 'luma' },

        { id: 'val_intensity', op: 'var_get', var: 'intensity', comment: 'Mix original RGB toward grayscale by intensity.' },
        { id: 'final_rgb', op: 'math_mix', a: 'color.xyz', b: 'gray_vec', t: 'val_intensity' },

        { id: 'out_color', op: 'float4', xyz: 'final_rgb', w: 1.0 },

        { id: 'store', op: 'texture_store', tex: 'output_tex', coords: 'gid.xy', value: 'out_color' }
      ]
    }
  ]
};

export const MIXER_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Texture Mixer' },
  comment: 'Blends two texture inputs by an opacity slider. Demonstrates multi-texture input and simple per-pixel math.',
  entryPoint: 'fn_main_cpu',
  inputs: [
    { id: 'tex_a', type: 'texture2d', format: 'rgba8', label: 'Layer A', comment: 'First input texture.' },
    { id: 'tex_b', type: 'texture2d', format: 'rgba8', label: 'Layer B', comment: 'Second input texture.' },
    { id: 'opacity', type: 'float', default: 0.5, ui: { min: 0.0, max: 1.0, widget: 'slider' }, comment: 'Blend factor: 0 = Layer A, 1 = Layer B.' }
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
        { id: 'dispatch', op: 'cmd_dispatch', func: 'fn_mix_gpu', threads: 'size' }
      ]
    },
    {
      id: 'fn_mix_gpu',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      comment: 'Compute kernel: per-pixel blend of two textures.',
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },

        { id: 'col_a', op: 'texture_sample', tex: 'tex_a', coords: 'nuv.xy' },
        { id: 'col_b', op: 'texture_sample', tex: 'tex_b', coords: 'nuv.xy' },

        { id: 'val_opacity', op: 'var_get', var: 'opacity' },
        { id: 'mixed', op: 'math_mix', a: 'col_a', b: 'col_b', t: 'val_opacity', comment: 'Linear blend: mix(A, B, opacity)' },

        { id: 'store', op: 'texture_store', tex: 'output_mix', coords: 'gid.xy', value: 'mixed' }
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
    },
    {
      id: 'sdf_vol',
      type: 'buffer',
      comment: '32x32x32 SDF volume stored as flat 1D buffer',
      dataType: 'float',
      size: { mode: 'fixed', value: 32768 },
      persistence: {
        retain: true,
        clearOnResize: false,
        clearEveryFrame: false,
        clearValue: 4.0,
        cpuAccess: false,
      },
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
        { id: 'dispatch_evolve', op: 'cmd_dispatch', func: 'fn_evolve_sdf', threads: [32, 32, 32], exec_out: 'dispatch_render' },
        { id: 'size', op: 'resource_get_size', resource: 'output_ray' },
        { id: 'dispatch_render', op: 'cmd_dispatch', func: 'fn_ray_gpu', threads: 'size' }
      ]
    },
    {
      id: 'fn_evolve_sdf',
      type: 'shader',
      comment: 'Evolve SDF volume: Laplacian diffusion across 6 neighbors for liquid spreading, pulsing sphere stamp, gradual decay.',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'c_grid', op: 'comment', comment: 'Convert global_invocation_id to world-space position: (float3(gid) + 0.5) / 16.0 - 1.0 maps [0,31] to [-1,1].' },
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'gid_f', op: 'static_cast_float3', val: 'gid' },
        { id: 'gid_off', op: 'math_add', a: 'gid_f', b: 0.5 },
        { id: 'gid_norm', op: 'math_div', a: 'gid_off', b: 16.0 },
        { id: 'world_p', op: 'math_sub', a: 'gid_norm', b: 1.0 },

        { id: 'c_sphere', op: 'comment', comment: 'Pulsing sphere: radius oscillates with sin(time*2.5), creating periodic expansion/contraction.' },
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
        { id: 'p_sub_c', op: 'math_sub', a: 'world_p', b: 'sphere_center' },
        { id: 'len_psc', op: 'vec_length', a: 'p_sub_c' },
        { id: 'base_radius', op: 'var_get', var: 'scale' },
        { id: 't_pulse', op: 'math_mul', a: 'val_time', b: 2.5 },
        { id: 'sin_pulse', op: 'math_sin', val: 't_pulse' },
        { id: 'pulse_mod', op: 'math_mul', a: 'sin_pulse', b: 0.3 },
        { id: 'pulse_fac', op: 'math_add', a: 0.7, b: 'pulse_mod' },
        { id: 'sphere_radius', op: 'math_mul', a: 'base_radius', b: 'pulse_fac' },
        { id: 'd_sphere', op: 'math_sub', a: 'len_psc', b: 'sphere_radius' },

        { id: 'c_index', op: 'comment', comment: 'Flat buffer index via int dot product: dot(gid, int3(1, 32, 1024)). 6 clamped neighbor indices for diffusion.' },
        { id: 'strides', op: 'int3', x: 1, y: 32, z: 1024 },
        { id: 'flat_idx', op: 'vec_dot', a: 'gid', b: 'strides' },

        { id: 'c_nbr', op: 'comment', comment: 'Clamped neighbor coordinates (int) for 6-connected Laplacian, then dot with strides for flat index.' },
        { id: 'gx_m1r', op: 'math_sub', a: 'gid.x', b: 1 },
        { id: 'gx_m1', op: 'math_max', a: 'gx_m1r', b: 0 },
        { id: 'gx_p1r', op: 'math_add', a: 'gid.x', b: 1 },
        { id: 'gx_p1', op: 'math_min', a: 'gx_p1r', b: 31 },
        { id: 'gy_m1r', op: 'math_sub', a: 'gid.y', b: 1 },
        { id: 'gy_m1', op: 'math_max', a: 'gy_m1r', b: 0 },
        { id: 'gy_p1r', op: 'math_add', a: 'gid.y', b: 1 },
        { id: 'gy_p1', op: 'math_min', a: 'gy_p1r', b: 31 },
        { id: 'gz_m1r', op: 'math_sub', a: 'gid.z', b: 1 },
        { id: 'gz_m1', op: 'math_max', a: 'gz_m1r', b: 0 },
        { id: 'gz_p1r', op: 'math_add', a: 'gid.z', b: 1 },
        { id: 'gz_p1', op: 'math_min', a: 'gz_p1r', b: 31 },

        { id: 'nbr_xm', op: 'int3', x: 'gx_m1', y: 'gid.y', z: 'gid.z' },
        { id: 'ixm', op: 'vec_dot', a: 'nbr_xm', b: 'strides' },
        { id: 'nbr_xp', op: 'int3', x: 'gx_p1', y: 'gid.y', z: 'gid.z' },
        { id: 'ixp', op: 'vec_dot', a: 'nbr_xp', b: 'strides' },
        { id: 'nbr_ym', op: 'int3', x: 'gid.x', y: 'gy_m1', z: 'gid.z' },
        { id: 'iym', op: 'vec_dot', a: 'nbr_ym', b: 'strides' },
        { id: 'nbr_yp', op: 'int3', x: 'gid.x', y: 'gy_p1', z: 'gid.z' },
        { id: 'iyp', op: 'vec_dot', a: 'nbr_yp', b: 'strides' },
        { id: 'nbr_zm', op: 'int3', x: 'gid.x', y: 'gid.y', z: 'gz_m1' },
        { id: 'izm', op: 'vec_dot', a: 'nbr_zm', b: 'strides' },
        { id: 'nbr_zp', op: 'int3', x: 'gid.x', y: 'gid.y', z: 'gz_p1' },
        { id: 'izp', op: 'vec_dot', a: 'nbr_zp', b: 'strides' },

        { id: 'c_diffuse', op: 'comment', comment: 'Load self + 6 neighbors, compute Laplacian diffusion for liquid spreading.' },
        { id: 'self_val', op: 'buffer_load', buffer: 'sdf_vol', index: 'flat_idx' },
        { id: 'n_xm', op: 'buffer_load', buffer: 'sdf_vol', index: 'ixm' },
        { id: 'n_xp', op: 'buffer_load', buffer: 'sdf_vol', index: 'ixp' },
        { id: 'n_ym', op: 'buffer_load', buffer: 'sdf_vol', index: 'iym' },
        { id: 'n_yp', op: 'buffer_load', buffer: 'sdf_vol', index: 'iyp' },
        { id: 'n_zm', op: 'buffer_load', buffer: 'sdf_vol', index: 'izm' },
        { id: 'n_zp', op: 'buffer_load', buffer: 'sdf_vol', index: 'izp' },
        { id: 'sum_x', op: 'math_add', a: 'n_xm', b: 'n_xp' },
        { id: 'sum_y', op: 'math_add', a: 'n_ym', b: 'n_yp' },
        { id: 'sum_z', op: 'math_add', a: 'n_zm', b: 'n_zp' },
        { id: 'sum_xy', op: 'math_add', a: 'sum_x', b: 'sum_y' },
        { id: 'sum_all', op: 'math_add', a: 'sum_xy', b: 'sum_z' },
        { id: 'avg_nbr', op: 'math_div', a: 'sum_all', b: 6.0 },

        { id: 'c_noise', op: 'comment', comment: 'Spatiotemporal hash noise: fract(sin(dot(p*freq + time*drift, magic)) * 43758.5). Two channels for rate modulation + SDF perturbation.' },
        { id: 'wp_freq', op: 'math_mul', a: 'world_p', b: 7.3 },
        { id: 'time_drift', op: 'float3', x: 1.7, y: 2.3, z: 0.9 },
        { id: 'time_off', op: 'math_mul', a: 'val_time', b: 'time_drift' },
        { id: 'hash_pos', op: 'math_add', a: 'wp_freq', b: 'time_off' },
        { id: 'hash_dir', op: 'float3', x: 127.1, y: 311.7, z: 74.7 },
        { id: 'hash_dot', op: 'vec_dot', a: 'hash_pos', b: 'hash_dir' },
        { id: 'hash_sin', op: 'math_sin', val: 'hash_dot' },
        { id: 'hash_sc', op: 'math_mul', a: 'hash_sin', b: 43758.5453 },
        { id: 'noise1', op: 'math_fract', val: 'hash_sc' },
        { id: 'hash_dot2', op: 'math_add', a: 'hash_dot', b: 37.0, comment: 'Second noise channel (offset hash)' },
        { id: 'hash_sin2', op: 'math_sin', val: 'hash_dot2' },
        { id: 'hash_sc2', op: 'math_mul', a: 'hash_sin2', b: 43758.5453 },
        { id: 'noise2', op: 'math_fract', val: 'hash_sc2' },

        { id: 'c_evolve', op: 'comment', comment: 'Noisy diffusion: rate 4-16x (noise1), SDF perturbation ±7.5/s (noise2), noisy decay 0.5-4.5/s (noise1) for wispy chaos.' },
        { id: 'dt', op: 'builtin_get', name: 'delta_time' },
        { id: 'lap', op: 'math_sub', a: 'avg_nbr', b: 'self_val' },
        { id: 'noisy_rate', op: 'math_mul', a: 'noise1', b: 12.0 },
        { id: 'rate', op: 'math_add', a: 4.0, b: 'noisy_rate' },
        { id: 'rate_dt', op: 'math_mul', a: 'rate', b: 'dt' },
        { id: 'lap_step', op: 'math_mul', a: 'rate_dt', b: 'lap' },
        { id: 'diffused', op: 'math_add', a: 'self_val', b: 'lap_step' },
        { id: 'n2_centered', op: 'math_sub', a: 'noise2', b: 0.5 },
        { id: 'perturb_raw', op: 'math_mul', a: 'n2_centered', b: 15.0, comment: '±7.5/s direct SDF perturbation — large enough to visibly ripple the surface' },
        { id: 'perturb', op: 'math_mul', a: 'perturb_raw', b: 'dt' },
        { id: 'perturbed', op: 'math_add', a: 'diffused', b: 'perturb' },
        { id: 'noisy_decay', op: 'math_mul', a: 'noise1', b: 4.0, comment: 'Noisy decay [0.5, 4.5]: some areas persist (tendrils), others vanish fast' },
        { id: 'decay_rate', op: 'math_add', a: 0.5, b: 'noisy_decay' },
        { id: 'decay_step', op: 'math_mul', a: 'decay_rate', b: 'dt' },
        { id: 'decayed', op: 'math_add', a: 'perturbed', b: 'decay_step' },
        { id: 'stamped', op: 'math_min', a: 'd_sphere', b: 'decayed' },
        { id: 'new_val', op: 'math_min', a: 'stamped', b: 2.0 },
        { id: 'store', op: 'buffer_store', buffer: 'sdf_vol', index: 'flat_idx', value: 'new_val' },
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
        { id: 'c_setup', op: 'comment', comment: 'Setup: screen coords, UV, aspect ratio. normalized_global_invocation_id gives [0,1] UV directly.' },
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },
        { id: 'size', op: 'resource_get_size', resource: 'output_ray' },
        { id: 'uv_2', op: 'math_mul', a: 'nuv.xy', b: 2.0 },
        { id: 'uv', op: 'math_sub', a: 'uv_2', b: 1.0 },
        { id: 'aspect', op: 'math_div', a: 'size.x', b: 'size.y' },

        { id: 'c_camera', op: 'comment', comment: 'Camera: slightly elevated, looking down toward scene. uv.y is negated to flip screen-space y (top-down) to world y (up).' },
        { id: 'ro', op: 'float3', x: 0.0, y: 1.0, z: -3.0 },
        { id: 'uv_y_flip', op: 'math_mul', a: 'uv.y', b: -1.0, comment: 'Flip y: screen-down to world-up' },
        { id: 'rd_x', op: 'math_mul', a: 'uv.x', b: 'aspect' },
        { id: 'rd_y', op: 'math_sub', a: 'uv_y_flip', b: 0.3 },
        { id: 'rd_raw', op: 'float3', x: 'rd_x', y: 'rd_y', z: 1.5 },
        { id: 'rd', op: 'vec_normalize', a: 'rd_raw' },

        { id: 'c_anim', op: 'comment', comment: 'Animation: sphere orbits in xz plane, bobs vertically. Uses builtin time.' },
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
        { id: 'k_sm', op: 'literal', val: 0.4, comment: 'Smooth min blending radius' },

        { id: 'c_march', op: 'comment', comment: 'Init loop variables and start march (80 steps).' },
        { id: 't_init', op: 'var_set', var: 't', val: 0.01, exec_out: 'hit_init' },
        { id: 'hit_init', op: 'var_set', var: 'hit', val: 0.0, exec_out: 'march_loop' },
        {
          id: 'march_loop',
          op: 'flow_loop',
          count: 80,
          exec_body: 'body_anchor',
          exec_completed: 'final_store'
        },

        { id: 'c_sdf', op: 'comment', comment: 'Loop body: evaluate SDF (sphere + ground plane with smooth min).' },
        { id: 'cur_t', op: 'var_get', var: 't' },
        { id: 'cur_ray', op: 'math_mul', a: 'rd', b: 'cur_t' },
        { id: 'cur_p', op: 'math_add', a: 'ro', b: 'cur_ray', comment: 'Current point along ray' },

        { id: 'c_vol_lookup', op: 'comment', comment: 'Trilinear SDF lookup: continuous grid coords centered on voxels, 8-sample interpolation.' },
        { id: 'grid_offset', op: 'math_add', a: 'cur_p', b: 1.0 },
        { id: 'grid_scaled', op: 'math_mul', a: 'grid_offset', b: 16.0 },
        { id: 'grid_cont', op: 'math_sub', a: 'grid_scaled', b: 0.5, comment: 'Center on voxels: voxel i covers [i, i+1), center at i+0.5' },
        { id: 'grid_base', op: 'math_floor', val: 'grid_cont' },
        { id: 'grid_frac', op: 'math_sub', a: 'grid_cont', b: 'grid_base' },
        { id: 'base_cl', op: 'math_clamp', val: 'grid_base', min: 0.0, max: 31.0 },
        { id: 'grid_next', op: 'math_add', a: 'grid_base', b: 1.0 },
        { id: 'next_cl', op: 'math_clamp', val: 'grid_next', min: 0.0, max: 31.0 },

        { id: 'c_trilin_idx', op: 'comment', comment: 'Inline swizzles extract x/y/z from base_cl, next_cl, grid_frac for 8 flat indices.' },
        { id: 'bz_k', op: 'math_mul', a: 'base_cl.z', b: 1024.0 },
        { id: 'nz_k', op: 'math_mul', a: 'next_cl.z', b: 1024.0 },
        { id: 'by_32', op: 'math_mul', a: 'base_cl.y', b: 32.0 },
        { id: 'ny_32', op: 'math_mul', a: 'next_cl.y', b: 32.0 },
        { id: 'zy_bb', op: 'math_add', a: 'bz_k', b: 'by_32' },
        { id: 'zy_bn', op: 'math_add', a: 'bz_k', b: 'ny_32' },
        { id: 'zy_nb', op: 'math_add', a: 'nz_k', b: 'by_32' },
        { id: 'zy_nn', op: 'math_add', a: 'nz_k', b: 'ny_32' },
        { id: 'i000f', op: 'math_add', a: 'zy_bb', b: 'base_cl.x' },
        { id: 'i000', op: 'static_cast_int', val: 'i000f' },
        { id: 'i100f', op: 'math_add', a: 'zy_bb', b: 'next_cl.x' },
        { id: 'i100', op: 'static_cast_int', val: 'i100f' },
        { id: 'i010f', op: 'math_add', a: 'zy_bn', b: 'base_cl.x' },
        { id: 'i010', op: 'static_cast_int', val: 'i010f' },
        { id: 'i110f', op: 'math_add', a: 'zy_bn', b: 'next_cl.x' },
        { id: 'i110', op: 'static_cast_int', val: 'i110f' },
        { id: 'i001f', op: 'math_add', a: 'zy_nb', b: 'base_cl.x' },
        { id: 'i001', op: 'static_cast_int', val: 'i001f' },
        { id: 'i101f', op: 'math_add', a: 'zy_nb', b: 'next_cl.x' },
        { id: 'i101', op: 'static_cast_int', val: 'i101f' },
        { id: 'i011f', op: 'math_add', a: 'zy_nn', b: 'base_cl.x' },
        { id: 'i011', op: 'static_cast_int', val: 'i011f' },
        { id: 'i111f', op: 'math_add', a: 'zy_nn', b: 'next_cl.x' },
        { id: 'i111', op: 'static_cast_int', val: 'i111f' },

        { id: 'c_trilin_lerp', op: 'comment', comment: 'Load 8 corners and trilinearly interpolate: x lerps, then y, then z.' },
        { id: 'c000', op: 'buffer_load', buffer: 'sdf_vol', index: 'i000' },
        { id: 'c100', op: 'buffer_load', buffer: 'sdf_vol', index: 'i100' },
        { id: 'c010', op: 'buffer_load', buffer: 'sdf_vol', index: 'i010' },
        { id: 'c110', op: 'buffer_load', buffer: 'sdf_vol', index: 'i110' },
        { id: 'c001', op: 'buffer_load', buffer: 'sdf_vol', index: 'i001' },
        { id: 'c101', op: 'buffer_load', buffer: 'sdf_vol', index: 'i101' },
        { id: 'c011', op: 'buffer_load', buffer: 'sdf_vol', index: 'i011' },
        { id: 'c111', op: 'buffer_load', buffer: 'sdf_vol', index: 'i111' },
        { id: 'cx00', op: 'math_mix', a: 'c000', b: 'c100', t: 'grid_frac.x' },
        { id: 'cx10', op: 'math_mix', a: 'c010', b: 'c110', t: 'grid_frac.x' },
        { id: 'cx01', op: 'math_mix', a: 'c001', b: 'c101', t: 'grid_frac.x' },
        { id: 'cx11', op: 'math_mix', a: 'c011', b: 'c111', t: 'grid_frac.x' },
        { id: 'cxy0', op: 'math_mix', a: 'cx00', b: 'cx10', t: 'grid_frac.y' },
        { id: 'cxy1', op: 'math_mix', a: 'cx01', b: 'cx11', t: 'grid_frac.y' },
        { id: 'd_vol', op: 'math_mix', a: 'cxy0', b: 'cxy1', t: 'grid_frac.z' },

        { id: 'c_edge', op: 'comment', comment: 'Box SDF clamps volume at grid boundary: max(interpolated, box_sdf) prevents extrusions at edges.' },
        { id: 'abs_p', op: 'math_abs', val: 'cur_p' },
        { id: 'q_edge', op: 'math_sub', a: 'abs_p', b: 1.0 },
        { id: 'qx_pos', op: 'math_max', a: 'q_edge.x', b: 0.0 },
        { id: 'qy_pos', op: 'math_max', a: 'q_edge.y', b: 0.0 },
        { id: 'qz_pos', op: 'math_max', a: 'q_edge.z', b: 0.0 },
        { id: 'q_pos', op: 'float3', x: 'qx_pos', y: 'qy_pos', z: 'qz_pos' },
        { id: 'len_q', op: 'vec_length', a: 'q_pos' },
        { id: 'max_qxy', op: 'math_max', a: 'q_edge.x', b: 'q_edge.y' },
        { id: 'max_qxyz', op: 'math_max', a: 'max_qxy', b: 'q_edge.z' },
        { id: 'q_interior', op: 'math_min', a: 'max_qxyz', b: 0.0 },
        { id: 'd_box', op: 'math_add', a: 'len_q', b: 'q_interior' },
        { id: 'd_sphere', op: 'math_max', a: 'd_vol', b: 'd_box' },

        { id: 'd_plane', op: 'math_add', a: 'cur_p.y', b: 0.5, comment: 'Ground plane SDF: p.y + 0.5' },

        { id: 'sm_diff', op: 'math_sub', a: 'd_sphere', b: 'd_plane', comment: 'Smooth min: h = clamp(0.5 + 0.5*(a-b)/k, 0, 1); mix(a,b,h) - k*h*(1-h)' },
        { id: 'sm_div', op: 'math_div', a: 'sm_diff', b: 'k_sm' },
        { id: 'sm_half', op: 'math_mul', a: 'sm_div', b: 0.5 },
        { id: 'sm_raw', op: 'math_add', a: 'sm_half', b: 0.5 },
        { id: 'sm_h', op: 'math_clamp', val: 'sm_raw', min: 0.0, max: 1.0 },
        { id: 'sm_lerp', op: 'math_mix', a: 'd_sphere', b: 'd_plane', t: 'sm_h' },
        { id: 'sm_inv', op: 'math_sub', a: 1.0, b: 'sm_h' },
        { id: 'sm_prod', op: 'math_mul', a: 'sm_h', b: 'sm_inv' },
        { id: 'sm_corr', op: 'math_mul', a: 'k_sm', b: 'sm_prod' },

        { id: 'body_anchor', op: 'math_sub', a: 'sm_lerp', b: 'sm_corr', exec_out: 'branch_hit', comment: 'Total SDF distance; also exec anchor for loop body' },

        { id: 'is_hit', op: 'math_lt', a: 'body_anchor', b: 0.001, comment: 'Hit check: distance < threshold' },
        {
          id: 'branch_hit',
          op: 'flow_branch',
          cond: 'is_hit',
          exec_true: 'set_hit',
          exec_false: 'advance_t'
        },
        { id: 'set_hit', op: 'var_set', var: 'hit', val: 1.0 },

        { id: 'next_t', op: 'math_add', a: 'cur_t', b: 'body_anchor', comment: 'Miss: advance ray by SDF distance' },
        { id: 'advance_t', op: 'var_set', var: 't', val: 'next_t' },

        { id: 'c_hitpoint', op: 'comment', comment: 'Post-loop: compute hit point and recompute blend factor for shading.' },
        { id: 'final_t', op: 'var_get', var: 't' },
        { id: 'hit_ray', op: 'math_mul', a: 'rd', b: 'final_t' },
        { id: 'hit_p', op: 'math_add', a: 'ro', b: 'hit_ray' },

        { id: 'hp_sub_c', op: 'math_sub', a: 'hit_p', b: 'sphere_center', comment: 'Recompute distances at hit point for blend factor' },
        { id: 'hp_len', op: 'vec_length', a: 'hp_sub_c' },
        { id: 'hp_d_sphere', op: 'math_sub', a: 'hp_len', b: 'sphere_radius' },
        { id: 'hp_d_plane', op: 'math_add', a: 'hit_p.y', b: 0.5 },

        { id: 'bl_diff', op: 'math_sub', a: 'hp_d_sphere', b: 'hp_d_plane', comment: 'Blend factor (same smin formula): 0 = sphere, 1 = plane' },
        { id: 'bl_div', op: 'math_div', a: 'bl_diff', b: 'k_sm' },
        { id: 'bl_half', op: 'math_mul', a: 'bl_div', b: 0.5 },
        { id: 'bl_raw', op: 'math_add', a: 'bl_half', b: 0.5 },
        { id: 'blend_h', op: 'math_clamp', val: 'bl_raw', min: 0.0, max: 1.0 },

        { id: 'c_normals', op: 'comment', comment: 'Normals: analytical blend of sphere normal and plane normal by smin factor.' },
        { id: 'sphere_norm', op: 'vec_normalize', a: 'hp_sub_c' },
        { id: 'plane_norm', op: 'float3', x: 0.0, y: 1.0, z: 0.0 },
        { id: 'blended_norm', op: 'math_mix', a: 'sphere_norm', b: 'plane_norm', t: 'blend_h' },
        { id: 'normal', op: 'vec_normalize', a: 'blended_norm' },

        { id: 'c_surface', op: 'comment', comment: 'Surface color: warm orange sphere + checkerboard floor, blended by smin proximity.' },
        { id: 'sphere_col', op: 'float3', x: 0.9, y: 0.45, z: 0.2 },
        { id: 'floor_x', op: 'math_floor', val: 'hit_p.x', comment: 'Checkerboard: fract((floor(x) + floor(z)) * 0.5) * 2' },
        { id: 'floor_z', op: 'math_floor', val: 'hit_p.z' },
        { id: 'floor_sum', op: 'math_add', a: 'floor_x', b: 'floor_z' },
        { id: 'floor_half', op: 'math_mul', a: 'floor_sum', b: 0.5 },
        { id: 'floor_frac', op: 'math_fract', val: 'floor_half' },
        { id: 'checker', op: 'math_mul', a: 'floor_frac', b: 2.0 },
        { id: 'floor_dark', op: 'float3', x: 0.35, y: 0.35, z: 0.4 },
        { id: 'floor_light', op: 'float3', x: 0.55, y: 0.55, z: 0.6 },
        { id: 'floor_col', op: 'math_mix', a: 'floor_dark', b: 'floor_light', t: 'checker' },
        { id: 'surface_col', op: 'math_mix', a: 'sphere_col', b: 'floor_col', t: 'blend_h' },

        { id: 'c_lighting', op: 'comment', comment: 'Lighting: Lambert diffuse + Blinn-Phong specular with directional light.' },
        { id: 'light_raw', op: 'float3', x: 0.6, y: 0.8, z: -0.4 },
        { id: 'light_dir', op: 'vec_normalize', a: 'light_raw' },
        { id: 'ndotl_raw', op: 'vec_dot', a: 'normal', b: 'light_dir' },
        { id: 'ndotl', op: 'math_max', a: 'ndotl_raw', b: 0.05 },
        { id: 'neg_rd', op: 'math_mul', a: 'rd', b: -1.0, comment: 'Specular: half-vector method' },
        { id: 'half_raw', op: 'math_add', a: 'light_dir', b: 'neg_rd' },
        { id: 'half_dir', op: 'vec_normalize', a: 'half_raw' },
        { id: 'ndoth_raw', op: 'vec_dot', a: 'normal', b: 'half_dir' },
        { id: 'ndoth', op: 'math_max', a: 'ndoth_raw', b: 0.0 },
        { id: 'spec_pow', op: 'math_pow', a: 'ndoth', b: 32.0 },
        { id: 'specular', op: 'math_mul', a: 'spec_pow', b: 0.4 },
        { id: 'diff_contrib', op: 'math_mul', a: 'surface_col', b: 'ndotl', comment: 'Combine diffuse and specular' },
        { id: 'spec_vec', op: 'float3', xyz: 'specular' },
        { id: 'lit_color', op: 'math_add', a: 'diff_contrib', b: 'spec_vec' },

        { id: 'c_fog', op: 'comment', comment: 'Exponential distance fog blending to blue-grey sky.' },
        { id: 'fog_neg', op: 'math_mul', a: 'final_t', b: -0.15 },
        { id: 'fog_fac', op: 'math_exp', val: 'fog_neg' },
        { id: 'fog_col', op: 'float3', x: 0.55, y: 0.62, z: 0.78 },
        { id: 'fogged', op: 'math_mix', a: 'fog_col', b: 'lit_color', t: 'fog_fac' },

        { id: 'c_output', op: 'comment', comment: 'Final output: blend hit/miss by hit flag, write to texture.' },
        { id: 'did_hit', op: 'var_get', var: 'hit' },
        { id: 'final_rgb', op: 'math_mix', a: 'fog_col', b: 'fogged', t: 'did_hit' },
        { id: 'out_rgba', op: 'float4', xyz: 'final_rgb', w: 1.0 },
        { id: 'final_store', op: 'texture_store', tex: 'output_ray', coords: 'gid.xy', value: 'out_rgba' }
      ]
    }
  ]
};

export const PARTICLE_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Particle Simulation' },
  comment: 'Compute-based particle simulation with vertex/fragment rendering. Demonstrates struct-typed buffers, aspect ratio correction, cmd_draw with additive blending, hash noise, branchless selection via math_mix, and per-particle quad generation in vertex shader.',
  entryPoint: 'fn_main_cpu',

  inputs: [
    { id: 'particle_count', type: 'float', default: 1000, ui: { min: 1, max: 1000000, widget: 'slider' }, comment: 'Number of active particles (max 1M).' }
  ],

  structs: [
    {
      id: 'Particle',
      members: [
        { name: 'pos', type: 'float2' as DataType },
        { name: 'vel', type: 'float2' as DataType },
        { name: 'lifetime', type: 'float' as DataType },
        { name: 'age', type: 'float' as DataType }
      ]
    },
    {
      id: 'VertexOutput',
      members: [
        { name: 'pos', type: 'float4' as DataType, builtin: 'position' as BuiltinName },
        { name: 'quad_uv', type: 'float2' as DataType, location: 0 },
        { name: 'age_ratio', type: 'float' as DataType, location: 1 }
      ]
    }
  ],

  resources: [
    {
      id: 'output_tex',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'viewport' },
      isOutput: true,
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
    },
    {
      id: 'particles',
      type: 'buffer',
      comment: 'Struct-typed particle buffer: up to 1M Particle structs {pos, vel, lifetime, age}. Starts zeroed so age(0) >= lifetime(0) triggers immediate respawn.',
      dataType: 'Particle',
      size: { mode: 'fixed', value: 1000000 },
      persistence: {
        retain: true,
        clearOnResize: false,
        clearEveryFrame: false,
        cpuAccess: false,
      },
    }
  ],

  functions: [
    {
      id: 'fn_main_cpu',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      comment: 'CPU entry: dispatch particle simulation (N compute threads), then draw particle quads (N*6 vertices).',
      nodes: [
        { id: 'pc', op: 'var_get', var: 'particle_count' },
        { id: 'pc_int', op: 'static_cast_int', val: 'pc' },
        { id: 'dispatch_sim', op: 'cmd_dispatch', func: 'fn_simulate_gpu', threads: ['pc_int', 1, 1], exec_out: 'draw_particles' },
        { id: 'vert_count_f', op: 'math_mul', a: 'pc', b: 6, comment: '6 vertices per particle (2 triangles per quad).' },
        { id: 'vert_count', op: 'static_cast_int', val: 'vert_count_f' },
        {
          id: 'draw_particles',
          op: 'cmd_draw',
          target: 'output_tex',
          vertex: 'fn_vertex',
          fragment: 'fn_fragment',
          count: 'vert_count',
          pipeline: {
            topology: 'triangle-list',
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
            }
          }
        }
      ]
    },
    {
      id: 'fn_simulate_gpu',
      type: 'shader',
      comment: 'Per-particle simulation: load Particle struct, physics with noise drift and aspect correction, branchless dead/alive selection via math_mix, store back. 1 thread per particle.',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'dt', op: 'builtin_get', name: 'delta_time' },
        { id: 'time', op: 'builtin_get', name: 'time' },
        { id: 'gid_x_f', op: 'static_cast_float', val: 'gid.x', comment: 'global_invocation_id is int3; cast to float for hash seed.' },

        { id: 'c_aspect', op: 'comment', comment: 'Aspect ratio from output texture size: scale X velocity so equal magnitude = equal pixel distance.' },
        { id: 'os', op: 'resource_get_size', resource: 'output_tex' },
        { id: 'os_x', op: 'static_cast_float', val: 'os.x' },
        { id: 'os_y', op: 'static_cast_float', val: 'os.y' },
        { id: 'aspect', op: 'math_div', a: 'os_x', b: 'os_y' },
        { id: 'inv_aspect', op: 'math_div', a: 1.0, b: 'aspect' },

        { id: 'c_load', op: 'comment', comment: 'Load Particle struct from buffer.' },
        { id: 'particle', op: 'buffer_load', buffer: 'particles', index: 'gid.x' },
        { id: 'ld_pos', op: 'struct_extract', struct: 'particle', field: 'pos' },
        { id: 'ld_vel', op: 'struct_extract', struct: 'particle', field: 'vel' },
        { id: 'ld_lt', op: 'struct_extract', struct: 'particle', field: 'lifetime' },
        { id: 'ld_age', op: 'struct_extract', struct: 'particle', field: 'age' },

        { id: 'is_dead', op: 'math_step', edge: 'ld_lt', x: 'ld_age', comment: 'step(lifetime, age) = 1.0 when dead. step(0,0)=1 so initially all particles respawn.' },

        { id: 'c_respawn', op: 'comment', comment: 'Hash noise for 5 respawn channels: fract(sin(seed + offset) * 43758.5453).' },
        { id: 'seed_base', op: 'math_mul', a: 'gid_x_f', b: 127.1 },
        { id: 'seed', op: 'math_add', a: 'seed_base', b: 'time' },
        { id: 'sin_r1', op: 'math_sin', val: 'seed' },
        { id: 'sc_r1', op: 'math_mul', a: 'sin_r1', b: 43758.5453 },
        { id: 'r1', op: 'math_fract', val: 'sc_r1' },
        { id: 'seed_r2', op: 'math_add', a: 'seed', b: 1.0 },
        { id: 'sin_r2', op: 'math_sin', val: 'seed_r2' },
        { id: 'sc_r2', op: 'math_mul', a: 'sin_r2', b: 43758.5453 },
        { id: 'r2', op: 'math_fract', val: 'sc_r2' },
        { id: 'seed_r3', op: 'math_add', a: 'seed', b: 2.0 },
        { id: 'sin_r3', op: 'math_sin', val: 'seed_r3' },
        { id: 'sc_r3', op: 'math_mul', a: 'sin_r3', b: 43758.5453 },
        { id: 'r3', op: 'math_fract', val: 'sc_r3' },
        { id: 'seed_r4', op: 'math_add', a: 'seed', b: 3.0 },
        { id: 'sin_r4', op: 'math_sin', val: 'seed_r4' },
        { id: 'sc_r4', op: 'math_mul', a: 'sin_r4', b: 43758.5453 },
        { id: 'r4', op: 'math_fract', val: 'sc_r4' },
        { id: 'seed_r5', op: 'math_add', a: 'seed', b: 4.0 },
        { id: 'sin_r5', op: 'math_sin', val: 'seed_r5' },
        { id: 'sc_r5', op: 'math_mul', a: 'sin_r5', b: 43758.5453 },
        { id: 'r5', op: 'math_fract', val: 'sc_r5' },

        { id: 'c_resp_val', op: 'comment', comment: 'Respawn values: random position [0,1], velocity [-0.1,0.1] (X scaled by 1/aspect), lifetime [1,5]s.' },
        { id: 'r3_c', op: 'math_sub', a: 'r3', b: 0.5 },
        { id: 'resp_vx_raw', op: 'math_mul', a: 'r3_c', b: 0.2 },
        { id: 'resp_vx', op: 'math_mul', a: 'resp_vx_raw', b: 'inv_aspect' },
        { id: 'r4_c', op: 'math_sub', a: 'r4', b: 0.5 },
        { id: 'resp_vy', op: 'math_mul', a: 'r4_c', b: 0.2 },
        { id: 'lt_scale', op: 'math_mul', a: 'r5', b: 4.0 },
        { id: 'resp_lt', op: 'math_add', a: 'lt_scale', b: 1.0 },

        { id: 'c_drift', op: 'comment', comment: 'Drift noise: separate hash family for per-frame velocity perturbation.' },
        { id: 'drift_base', op: 'math_mul', a: 'gid_x_f', b: 73.7 },
        { id: 'drift_seed', op: 'math_add', a: 'drift_base', b: 'time' },
        { id: 'sin_d1', op: 'math_sin', val: 'drift_seed' },
        { id: 'sc_d1', op: 'math_mul', a: 'sin_d1', b: 43758.5453 },
        { id: 'drift1', op: 'math_fract', val: 'sc_d1' },
        { id: 'drift_seed2', op: 'math_add', a: 'drift_seed', b: 37.0 },
        { id: 'sin_d2', op: 'math_sin', val: 'drift_seed2' },
        { id: 'sc_d2', op: 'math_mul', a: 'sin_d2', b: 43758.5453 },
        { id: 'drift2', op: 'math_fract', val: 'sc_d2' },

        { id: 'c_physics', op: 'comment', comment: 'Euler integration: velocity drift (X scaled by 1/aspect) + gentle gravity, position update.' },
        { id: 'dvx_raw', op: 'math_sub', a: 'drift1', b: 0.5 },
        { id: 'dvx_scaled', op: 'math_mul', a: 'dvx_raw', b: 'inv_aspect' },
        { id: 'dvx', op: 'math_mul', a: 'dvx_scaled', b: 'dt' },
        { id: 'dvy_raw', op: 'math_sub', a: 'drift2', b: 0.5 },
        { id: 'dvy_drift', op: 'math_mul', a: 'dvy_raw', b: 'dt' },
        { id: 'gravity_dt', op: 'math_mul', a: 0.05, b: 'dt' },
        { id: 'dvy', op: 'math_sub', a: 'dvy_drift', b: 'gravity_dt' },
        { id: 'alive_vx', op: 'math_add', a: 'ld_vel.x', b: 'dvx' },
        { id: 'alive_vy', op: 'math_add', a: 'ld_vel.y', b: 'dvy' },
        { id: 'vx_dt', op: 'math_mul', a: 'alive_vx', b: 'dt' },
        { id: 'vy_dt', op: 'math_mul', a: 'alive_vy', b: 'dt' },
        { id: 'alive_px', op: 'math_add', a: 'ld_pos.x', b: 'vx_dt' },
        { id: 'alive_py', op: 'math_add', a: 'ld_pos.y', b: 'vy_dt' },
        { id: 'alive_age', op: 'math_add', a: 'ld_age', b: 'dt' },

        { id: 'c_select', op: 'comment', comment: 'Branchless dead/alive: mix(alive_val, respawn_val, is_dead). Both paths computed unconditionally.' },
        { id: 'final_px', op: 'math_mix', a: 'alive_px', b: 'r1', t: 'is_dead' },
        { id: 'final_py', op: 'math_mix', a: 'alive_py', b: 'r2', t: 'is_dead' },
        { id: 'final_vx', op: 'math_mix', a: 'alive_vx', b: 'resp_vx', t: 'is_dead' },
        { id: 'final_vy', op: 'math_mix', a: 'alive_vy', b: 'resp_vy', t: 'is_dead' },
        { id: 'final_lt', op: 'math_mix', a: 'ld_lt', b: 'resp_lt', t: 'is_dead' },
        { id: 'final_age', op: 'math_mix', a: 'alive_age', b: 0.0, t: 'is_dead' },

        { id: 'final_pos', op: 'float2', x: 'final_px', y: 'final_py' },
        { id: 'final_vel', op: 'float2', x: 'final_vx', y: 'final_vy' },
        { id: 'new_particle', op: 'struct_construct', type: 'Particle', values: { pos: 'final_pos', vel: 'final_vel', lifetime: 'final_lt', age: 'final_age' } },
        { id: 'st_particle', op: 'buffer_store', buffer: 'particles', index: 'gid.x', value: 'new_particle' },
      ]
    },
    {
      id: 'fn_vertex',
      type: 'shader',
      comment: 'Vertex shader: generates a small quad (2 triangles, 6 verts) per particle. Reads Particle struct from buffer, outputs clip-space position (aspect-corrected) and varyings for fragment shader.',
      inputs: [
        { id: 'v_idx', type: 'int' as DataType, builtin: 'vertex_index' as BuiltinName }
      ],
      outputs: [
        { id: 'out', type: 'VertexOutput' as DataType }
      ],
      localVars: [],
      nodes: [
        { id: 'vi', op: 'var_get', var: 'v_idx' },
        { id: 'vi_f', op: 'static_cast_float', val: 'vi' },

        { id: 'c_index', op: 'comment', comment: 'Decompose vertex_index: particle_index = floor(vi/6), corner = vi % 6.' },
        { id: 'pidx_raw', op: 'math_div', a: 'vi_f', b: 6 },
        { id: 'pidx_f', op: 'math_floor', val: 'pidx_raw' },
        { id: 'pidx_i', op: 'static_cast_int', val: 'pidx_f' },
        { id: 'corner_f', op: 'math_mod', a: 'vi_f', b: 6 },
        { id: 'corner_i', op: 'static_cast_int', val: 'corner_f' },

        { id: 'c_quad', op: 'comment', comment: 'Quad corner offsets: 6 vertices forming 2 triangles. UV ranges [-1,1].' },
        { id: 'quad_x', op: 'array_construct', values: [-1, 1, -1, -1, 1, 1] },
        { id: 'quad_y', op: 'array_construct', values: [-1, -1, 1, 1, -1, 1] },
        { id: 'qx', op: 'array_extract', array: 'quad_x', index: 'corner_i' },
        { id: 'qy', op: 'array_extract', array: 'quad_y', index: 'corner_i' },

        { id: 'c_aspect', op: 'comment', comment: 'Aspect ratio from output_size builtin for square quads.' },
        { id: 'os', op: 'builtin_get', name: 'output_size' },
        { id: 'os_x', op: 'static_cast_float', val: 'os.x' },
        { id: 'os_y', op: 'static_cast_float', val: 'os.y' },
        { id: 'aspect', op: 'math_div', a: 'os_x', b: 'os_y' },
        { id: 'inv_aspect', op: 'math_div', a: 1.0, b: 'aspect' },

        { id: 'c_load', op: 'comment', comment: 'Load Particle struct from buffer.' },
        { id: 'particle', op: 'buffer_load', buffer: 'particles', index: 'pidx_i' },
        { id: 'p_pos', op: 'struct_extract', struct: 'particle', field: 'pos' },
        { id: 'p_lt', op: 'struct_extract', struct: 'particle', field: 'lifetime' },
        { id: 'p_age', op: 'struct_extract', struct: 'particle', field: 'age' },

        { id: 'c_clip', op: 'comment', comment: 'Convert particle [0,1] position to clip space [-1,1], offset by quad corner (X shrunk by 1/aspect for square quads).' },
        { id: 'cx_raw', op: 'math_mul', a: 'p_pos.x', b: 2.0 },
        { id: 'clip_x', op: 'math_sub', a: 'cx_raw', b: 1.0 },
        { id: 'cy_raw', op: 'math_mul', a: 'p_pos.y', b: 2.0 },
        { id: 'clip_y', op: 'math_sub', a: 'cy_raw', b: 1.0 },
        { id: 'ox_raw', op: 'math_mul', a: 'qx', b: 0.01 },
        { id: 'ox', op: 'math_mul', a: 'ox_raw', b: 'inv_aspect' },
        { id: 'oy', op: 'math_mul', a: 'qy', b: 0.01 },
        { id: 'final_x', op: 'math_add', a: 'clip_x', b: 'ox' },
        { id: 'final_y', op: 'math_add', a: 'clip_y', b: 'oy' },
        { id: 'pos', op: 'float4', x: 'final_x', y: 'final_y', z: 0.0, w: 1.0 },

        { id: 'quad_uv', op: 'float2', x: 'qx', y: 'qy' },
        { id: 'age_ratio', op: 'math_div', a: 'p_age', b: 'p_lt' },

        { id: 'ret_struct', op: 'struct_construct', type: 'VertexOutput', values: { pos: 'pos', quad_uv: 'quad_uv', age_ratio: 'age_ratio' } },
        { id: 'ret', op: 'func_return', val: 'ret_struct' }
      ]
    },
    {
      id: 'fn_fragment',
      type: 'shader',
      comment: 'Fragment shader: computes Gaussian falloff from quad UV and age fade. Additive blending accumulates overlapping particle contributions.',
      inputs: [
        { id: 'in', type: 'VertexOutput' as DataType }
      ],
      outputs: [
        { id: 'color', type: 'float4' as DataType }
      ],
      localVars: [],
      nodes: [
        { id: 'get_in', op: 'var_get', var: 'in' },
        { id: 'uv', op: 'struct_extract', struct: 'get_in', field: 'quad_uv' },
        { id: 'ar', op: 'struct_extract', struct: 'get_in', field: 'age_ratio' },

        { id: 'c_gauss', op: 'comment', comment: 'Gaussian falloff: exp(-4.5 * dist²) where UV spans [-1,1] across quad. σ≈1px at ~3px quad.' },
        { id: 'ux2', op: 'math_mul', a: 'uv.x', b: 'uv.x' },
        { id: 'uy2', op: 'math_mul', a: 'uv.y', b: 'uv.y' },
        { id: 'dist2', op: 'math_add', a: 'ux2', b: 'uy2' },
        { id: 'neg_d2', op: 'math_mul', a: 'dist2', b: -4.5 },
        { id: 'falloff', op: 'math_exp', val: 'neg_d2' },

        { id: 'c_age', op: 'comment', comment: 'Age fade: (1 - age_ratio)² — bright at birth, fades to zero at death.' },
        { id: 'inv_age', op: 'math_sub', a: 1.0, b: 'ar' },
        { id: 'brightness', op: 'math_mul', a: 'inv_age', b: 'inv_age' },

        { id: 'fb', op: 'math_mul', a: 'falloff', b: 'brightness' },
        { id: 'particle_col', op: 'float3', x: 1.0, y: 0.7, z: 0.3 },
        { id: 'rgb', op: 'math_mul', a: 'particle_col', b: 'fb' },
        { id: 'out_color', op: 'float4', xyz: 'rgb', w: 'fb', comment: 'Alpha = combined falloff for softer edges under additive blending.' },
        { id: 'ret', op: 'func_return', val: 'out_color' }
      ]
    }
  ]
};

export const HISTOGRAM_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'RGB Histogram' },
  comment: 'Builds an RGB histogram from an input texture using atomic counters on the GPU, then renders the histogram as an additive overlay in the bottom-right corner using cmd_draw with vertex/fragment shaders. Demonstrates atomic_add for concurrent binning, cmd_copy_buffer to move atomic data into readable buffers, and cmd_draw with blend modes.',
  entryPoint: 'fn_main_cpu',

  inputs: [
    { id: 'input_visual', type: 'texture2d', format: 'rgba8', comment: 'Input video/image stream.' }
  ],

  structs: [
    {
      id: 'HistVertex',
      members: [
        { name: 'pos', type: 'float4' as DataType, builtin: 'position' as BuiltinName },
        { name: 'color', type: 'float4' as DataType, location: 0 }
      ]
    }
  ],

  resources: [
    {
      id: 'output_tex',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'viewport' },
      isOutput: true,
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
    },
    {
      id: 'histogram',
      type: 'atomic_counter',
      dataType: 'int',
      size: { mode: 'fixed', value: 768 },
      comment: '256 bins x 3 channels (R: 0-255, G: 256-511, B: 512-767). Cleared each frame by compute kernel.',
      persistence: { retain: true, clearOnResize: false, clearEveryFrame: false, cpuAccess: false }
    },
    {
      id: 'hist_max',
      type: 'atomic_counter',
      dataType: 'int',
      size: { mode: 'fixed', value: 3 },
      comment: 'Per-channel max bin count for normalization (R, G, B).',
      persistence: { retain: true, clearOnResize: false, clearEveryFrame: false, cpuAccess: false }
    },
    {
      id: 'hist_read',
      type: 'buffer',
      dataType: 'int',
      size: { mode: 'fixed', value: 768 },
      comment: 'Readable copy of histogram for vertex shader. WebGPU vertex shaders require storage read-only, so atomic data is copied here via cmd_copy_buffer.',
      persistence: { retain: true, clearOnResize: false, clearEveryFrame: false, cpuAccess: false }
    },
    {
      id: 'max_read',
      type: 'buffer',
      dataType: 'int',
      size: { mode: 'fixed', value: 3 },
      comment: 'Readable copy of hist_max for vertex shader.',
      persistence: { retain: true, clearOnResize: false, clearEveryFrame: false, cpuAccess: false }
    }
  ],

  functions: [
    {
      id: 'fn_main_cpu',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      comment: 'Orchestration: clear counters → accumulate histogram + copy input → find max → copy to readable buffers → draw overlay.',
      nodes: [
        { id: 'clr_hist', op: 'cmd_dispatch', func: 'fn_clear_hist', threads: [768, 1, 1], exec_out: 'clr_max' },
        { id: 'clr_max', op: 'cmd_dispatch', func: 'fn_clear_max', threads: [3, 1, 1], exec_out: 'do_accum' },
        { id: 'tex_size', op: 'resource_get_size', resource: 'output_tex' },
        { id: 'do_accum', op: 'cmd_dispatch', func: 'fn_accumulate', threads: 'tex_size', exec_out: 'do_max' },
        { id: 'do_max', op: 'cmd_dispatch', func: 'fn_find_max', threads: [256, 1, 1], exec_out: 'copy_hist' },
        { id: 'copy_hist', op: 'cmd_copy_buffer', src: 'histogram', dst: 'hist_read', exec_out: 'copy_max', comment: 'Copy atomic counters to read-only buffers for vertex shader access.' },
        { id: 'copy_max', op: 'cmd_copy_buffer', src: 'hist_max', dst: 'max_read', exec_out: 'draw_hist' },
        {
          id: 'draw_hist',
          op: 'cmd_draw',
          target: 'output_tex',
          vertex: 'fn_hist_vertex',
          fragment: 'fn_hist_fragment',
          count: 4608,
          comment: '256 bins × 3 channels × 6 verts/bar = 4608 vertices.',
          pipeline: {
            topology: 'triangle-list',
            loadOp: 'load',
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
            }
          }
        }
      ]
    },

    {
      id: 'fn_clear_hist',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      workgroupSize: [256, 1, 1],
      comment: 'Zero all 768 histogram bins.',
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'clr', op: 'atomic_store', counter: 'histogram', index: 'gid.x', value: 0 }
      ]
    },

    {
      id: 'fn_clear_max',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      workgroupSize: [64, 1, 1],
      comment: 'Zero per-channel max counters.',
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'clr', op: 'atomic_store', counter: 'hist_max', index: 'gid.x', value: 0 }
      ]
    },

    {
      id: 'fn_accumulate',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      comment: 'Per-pixel: sample input, write to output, and atomicAdd to R/G/B histogram bins.',
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },
        { id: 'color', op: 'texture_sample', tex: 'input_visual', coords: 'nuv.xy' },
        { id: 'opaque', op: 'float4', x: 'color.x', y: 'color.y', z: 'color.z', w: 1.0 },
        { id: 'store_px', op: 'texture_store', tex: 'output_tex', coords: 'gid.xy', value: 'opaque', exec_out: 'add_r' },

        { id: 'c_bin', op: 'comment', comment: 'Quantize R/G/B to 0-255 and add channel offset for flat layout.' },
        { id: 'r_s', op: 'math_mul', a: 'color.x', b: 255.0 },
        { id: 'r_c', op: 'math_clamp', val: 'r_s', min: 0.0, max: 255.0 },
        { id: 'r_f', op: 'math_floor', val: 'r_c' },
        { id: 'r_i', op: 'static_cast_int', val: 'r_f' },
        { id: 'add_r', op: 'atomic_add', counter: 'histogram', index: 'r_i', value: 1, exec_out: 'add_g' },

        { id: 'g_s', op: 'math_mul', a: 'color.y', b: 255.0 },
        { id: 'g_c', op: 'math_clamp', val: 'g_s', min: 0.0, max: 255.0 },
        { id: 'g_off', op: 'math_add', a: 'g_c', b: 256.0 },
        { id: 'g_f', op: 'math_floor', val: 'g_off' },
        { id: 'g_i', op: 'static_cast_int', val: 'g_f' },
        { id: 'add_g', op: 'atomic_add', counter: 'histogram', index: 'g_i', value: 1, exec_out: 'add_b' },

        { id: 'b_s', op: 'math_mul', a: 'color.z', b: 255.0 },
        { id: 'b_c', op: 'math_clamp', val: 'b_s', min: 0.0, max: 255.0 },
        { id: 'b_off', op: 'math_add', a: 'b_c', b: 512.0 },
        { id: 'b_f', op: 'math_floor', val: 'b_off' },
        { id: 'b_i', op: 'static_cast_int', val: 'b_f' },
        { id: 'add_b', op: 'atomic_add', counter: 'histogram', index: 'b_i', value: 1 }
      ]
    },

    {
      id: 'fn_find_max',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      workgroupSize: [256, 1, 1],
      comment: 'Each of 256 threads reads its R/G/B bins and atomicMax into per-channel max.',
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'gf', op: 'static_cast_float', val: 'gid.x' },

        { id: 'rv', op: 'atomic_load', counter: 'histogram', index: 'gid.x' },
        { id: 'mr', op: 'atomic_max', counter: 'hist_max', index: 0, value: 'rv', exec_out: 'mg' },

        { id: 'gi_f', op: 'math_add', a: 'gf', b: 256.0 },
        { id: 'gi', op: 'static_cast_int', val: 'gi_f' },
        { id: 'gv', op: 'atomic_load', counter: 'histogram', index: 'gi' },
        { id: 'mg', op: 'atomic_max', counter: 'hist_max', index: 1, value: 'gv', exec_out: 'mb' },

        { id: 'bi_f', op: 'math_add', a: 'gf', b: 512.0 },
        { id: 'bi', op: 'static_cast_int', val: 'bi_f' },
        { id: 'bv', op: 'atomic_load', counter: 'histogram', index: 'bi' },
        { id: 'mb', op: 'atomic_max', counter: 'hist_max', index: 2, value: 'bv' }
      ]
    },

    {
      id: 'fn_hist_vertex',
      type: 'shader',
      comment: 'Vertex shader: generates bar quads for 256 bins × 3 channels. Reads histogram counts from int buffer, normalizes by per-channel max, and positions bars in the bottom-right corner of clip space.',
      inputs: [
        { id: 'v_idx', type: 'int' as DataType, builtin: 'vertex_index' as BuiltinName }
      ],
      outputs: [
        { id: 'out', type: 'HistVertex' as DataType }
      ],
      localVars: [],
      nodes: [
        { id: 'vi', op: 'var_get', var: 'v_idx' },
        { id: 'vi_f', op: 'static_cast_float', val: 'vi' },

        { id: 'c_decompose', op: 'comment', comment: 'bar = floor(vi/6) → 0..767, corner = vi%6 → 0..5' },
        { id: 'bar_raw', op: 'math_div', a: 'vi_f', b: 6 },
        { id: 'bar_f', op: 'math_floor', val: 'bar_raw' },
        { id: 'bar_i', op: 'static_cast_int', val: 'bar_f' },
        { id: 'corner_f', op: 'math_mod', a: 'vi_f', b: 6 },
        { id: 'corner_i', op: 'static_cast_int', val: 'corner_f' },

        { id: 'c_channel', op: 'comment', comment: 'channel = floor(bar/256) → 0,1,2; bin = bar%256 → 0..255' },
        { id: 'ch_raw', op: 'math_div', a: 'bar_f', b: 256 },
        { id: 'ch_f', op: 'math_floor', val: 'ch_raw' },
        { id: 'ch_i', op: 'static_cast_int', val: 'ch_f' },
        { id: 'bin_f', op: 'math_mod', a: 'bar_f', b: 256 },

        { id: 'c_quad', op: 'comment', comment: 'Quad offsets: 6 vertices forming 2 triangles.' },
        { id: 'qx_arr', op: 'array_construct', values: [0, 1, 0, 0, 1, 1] },
        { id: 'qy_arr', op: 'array_construct', values: [0, 0, 1, 1, 0, 1] },
        { id: 'qx', op: 'array_extract', array: 'qx_arr', index: 'corner_i' },
        { id: 'qy', op: 'array_extract', array: 'qy_arr', index: 'corner_i' },

        { id: 'c_height', op: 'comment', comment: 'Read histogram count, normalize by per-channel max.' },
        { id: 'count', op: 'buffer_load', buffer: 'hist_read', index: 'bar_i' },
        { id: 'count_f', op: 'static_cast_float', val: 'count' },
        { id: 'max_v', op: 'buffer_load', buffer: 'max_read', index: 'ch_i' },
        { id: 'max_f', op: 'static_cast_float', val: 'max_v' },
        { id: 'safe_max', op: 'math_max', a: 'max_f', b: 1.0 },
        { id: 'height', op: 'math_div', a: 'count_f', b: 'safe_max' },

        { id: 'c_pos', op: 'comment', comment: 'Clip-space position: histogram rect x [0.4, 0.98], y [-0.98, -0.5].' },
        { id: 'bx', op: 'math_add', a: 'bin_f', b: 'qx' },
        { id: 'bx_n', op: 'math_div', a: 'bx', b: 256.0 },
        { id: 'bx_s', op: 'math_mul', a: 'bx_n', b: 0.58 },
        { id: 'cx', op: 'math_add', a: 'bx_s', b: 0.4 },

        { id: 'h_s', op: 'math_mul', a: 'height', b: 0.48 },
        { id: 'y_off', op: 'math_mul', a: 'qy', b: 'h_s' },
        { id: 'cy', op: 'math_add', a: -0.98, b: 'y_off' },

        { id: 'pos', op: 'float4', x: 'cx', y: 'cy', z: 0.0, w: 1.0 },

        { id: 'c_color', op: 'comment', comment: 'Channel color: R=(1,0,0), G=(0,1,0), B=(0,0,1) with alpha for blending.' },
        { id: 'is_r', op: 'math_eq', a: 'ch_f', b: 0.0 },
        { id: 'is_g', op: 'math_eq', a: 'ch_f', b: 1.0 },
        { id: 'is_b', op: 'math_eq', a: 'ch_f', b: 2.0 },
        { id: 'cr', op: 'static_cast_float', val: 'is_r' },
        { id: 'cg', op: 'static_cast_float', val: 'is_g' },
        { id: 'cb', op: 'static_cast_float', val: 'is_b' },
        { id: 'color', op: 'float4', x: 'cr', y: 'cg', z: 'cb', w: 0.5 },

        { id: 'ret', op: 'struct_construct', type: 'HistVertex', values: { pos: 'pos', color: 'color' } },
        { id: 'out', op: 'func_return', val: 'ret' }
      ]
    },

    {
      id: 'fn_hist_fragment',
      type: 'shader',
      comment: 'Fragment shader: pass-through of interpolated bar color.',
      inputs: [
        { id: 'in', type: 'HistVertex' as DataType }
      ],
      outputs: [
        { id: 'color', type: 'float4' as DataType }
      ],
      localVars: [],
      nodes: [
        { id: 'vin', op: 'var_get', var: 'in' },
        { id: 'col', op: 'struct_extract', struct: 'vin', field: 'color' },
        { id: 'ret', op: 'func_return', val: 'col' }
      ]
    }
  ]
};

export const FEEDBACK_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Video Feedback' },
  comment: 'Classic video feedback with whispy noise trails. A persistent texture holds the previous frame, sampled at 3 zoom levels with hash-noise UV offsets. The averaged, decayed feedback is composited with the live input via max, then copied back for the next frame.',
  entryPoint: 'fn_main_cpu',

  inputs: [
    { id: 'input_visual', type: 'texture2d', format: 'rgba8', comment: 'Live input video stream.' }
  ],

  resources: [
    {
      id: 'output_tex',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'viewport' },
      isOutput: true,
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
    },
    {
      id: 'feedback_tex',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'viewport' },
      comment: 'Persistent feedback buffer: retains previous frame content, never cleared per-frame.',
      persistence: { retain: true, clearOnResize: true, clearEveryFrame: false, cpuAccess: false }
    }
  ],

  structs: [],

  functions: [
    {
      id: 'fn_main_cpu',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      comment: 'CPU entry: compute feedback effect, then copy output to feedback texture for next frame.',
      nodes: [
        { id: 'size', op: 'resource_get_size', resource: 'output_tex' },
        { id: 'dispatch', op: 'cmd_dispatch', func: 'fn_feedback', threads: 'size', exec_out: 'copy' },
        { id: 'copy', op: 'cmd_copy_texture', src: 'output_tex', dst: 'feedback_tex' }
      ]
    },
    {
      id: 'fn_feedback',
      type: 'shader',
      comment: 'Compute kernel: 3-tap zoomed feedback with hash noise for whispy trails, composited with live input.',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },
        { id: 'time', op: 'builtin_get', name: 'time' },

        { id: 'c_noise', op: 'comment', comment: 'Hash noise for whispy UV offsets: fract(sin(dot(uv, magic) + time*17.3) * 43758.5453). Two channels for x/y displacement.' },
        { id: 'h_p1', op: 'float2', x: 127.1, y: 311.7 },
        { id: 'h_dot', op: 'vec_dot', a: 'nuv.xy', b: 'h_p1' },
        { id: 'h_t', op: 'math_mul', a: 'time', b: 17.3 },
        { id: 'h_in', op: 'math_add', a: 'h_dot', b: 'h_t' },
        { id: 'h_sin1', op: 'math_sin', val: 'h_in' },
        { id: 'h_sc1', op: 'math_mul', a: 'h_sin1', b: 43758.5453 },
        { id: 'n1', op: 'math_fract', val: 'h_sc1' },
        { id: 'h_in2', op: 'math_add', a: 'h_in', b: 37.0 },
        { id: 'h_sin2', op: 'math_sin', val: 'h_in2' },
        { id: 'h_sc2', op: 'math_mul', a: 'h_sin2', b: 43758.5453 },
        { id: 'n2', op: 'math_fract', val: 'h_sc2' },
        { id: 'n1c', op: 'math_sub', a: 'n1', b: 0.5 },
        { id: 'n2c', op: 'math_sub', a: 'n2', b: 0.5 },
        { id: 'nx', op: 'math_mul', a: 'n1c', b: 0.006 },
        { id: 'ny', op: 'math_mul', a: 'n2c', b: 0.006 },
        { id: 'noise', op: 'float2', x: 'nx', y: 'ny' },

        { id: 'c_taps', op: 'comment', comment: '3 taps at increasing zoom levels (0.996, 0.992, 0.988) toward center. Each uses a different noise offset for organic, whispy trail movement.' },
        { id: 'cuv', op: 'math_sub', a: 'nuv.xy', b: 0.5 },

        { id: 'z1', op: 'math_mul', a: 'cuv', b: 0.996 },
        { id: 'u1r', op: 'math_add', a: 'z1', b: 0.5 },
        { id: 'u1', op: 'math_add', a: 'u1r', b: 'noise' },
        { id: 'fb1', op: 'texture_sample', tex: 'feedback_tex', coords: 'u1' },

        { id: 'z2', op: 'math_mul', a: 'cuv', b: 0.992 },
        { id: 'u2r', op: 'math_add', a: 'z2', b: 0.5 },
        { id: 'neg_noise', op: 'math_mul', a: 'noise', b: -1.0 },
        { id: 'u2', op: 'math_add', a: 'u2r', b: 'neg_noise' },
        { id: 'fb2', op: 'texture_sample', tex: 'feedback_tex', coords: 'u2' },

        { id: 'z3', op: 'math_mul', a: 'cuv', b: 0.988 },
        { id: 'u3r', op: 'math_add', a: 'z3', b: 0.5 },
        { id: 'rot_noise', op: 'float2', x: 'ny', y: 'nx' },
        { id: 'u3', op: 'math_add', a: 'u3r', b: 'rot_noise' },
        { id: 'fb3', op: 'texture_sample', tex: 'feedback_tex', coords: 'u3' },

        { id: 'c_composite', op: 'comment', comment: 'Average 3 taps with 0.95 total decay (0.317 = 0.95/3). Then take max with input: brighter of feedback trail or live input wins. This naturally fades trails while keeping input crisp.' },
        { id: 'sum12', op: 'math_add', a: 'fb1', b: 'fb2' },
        { id: 'sum_all', op: 'math_add', a: 'sum12', b: 'fb3' },
        { id: 'fb_avg', op: 'math_mul', a: 'sum_all', b: 0.317 },

        { id: 'input_col', op: 'texture_sample', tex: 'input_visual', coords: 'nuv.xy' },
        { id: 'combined', op: 'math_max', a: 'fb_avg', b: 'input_col' },

        { id: 'out', op: 'float4', xyz: 'combined.xyz', w: 1.0 },
        { id: 'store', op: 'texture_store', tex: 'output_tex', coords: 'gid.xy', value: 'out' }
      ]
    }
  ]
};

export const UV_WARP_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'UV Warp' },
  comment: 'Barrel/pincushion UV distortion controlled by a strength parameter. Negative strength blows outward (fisheye), positive sucks inward. Formula: warped_uv = 0.5 + (uv - 0.5) * max(0.01, 1 + strength * r² * 2).',
  entryPoint: 'fn_main_cpu',

  inputs: [
    { id: 'input_visual', type: 'texture2d', format: 'rgba8', comment: 'Input video stream.' },
    { id: 'strength', type: 'float', default: 0.0, ui: { min: -1.0, max: 1.0, widget: 'slider' }, comment: 'Warp strength: -1 = fisheye (outward), +1 = suck (inward).' }
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

  structs: [],

  functions: [
    {
      id: 'fn_main_cpu',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'size', op: 'resource_get_size', resource: 'output_tex' },
        { id: 'dispatch', op: 'cmd_dispatch', func: 'fn_warp', threads: 'size' }
      ]
    },
    {
      id: 'fn_warp',
      type: 'shader',
      comment: 'Compute kernel: radial UV warp. At center (offset=0), warp has no effect. Distortion increases quadratically toward edges.',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },

        { id: 'str', op: 'var_get', var: 'strength' },

        { id: 'c_warp', op: 'comment', comment: 'Radial warp: offset from center, scale by 1 + strength * r² * 2. Positive strength shrinks offset (inward), negative expands (outward). max(0.01, ...) prevents inversion.' },
        { id: 'offset', op: 'math_sub', a: 'nuv.xy', b: 0.5 },
        { id: 'r2', op: 'vec_dot', a: 'offset', b: 'offset' },
        { id: 'sr2', op: 'math_mul', a: 'str', b: 'r2' },
        { id: 'sr2x2', op: 'math_mul', a: 'sr2', b: 2.0 },
        { id: 'warp_raw', op: 'math_add', a: 1.0, b: 'sr2x2' },
        { id: 'warp', op: 'math_max', a: 'warp_raw', b: 0.01 },

        { id: 'warped_off', op: 'math_mul', a: 'offset', b: 'warp' },
        { id: 'warped_uv', op: 'math_add', a: 'warped_off', b: 0.5 },

        { id: 'color', op: 'texture_sample', tex: 'input_visual', coords: 'warped_uv' },
        { id: 'out', op: 'float4', xyz: 'color.xyz', w: 1.0 },
        { id: 'store', op: 'texture_store', tex: 'output_tex', coords: 'gid.xy', value: 'out' }
      ]
    }
  ]
};

// ─────────────────────────────────────────────────────────────────────────────
// Test Card — Resolume-style colour reference pattern
// ─────────────────────────────────────────────────────────────────────────────
// Digit bitmaps: 3 cols × 5 rows, row-major, LSB = top-left.
// Bit i = floor(BITMAP / 2^i) mod 2.
//
// Digit 1:       Digit 2:
//  .#.  (010)     ###  (111)
//  ##.  (110)     ..#  (001)
//  .#.  (010)     ###  (111)
//  .#.  (010)     #..  (100)
//  ###  (111)     ###  (111)
const DIGIT_1 = 29850;
const DIGIT_2 = 29671;
const TC_BASE_CELLS = 16; // Target cells on shorter dimension

function testCardDigitNodes(prefix: string, bitmap: number, startCol: number | string, startRow: number | string): any[] {
  return [
    // Local col/row within the 3×5 digit grid
    { id: `${prefix}_lc`, op: 'math_sub', a: 'cell_x', b: startCol },
    { id: `${prefix}_lr`, op: 'math_sub', a: 'cell_y', b: startRow },

    // Bounds: 0 ≤ lc < 3  and  0 ≤ lr < 5
    { id: `${prefix}_lc_lo`, op: 'math_step', edge: 0.0, x: `${prefix}_lc` },
    { id: `${prefix}_lc_hi`, op: 'math_step', edge: 3.0, x: `${prefix}_lc` },
    { id: `${prefix}_lc_in`, op: 'math_sub', a: `${prefix}_lc_lo`, b: `${prefix}_lc_hi` },
    { id: `${prefix}_lr_lo`, op: 'math_step', edge: 0.0, x: `${prefix}_lr` },
    { id: `${prefix}_lr_hi`, op: 'math_step', edge: 5.0, x: `${prefix}_lr` },
    { id: `${prefix}_lr_in`, op: 'math_sub', a: `${prefix}_lr_lo`, b: `${prefix}_lr_hi` },
    { id: `${prefix}_in`, op: 'math_mul', a: `${prefix}_lc_in`, b: `${prefix}_lr_in` },

    // Bit index = row × 3 + col
    { id: `${prefix}_ri3`, op: 'math_mul', a: `${prefix}_lr`, b: 3.0 },
    { id: `${prefix}_bi`, op: 'math_add', a: `${prefix}_ri3`, b: `${prefix}_lc` },

    // Extract bit: floor(bitmap / 2^bi) mod 2
    { id: `${prefix}_pw`, op: 'math_pow', a: 2.0, b: `${prefix}_bi` },
    { id: `${prefix}_dv`, op: 'math_div', a: bitmap, b: `${prefix}_pw` },
    { id: `${prefix}_fl`, op: 'math_floor', val: `${prefix}_dv` },
    { id: `${prefix}_bit`, op: 'math_mod', a: `${prefix}_fl`, b: 2.0 },

    // Final: in_bounds × bit_value
    { id: `${prefix}_dot`, op: 'math_mul', a: `${prefix}_in`, b: `${prefix}_bit` },
  ];
}

function buildTestCardCpuNodes(): any[] {
  return [
    // Compute grid dimensions for square cells
    { id: 'tex_size', op: 'resource_get_size', resource: 'output' },
    { id: 'dim_min', op: 'math_min', a: 'tex_size.x', b: 'tex_size.y' },
    { id: 'cell_target', op: 'math_div', a: 'dim_min', b: TC_BASE_CELLS },
    { id: 'cols_raw', op: 'math_div', a: 'tex_size.x', b: 'cell_target' },
    { id: 'rows_raw', op: 'math_div', a: 'tex_size.y', b: 'cell_target' },
    { id: 'cols_r', op: 'math_add', a: 'cols_raw', b: 0.5 },
    { id: 'rows_r', op: 'math_add', a: 'rows_raw', b: 0.5 },
    { id: 'cols', op: 'math_floor', val: 'cols_r' },
    { id: 'rows', op: 'math_floor', val: 'rows_r' },
    // Digit placement: centered
    { id: 'half_cols', op: 'math_div', a: 'cols', b: 2.0 },
    { id: 'half_cols_fl', op: 'math_floor', val: 'half_cols' },
    { id: 'digit_col', op: 'math_sub', a: 'half_cols_fl', b: 1.0 },
    { id: 'half_rows', op: 'math_div', a: 'rows', b: 2.0 },
    { id: 'half_rows_fl', op: 'math_floor', val: 'half_rows' },
    { id: 'digit_row', op: 'math_sub', a: 'half_rows_fl', b: 2.0 },
    // Store grid params and dispatch
    { id: 's0', op: 'buffer_store', buffer: 'grid_params', index: 0, value: 'cols', exec_out: 's1' },
    { id: 's1', op: 'buffer_store', buffer: 'grid_params', index: 1, value: 'rows', exec_out: 's2' },
    { id: 's2', op: 'buffer_store', buffer: 'grid_params', index: 2, value: 'digit_col', exec_out: 's3' },
    { id: 's3', op: 'buffer_store', buffer: 'grid_params', index: 3, value: 'digit_row', exec_out: 'dispatch' },
    { id: 'dispatch', op: 'cmd_dispatch', func: 'fn_render', threads: 'tex_size' },
  ];
}

function buildTestCardRenderNodes(): any[] {
  return [
    // ── Setup ──
    { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
    { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },
    { id: 'time', op: 'builtin_get', name: 'time' },
    { id: 'number', op: 'var_get', var: 'u_number' },

    // ── Load grid params from buffer ──
    { id: 'cols', op: 'buffer_load', buffer: 'grid_params', index: 0 },
    { id: 'rows', op: 'buffer_load', buffer: 'grid_params', index: 1 },
    { id: 'digit_col', op: 'buffer_load', buffer: 'grid_params', index: 2 },
    { id: 'digit_row', op: 'buffer_load', buffer: 'grid_params', index: 3 },

    // ── Cell indices from integer pixel coordinates ──
    { id: 'gid_xf', op: 'static_cast_float', val: 'gid.x' },
    { id: 'gid_yf', op: 'static_cast_float', val: 'gid.y' },
    { id: 'tex_size', op: 'resource_get_size', resource: 'output' },
    { id: 'cx_num', op: 'math_mul', a: 'gid_xf', b: 'cols' },
    { id: 'cx_div', op: 'math_div', a: 'cx_num', b: 'tex_size.x' },
    { id: 'cell_x', op: 'math_floor', val: 'cx_div' },
    { id: 'cy_num', op: 'math_mul', a: 'gid_yf', b: 'rows' },
    { id: 'cy_div', op: 'math_div', a: 'cy_num', b: 'tex_size.y' },
    { id: 'cell_y', op: 'math_floor', val: 'cy_div' },

    // ── Grid lines: boundary test against left/top neighbor ──
    { id: 'left_x', op: 'math_sub', a: 'gid_xf', b: 1.0 },
    { id: 'lcx_num', op: 'math_mul', a: 'left_x', b: 'cols' },
    { id: 'lcx_div', op: 'math_div', a: 'lcx_num', b: 'tex_size.x' },
    { id: 'left_cell', op: 'math_floor', val: 'lcx_div' },
    { id: 'top_y', op: 'math_sub', a: 'gid_yf', b: 1.0 },
    { id: 'tcy_num', op: 'math_mul', a: 'top_y', b: 'rows' },
    { id: 'tcy_div', op: 'math_div', a: 'tcy_num', b: 'tex_size.y' },
    { id: 'top_cell', op: 'math_floor', val: 'tcy_div' },
    { id: 'dx', op: 'math_sub', a: 'cell_x', b: 'left_cell' },
    { id: 'dx_abs', op: 'math_abs', val: 'dx' },
    { id: 'is_vline', op: 'math_step', edge: 0.5, x: 'dx_abs' },
    { id: 'dy', op: 'math_sub', a: 'cell_y', b: 'top_cell' },
    { id: 'dy_abs', op: 'math_abs', val: 'dy' },
    { id: 'is_hline', op: 'math_step', edge: 0.5, x: 'dy_abs' },
    { id: 'is_gridline', op: 'math_max', a: 'is_vline', b: 'is_hline' },

    // ── Gradient position (smooth, for spectrum/grayscale) ──
    { id: 'gu', op: 'math_mul', a: 'nuv.x', b: 'cols' },

    // ── Row type detection ──
    { id: 'r1_lo', op: 'math_step', edge: 1.0, x: 'cell_y' },
    { id: 'r1_hi', op: 'math_step', edge: 2.0, x: 'cell_y' },
    { id: 'is_row1', op: 'math_sub', a: 'r1_lo', b: 'r1_hi' },
    { id: 'gray_row', op: 'math_sub', a: 'rows', b: 2.0 },
    { id: 'gray_row_p1', op: 'math_add', a: 'gray_row', b: 1.0 },
    { id: 'rg_lo', op: 'math_step', edge: 'gray_row', x: 'cell_y' },
    { id: 'rg_hi', op: 'math_step', edge: 'gray_row_p1', x: 'cell_y' },
    { id: 'is_gray_row', op: 'math_sub', a: 'rg_lo', b: 'rg_hi' },

    // ── Gradient inset: cols 1 through cols-2 ──
    { id: 'cols_m1', op: 'math_sub', a: 'cols', b: 1.0 },
    { id: 'inset_lo', op: 'math_step', edge: 1.0, x: 'cell_x' },
    { id: 'inset_hi', op: 'math_step', edge: 'cols_m1', x: 'cell_x' },
    { id: 'is_inset', op: 'math_sub', a: 'inset_lo', b: 'inset_hi' },
    { id: 'is_spectrum', op: 'math_mul', a: 'is_row1', b: 'is_inset' },
    { id: 'is_grayscale', op: 'math_mul', a: 'is_gray_row', b: 'is_inset' },

    // ── Animated bell curve for checkerboard contrast ──
    // Slanted coordinate: diagonal from top-left to bottom-right
    { id: 'slant_y', op: 'math_mul', a: 'nuv.y', b: 0.5 },
    { id: 'slant_t', op: 'math_add', a: 'nuv.x', b: 'slant_y' },
    // Bell center sweeps across the slant range over time
    { id: 'bell_spd', op: 'math_mul', a: 'time', b: 0.3 },
    { id: 'bell_wrap', op: 'math_mod', a: 'bell_spd', b: 2.0 },
    { id: 'bell_ctr', op: 'math_sub', a: 'bell_wrap', b: 0.25 },
    // Distance from center, scaled for bell width
    { id: 'bell_d', op: 'math_sub', a: 'slant_t', b: 'bell_ctr' },
    { id: 'bell_ds', op: 'math_mul', a: 'bell_d', b: 2.0 },
    { id: 'bell_dc', op: 'math_clamp', val: 'bell_ds', min: -1.0, max: 1.0 },
    // cos bell: cos(d * PI) mapped from [-1,1] to [0,1]
    { id: 'bell_rad', op: 'math_mul', a: 'bell_dc', b: 3.14159 },
    { id: 'bell_cos', op: 'math_cos', val: 'bell_rad' },
    { id: 'bell_p1', op: 'math_add', a: 'bell_cos', b: 1.0 },
    { id: 'bell', op: 'math_mul', a: 'bell_p1', b: 0.5 },

    // ── Checkerboard with animated contrast modulation ──
    { id: 'ck_sum', op: 'math_add', a: 'cell_x', b: 'cell_y' },
    { id: 'ck_mod', op: 'math_mod', a: 'ck_sum', b: 2.0 },
    { id: 'checker_full', op: 'math_mix', a: 0.15, b: 0.65, t: 'ck_mod' },
    // Modulate contrast: flat baseline, bell brings contrast (50% intensity)
    { id: 'bell_half', op: 'math_mul', a: 'bell', b: 0.5 },
    { id: 'bell_bias', op: 'math_add', a: 'bell_half', b: 0.5 },
    { id: 'checker', op: 'math_mix', a: 0.40, b: 'checker_full', t: 'bell_bias' },

    // ── Gradient parameter: (gu - 1) / (cols - 2), clamped ──
    { id: 'cols_m2', op: 'math_sub', a: 'cols', b: 2.0 },
    { id: 'grad_raw', op: 'math_sub', a: 'gu', b: 1.0 },
    { id: 'grad_div', op: 'math_div', a: 'grad_raw', b: 'cols_m2' },
    { id: 'grad', op: 'math_clamp', val: 'grad_div', min: 0.0, max: 1.0 },

    // ── Colour spectrum: HSV S=1 V=1, hue = grad (static) ──
    { id: 'hr_fr', op: 'math_fract', val: 'grad' },
    { id: 'hr6', op: 'math_mul', a: 'hr_fr', b: 6.0 },
    { id: 'hr3', op: 'math_sub', a: 'hr6', b: 3.0 },
    { id: 'hr_abs', op: 'math_abs', val: 'hr3' },
    { id: 'hr_sub1', op: 'math_sub', a: 'hr_abs', b: 1.0 },
    { id: 'spec_r', op: 'math_clamp', val: 'hr_sub1', min: 0.0, max: 1.0 },
    { id: 'hg_off', op: 'math_add', a: 'grad', b: 0.6667 },
    { id: 'hg_fr', op: 'math_fract', val: 'hg_off' },
    { id: 'hg6', op: 'math_mul', a: 'hg_fr', b: 6.0 },
    { id: 'hg3', op: 'math_sub', a: 'hg6', b: 3.0 },
    { id: 'hg_abs', op: 'math_abs', val: 'hg3' },
    { id: 'hg_sub1', op: 'math_sub', a: 'hg_abs', b: 1.0 },
    { id: 'spec_g', op: 'math_clamp', val: 'hg_sub1', min: 0.0, max: 1.0 },
    { id: 'hb_off', op: 'math_add', a: 'grad', b: 0.3333 },
    { id: 'hb_fr', op: 'math_fract', val: 'hb_off' },
    { id: 'hb6', op: 'math_mul', a: 'hb_fr', b: 6.0 },
    { id: 'hb3', op: 'math_sub', a: 'hb6', b: 3.0 },
    { id: 'hb_abs', op: 'math_abs', val: 'hb3' },
    { id: 'hb_sub1', op: 'math_sub', a: 'hb_abs', b: 1.0 },
    { id: 'spec_b', op: 'math_clamp', val: 'hb_sub1', min: 0.0, max: 1.0 },

    // ── Background composition ──
    { id: 'ns1', op: 'math_sub', a: 1.0, b: 'is_spectrum' },
    { id: 'ns2', op: 'math_sub', a: 1.0, b: 'is_grayscale' },
    { id: 'not_special', op: 'math_mul', a: 'ns1', b: 'ns2' },
    { id: 'sr', op: 'math_mul', a: 'is_spectrum', b: 'spec_r' },
    { id: 'sg', op: 'math_mul', a: 'is_spectrum', b: 'spec_g' },
    { id: 'sb', op: 'math_mul', a: 'is_spectrum', b: 'spec_b' },
    { id: 'gscale', op: 'math_mul', a: 'is_grayscale', b: 'grad' },
    { id: 'cr', op: 'math_mul', a: 'not_special', b: 'checker' },
    { id: 'gs_cr', op: 'math_add', a: 'gscale', b: 'cr' },
    { id: 'bg_r', op: 'math_add', a: 'sr', b: 'gs_cr' },
    { id: 'bg_g', op: 'math_add', a: 'sg', b: 'gs_cr' },
    { id: 'bg_b', op: 'math_add', a: 'sb', b: 'gs_cr' },

    // ── Digit selection (odd→1, even→2) ──
    { id: 'abs_num', op: 'math_abs', val: 'number' },
    { id: 'mod2', op: 'math_mod', a: 'abs_num', b: 2.0 },
    { id: 'is_odd', op: 'math_step', edge: 0.5, x: 'mod2' },

    // ── Digit bitmaps (dynamic placement from buffer) ──
    ...testCardDigitNodes('d1', DIGIT_1, 'digit_col', 'digit_row'),
    ...testCardDigitNodes('d2', DIGIT_2, 'digit_col', 'digit_row'),
    { id: 'digit_on', op: 'math_mix', a: 'd2_dot', b: 'd1_dot', t: 'is_odd' },
    { id: 'fill', op: 'math_mul', a: 'is_odd', b: 1.0 },

    // ── Apply digit fill over background ──
    { id: 'final_r', op: 'math_mix', a: 'bg_r', b: 'fill', t: 'digit_on' },
    { id: 'final_g', op: 'math_mix', a: 'bg_g', b: 'fill', t: 'digit_on' },
    { id: 'final_b', op: 'math_mix', a: 'bg_b', b: 'fill', t: 'digit_on' },

    // ── Grid line overlay (dark gray) ──
    { id: 'out_r', op: 'math_mix', a: 'final_r', b: 0.2, t: 'is_gridline' },
    { id: 'out_g', op: 'math_mix', a: 'final_g', b: 0.2, t: 'is_gridline' },
    { id: 'out_b', op: 'math_mix', a: 'final_b', b: 0.2, t: 'is_gridline' },

    // ── Output ──
    { id: 'color', op: 'float4', x: 'out_r', y: 'out_g', z: 'out_b', w: 1.0 },
    { id: 'store', op: 'texture_store', tex: 'output', coords: 'gid.xy', value: 'color' },
  ];
}

export const TEST_CARD_SHADER: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Test Card' },
  comment: 'Colour reference: dynamic grid with spectrum row, grayscale row, checkerboard with animated contrast, and dot-matrix digit.',
  entryPoint: 'main',
  inputs: [
    { id: 'u_number', type: 'int', default: 1, label: 'Number', ui: { min: 0, max: 99 } },
  ],
  resources: [
    {
      id: 'output',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'viewport' },
      isOutput: true,
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: true },
    },
    {
      id: 'grid_params',
      type: 'buffer',
      dataType: 'float',
      size: { mode: 'fixed', value: 4 },
      persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false },
    },
  ],
  structs: [],
  functions: [
    {
      id: 'main',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: buildTestCardCpuNodes(),
    },
    {
      id: 'fn_render',
      type: 'shader',
      comment: 'Test card: spectrum row, grayscale row, checkerboard, single-pixel grid, dot-matrix digit.',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: buildTestCardRenderNodes(),
    },
  ],
};

export const ALL_EXAMPLES = {
  noise_shader: NOISE_SHADER,
  effect_shader: EFFECT_SHADER,
  mixer_shader: MIXER_SHADER,
  raymarch_shader: RAYMARCH_SHADER,
  particle_shader: PARTICLE_SHADER,
  histogram_shader: HISTOGRAM_SHADER,
  feedback_shader: FEEDBACK_SHADER,
  uv_warp_shader: UV_WARP_SHADER,
  test_card_shader: TEST_CARD_SHADER,
};
