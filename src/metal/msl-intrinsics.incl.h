// MSL Intrinsics for nano-ffglify
// Safe division, comparison, select, NaN/Inf, casting, matrix, quaternion, color helpers
// NOTE: The including file must provide <metal_stdlib> and 'using namespace metal;'

// Safe division
inline float safe_div(float a, float b) { return b != 0.0f ? a / b : 0.0f; }
inline float2 safe_div(float2 a, float b) { return b != 0.0f ? a / b : float2(0.0f); }
inline float3 safe_div(float3 a, float b) { return b != 0.0f ? a / b : float3(0.0f); }
inline float4 safe_div(float4 a, float b) { return b != 0.0f ? a / b : float4(0.0f); }
inline float2 safe_div(float2 a, float2 b) { return float2(safe_div(a.x, b.x), safe_div(a.y, b.y)); }
inline float3 safe_div(float3 a, float3 b) { return float3(safe_div(a.x, b.x), safe_div(a.y, b.y), safe_div(a.z, b.z)); }
inline float4 safe_div(float4 a, float4 b) { return float4(safe_div(a.x, b.x), safe_div(a.y, b.y), safe_div(a.z, b.z), safe_div(a.w, b.w)); }

// Comparison helpers — overloaded for scalar and vector types
inline float cmp_eq(float a, float b) { return a == b ? 1.0f : 0.0f; }
inline float2 cmp_eq(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a == b); }
inline float3 cmp_eq(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a == b); }
inline float4 cmp_eq(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a == b); }
inline float cmp_neq(float a, float b) { return a != b ? 1.0f : 0.0f; }
inline float2 cmp_neq(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a != b); }
inline float3 cmp_neq(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a != b); }
inline float4 cmp_neq(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a != b); }
inline float cmp_lt(float a, float b) { return a < b ? 1.0f : 0.0f; }
inline float2 cmp_lt(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a < b); }
inline float3 cmp_lt(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a < b); }
inline float4 cmp_lt(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a < b); }
inline float cmp_lte(float a, float b) { return a <= b ? 1.0f : 0.0f; }
inline float2 cmp_lte(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a <= b); }
inline float3 cmp_lte(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a <= b); }
inline float4 cmp_lte(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a <= b); }
inline float cmp_gt(float a, float b) { return a > b ? 1.0f : 0.0f; }
inline float2 cmp_gt(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a > b); }
inline float3 cmp_gt(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a > b); }
inline float4 cmp_gt(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a > b); }
inline float cmp_gte(float a, float b) { return a >= b ? 1.0f : 0.0f; }
inline float2 cmp_gte(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a >= b); }
inline float3 cmp_gte(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a >= b); }
inline float4 cmp_gte(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a >= b); }

// Select helper — overloaded for scalar and vector types
inline float msl_select(float f, float t, float cond) { return cond != 0.0f ? t : f; }
inline float2 msl_select(float2 f, float2 t, float cond) { return cond != 0.0f ? t : f; }
inline float3 msl_select(float3 f, float3 t, float cond) { return cond != 0.0f ? t : f; }
inline float4 msl_select(float4 f, float4 t, float cond) { return cond != 0.0f ? t : f; }
inline float2 msl_select(float2 f, float2 t, float2 cond) { return select(f, t, cond != 0.0f); }
inline float3 msl_select(float3 f, float3 t, float3 cond) { return select(f, t, cond != 0.0f); }
inline float4 msl_select(float4 f, float4 t, float4 cond) { return select(f, t, cond != 0.0f); }

