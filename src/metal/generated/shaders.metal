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
kernel void fn_brightness_gpu(
    constant float* inputs [[buffer(0)]],
    texture2d<float> v_in_tex_tex [[texture(1)]],
    sampler v_in_tex_sampler [[sampler(1)]],
    texture2d<float, access::write> v_out_tex_tex [[texture(2)]],
    uint3 gid [[thread_position_in_grid]]) {
    float v_b_val = inputs[0];
    auto n_gid_raw = float3(gid);
    auto n_gid = float3(gid).xy;
    auto n_uv = float2(0.5f, 0.5f);
    auto n_tex_color = v_in_tex_tex.sample(v_in_tex_sampler, float2(0.5f, 0.5f));
    auto n_b_vec = float4(v_b_val, v_b_val, v_b_val, 1.0f);
    auto n_final_color = (v_in_tex_tex.sample(v_in_tex_sampler, float2(0.5f, 0.5f)) + float4(v_b_val, v_b_val, v_b_val, 1.0f));
    v_out_tex_tex.write((v_in_tex_tex.sample(v_in_tex_sampler, float2(0.5f, 0.5f)) + float4(v_b_val, v_b_val, v_b_val, 1.0f)), uint2(float3(gid).xy));
}
