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
kernel void fn_mixer_gpu(
    constant float* inputs [[buffer(0)]],
    texture2d<float, access::write> v_out_tex_tex [[texture(1)]],
    texture2d<float> v_in_tex1_tex [[texture(2)]],
    sampler v_in_tex1_sampler [[sampler(2)]],
    texture2d<float> v_in_tex2_tex [[texture(3)]],
    sampler v_in_tex2_sampler [[sampler(3)]],
    uint3 gid [[thread_position_in_grid]]) {
    float v_mix_val = inputs[0];
    auto n_gid_raw = float3(gid);
    auto n_gid = float3(gid).xy;
    auto n_uv = float2(0.5f, 0.5f);
    auto n_c1 = v_in_tex1_tex.sample(v_in_tex1_sampler, float2(0.5f, 0.5f));
    auto n_c2 = v_in_tex2_tex.sample(v_in_tex2_sampler, float2(0.5f, 0.5f));
    auto n_final_color = mix(v_in_tex1_tex.sample(v_in_tex1_sampler, float2(0.5f, 0.5f)), v_in_tex2_tex.sample(v_in_tex2_sampler, float2(0.5f, 0.5f)), v_mix_val);
    v_out_tex_tex.write(mix(v_in_tex1_tex.sample(v_in_tex1_sampler, float2(0.5f, 0.5f)), v_in_tex2_tex.sample(v_in_tex2_sampler, float2(0.5f, 0.5f)), v_mix_val), uint2(float3(gid).xy));
}
