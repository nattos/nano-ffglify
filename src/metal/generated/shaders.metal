#include <metal_stdlib>
using namespace metal;

// Helper functions
inline float safe_div(float a, float b) { return b != 0.0f ? a / b : 0.0f; }
inline float2 safe_div(float2 a, float b) { return b != 0.0f ? a / b : float2(0.0f); }
inline float3 safe_div(float3 a, float b) { return b != 0.0f ? a / b : float3(0.0f); }
inline float4 safe_div(float4 a, float b) { return b != 0.0f ? a / b : float4(0.0f); }
inline float2 safe_div(float2 a, float2 b) { return float2(safe_div(a.x, b.x), safe_div(a.y, b.y)); }
inline float3 safe_div(float3 a, float3 b) { return float3(safe_div(a.x, b.x), safe_div(a.y, b.y), safe_div(a.z, b.z)); }
inline float4 safe_div(float4 a, float4 b) { return float4(safe_div(a.x, b.x), safe_div(a.y, b.y), safe_div(a.z, b.z), safe_div(a.w, b.w)); }

// Kernel entry point
kernel void fn_noise_gpu(
    device float* b_globals [[buffer(0)]],
    texture2d<float, access::write> v_output_tex_tex [[texture(1)]],
    uint3 gid [[thread_position_in_grid]]) {
    auto n_in_gid = float3(gid);
    auto n_pixel_coords = float3(gid).xy;
    auto n_tex_dims = float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height());
    auto n_uv = safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height()));
    auto n_val_scale = b_globals[0];
    auto n_scaled_uv = (safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]);
    auto n_val_time = b_globals[1];
    auto n_time_offset = float2(b_globals[1], b_globals[1]);
    auto n_uv_animated = ((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1]));
    auto n_hash_const = float2(12.9898f, 78.233f);
    auto n_dot_prod = dot(((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1])), float2(12.9898f, 78.233f));
    auto n_sin_res = sin(dot(((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1])), float2(12.9898f, 78.233f)));
    auto n_noise_raw = (sin(dot(((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1])), float2(12.9898f, 78.233f))) * 43758.5453f);
    auto n_noise_final = fract((sin(dot(((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1])), float2(12.9898f, 78.233f))) * 43758.5453f));
    auto n_rgba_out = float4(fract((sin(dot(((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1])), float2(12.9898f, 78.233f))) * 43758.5453f)), fract((sin(dot(((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1])), float2(12.9898f, 78.233f))) * 43758.5453f)), fract((sin(dot(((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1])), float2(12.9898f, 78.233f))) * 43758.5453f)), 1.0f);
    v_output_tex_tex.write(float4(fract((sin(dot(((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1])), float2(12.9898f, 78.233f))) * 43758.5453f)), fract((sin(dot(((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1])), float2(12.9898f, 78.233f))) * 43758.5453f)), fract((sin(dot(((safe_div(float3(gid).xy, float2(v_output_tex_tex.get_width(), v_output_tex_tex.get_height())) * b_globals[0]) + float2(b_globals[1], b_globals[1])), float2(12.9898f, 78.233f))) * 43758.5453f)), 1.0f), uint2(float3(gid).xy));
}