// NaN/Inf/Finite helpers — overloaded for scalar and vector
inline float msl_is_nan(float v) { return isnan(v) ? 1.0f : 0.0f; }
inline float2 msl_is_nan(float2 v) { return select(float2(0.0f), float2(1.0f), isnan(v)); }
inline float3 msl_is_nan(float3 v) { return select(float3(0.0f), float3(1.0f), isnan(v)); }
inline float4 msl_is_nan(float4 v) { return select(float4(0.0f), float4(1.0f), isnan(v)); }
inline float msl_is_inf(float v) { return isinf(v) ? 1.0f : 0.0f; }
inline float2 msl_is_inf(float2 v) { return select(float2(0.0f), float2(1.0f), isinf(v)); }
inline float3 msl_is_inf(float3 v) { return select(float3(0.0f), float3(1.0f), isinf(v)); }
inline float4 msl_is_inf(float4 v) { return select(float4(0.0f), float4(1.0f), isinf(v)); }
inline float msl_is_finite(float v) { return (!isnan(v) && !isinf(v)) ? 1.0f : 0.0f; }
inline float2 msl_is_finite(float2 v) { return select(float2(0.0f), float2(1.0f), !isnan(v) && !isinf(v)); }
inline float3 msl_is_finite(float3 v) { return select(float3(0.0f), float3(1.0f), !isnan(v) && !isinf(v)); }
inline float4 msl_is_finite(float4 v) { return select(float4(0.0f), float4(1.0f), !isnan(v) && !isinf(v)); }

// Safe int cast (handles overflow with two's complement wrapping)
inline int safe_cast_int(float v) {
  if (v >= 2147483648.0f) return int(v - 4294967296.0f);
  if (v < -2147483648.0f) return int(v + 4294967296.0f);
  return int(v);
}

// Flush subnormal helper
inline float flush_subnormal(float v) { return (v != 0.0f && abs(v) < 1.175494e-38f) ? 0.0f : v; }

// Exponent/mantissa helpers (IEEE 754)
inline float get_exponent(float v) {
  if (v == 0.0f) return 0.0f;
  int exp_val; frexp(v, exp_val);
  return float(exp_val);
}
inline float get_mantissa(float v) {
  if (v == 0.0f) return 0.0f;
  int exp_val; return frexp(v, exp_val);
}

// Matrix inverse (4x4)
inline float4x4 mat_inverse(float4x4 m) {
  float4 c0 = m[0], c1 = m[1], c2 = m[2], c3 = m[3];
  float4 r0, r1, r2, r3;
  r0.x = c1.y*c2.z*c3.w - c1.y*c2.w*c3.z - c2.y*c1.z*c3.w + c2.y*c1.w*c3.z + c3.y*c1.z*c2.w - c3.y*c1.w*c2.z;
  r0.y = -c0.y*c2.z*c3.w + c0.y*c2.w*c3.z + c2.y*c0.z*c3.w - c2.y*c0.w*c3.z - c3.y*c0.z*c2.w + c3.y*c0.w*c2.z;
  r0.z = c0.y*c1.z*c3.w - c0.y*c1.w*c3.z - c1.y*c0.z*c3.w + c1.y*c0.w*c3.z + c3.y*c0.z*c1.w - c3.y*c0.w*c1.z;
  r0.w = -c0.y*c1.z*c2.w + c0.y*c1.w*c2.z + c1.y*c0.z*c2.w - c1.y*c0.w*c2.z - c2.y*c0.z*c1.w + c2.y*c0.w*c1.z;
  float det = c0.x*r0.x + c1.x*r0.y + c2.x*r0.z + c3.x*r0.w;
  if (abs(det) < 1e-10) return m;
  float invDet = 1.0f / det;
  r1.x = -c1.x*c2.z*c3.w + c1.x*c2.w*c3.z + c2.x*c1.z*c3.w - c2.x*c1.w*c3.z - c3.x*c1.z*c2.w + c3.x*c1.w*c2.z;
  r1.y = c0.x*c2.z*c3.w - c0.x*c2.w*c3.z - c2.x*c0.z*c3.w + c2.x*c0.w*c3.z + c3.x*c0.z*c2.w - c3.x*c0.w*c2.z;
  r1.z = -c0.x*c1.z*c3.w + c0.x*c1.w*c3.z + c1.x*c0.z*c3.w - c1.x*c0.w*c3.z - c3.x*c0.z*c1.w + c3.x*c0.w*c1.z;
  r1.w = c0.x*c1.z*c2.w - c0.x*c1.w*c2.z - c1.x*c0.z*c2.w + c1.x*c0.w*c2.z + c2.x*c0.z*c1.w - c2.x*c0.w*c1.z;
  r2.x = c1.x*c2.y*c3.w - c1.x*c2.w*c3.y - c2.x*c1.y*c3.w + c2.x*c1.w*c3.y + c3.x*c1.y*c2.w - c3.x*c1.w*c2.y;
  r2.y = -c0.x*c2.y*c3.w + c0.x*c2.w*c3.y + c2.x*c0.y*c3.w - c2.x*c0.w*c3.y - c3.x*c0.y*c2.w + c3.x*c0.w*c2.y;
  r2.z = c0.x*c1.y*c3.w - c0.x*c1.w*c3.y - c1.x*c0.y*c3.w + c1.x*c0.w*c3.y + c3.x*c0.y*c1.w - c3.x*c0.w*c1.y;
  r2.w = -c0.x*c1.y*c2.w + c0.x*c1.w*c2.y + c1.x*c0.y*c2.w - c1.x*c0.w*c2.y - c2.x*c0.y*c1.w + c2.x*c0.w*c1.y;
  r3.x = -c1.x*c2.y*c3.z + c1.x*c2.z*c3.y + c2.x*c1.y*c3.z - c2.x*c1.z*c3.y - c3.x*c1.y*c2.z + c3.x*c1.z*c2.y;
  r3.y = c0.x*c2.y*c3.z - c0.x*c2.z*c3.y - c2.x*c0.y*c3.z + c2.x*c0.z*c3.y + c3.x*c0.y*c2.z - c3.x*c0.z*c2.y;
  r3.z = -c0.x*c1.y*c3.z + c0.x*c1.z*c3.y + c1.x*c0.y*c3.z - c1.x*c0.z*c3.y - c3.x*c0.y*c1.z + c3.x*c0.z*c1.y;
  r3.w = c0.x*c1.y*c2.z - c0.x*c1.z*c2.y - c1.x*c0.y*c2.z + c1.x*c0.z*c2.y + c2.x*c0.y*c1.z - c2.x*c0.z*c1.y;
  return float4x4(r0*invDet, r1*invDet, r2*invDet, r3*invDet);
}

// Quaternion helpers (w,x,y,z = q.w,q.x,q.y,q.z ; stored as float4(x,y,z,w))
inline float4 quat_mul(float4 a, float4 b) {
  return float4(a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
                a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
                a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
                a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z);
}
inline float3 quat_rotate(float3 v, float4 q) {
  float3 u = q.xyz; float s = q.w;
  return 2.0f*dot(u,v)*u + (s*s - dot(u,u))*v + 2.0f*s*cross(u,v);
}
inline float4 quat_slerp(float4 a, float4 b, float t) {
  float d = dot(a, b);
  if (d < 0.0f) { b = -b; d = -d; }
  if (d > 0.9995f) return normalize(mix(a, b, t));
  float theta = acos(clamp(d, -1.0f, 1.0f));
  float sn = sin(theta);
  return (sin((1.0f-t)*theta)/sn)*a + (sin(t*theta)/sn)*b;
}
inline float4x4 quat_to_mat4(float4 q) {
  float x=q.x, y=q.y, z=q.z, w=q.w;
  return float4x4(
    float4(1-2*(y*y+z*z), 2*(x*y+w*z), 2*(x*z-w*y), 0),
    float4(2*(x*y-w*z), 1-2*(x*x+z*z), 2*(y*z+w*x), 0),
    float4(2*(x*z+w*y), 2*(y*z-w*x), 1-2*(x*x+y*y), 0),
    float4(0, 0, 0, 1));
}

// Color mix (alpha-over compositing: dst=a, src=b)
inline float4 color_mix_impl(float4 dst, float4 src) {
  float outA = src.w + dst.w * (1.0f - src.w);
  if (outA < 1e-6f) return float4(0.0f);
  float3 rgb = (src.xyz * src.w + dst.xyz * dst.w * (1.0f - src.w)) / outA;
  return float4(rgb, outA);
}
