fn safe_f32_to_i32(v: f32) -> i32 {
  if (v >= 2147483648.0) { return bitcast<i32>(u32(v)); }
  return i32(v);
}
fn get_nan() -> f32 { var u = 0x7fc00000u; return bitcast<f32>(u); }
fn get_inf() -> f32 { var u = 0x7f800000u; return bitcast<f32>(u); }
fn get_neginf() -> f32 { var u = 0xff800000u; return bitcast<f32>(u); }
fn mat4_from_array_i32(arr: array<i32, 16>) -> mat4x4<f32> {
  return mat4x4<f32>(
    f32(arr[0]), f32(arr[1]), f32(arr[2]), f32(arr[3]),
    f32(arr[4]), f32(arr[5]), f32(arr[6]), f32(arr[7]),
    f32(arr[8]), f32(arr[9]), f32(arr[10]), f32(arr[11]),
    f32(arr[12]), f32(arr[13]), f32(arr[14]), f32(arr[15])
  );
}
fn mat3_inverse(m: mat3x3<f32>) -> mat3x3<f32> {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2];
  let b01 = a22 * a11 - a12 * a21;
  let b11 = -a22 * a01 + a02 * a21;
  let b21 = a12 * a01 - a02 * a11;
  let det = a00 * b01 + a10 * b11 + a20 * b21;
  if (det == 0.0) { return mat3x3<f32>(0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0); }
  let invDet = 1.0 / det;
  return mat3x3<f32>(
    b01 * invDet,
    (-a22 * a10 + a12 * a20) * invDet,
    (a21 * a10 - a11 * a20) * invDet,
    b11 * invDet,
    (a22 * a00 - a02 * a20) * invDet,
    (-a21 * a00 + a01 * a20) * invDet,
    b21 * invDet,
    (-a12 * a00 + a02 * a10) * invDet,
    (a11 * a00 - a01 * a10) * invDet
  );
}

fn mat4_inverse(m: mat4x4<f32>) -> mat4x4<f32> {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2]; let a03 = m[0][3];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2]; let a13 = m[1][3];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2]; let a23 = m[2][3];
  let a30 = m[3][0]; let a31 = m[3][1]; let a32 = m[3][2]; let a33 = m[3][3];
  let b00 = a00 * a11 - a01 * a10; let b01 = a00 * a12 - a02 * a10;
  let b02 = a00 * a13 - a03 * a10; let b03 = a01 * a12 - a02 * a11;
  let b04 = a01 * a13 - a03 * a11; let b05 = a02 * a13 - a03 * a12;
  let b06 = a20 * a31 - a21 * a30; let b07 = a20 * a32 - a22 * a30;
  let b08 = a20 * a33 - a23 * a30; let b09 = a21 * a32 - a22 * a31;
  let b10 = a21 * a33 - a23 * a31; let b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det == 0.0) { return mat4x4<f32>(0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0); }
  let invDet = 1.0 / det;
  return mat4x4<f32>(
    (a11 * b11 - a12 * b10 + a13 * b09) * invDet,
    (a02 * b10 - a01 * b11 - a03 * b09) * invDet,
    (a31 * b05 - a32 * b04 + a33 * b03) * invDet,
    (a22 * b04 - a21 * b05 - a23 * b03) * invDet,
    (a12 * b08 - a10 * b11 - a13 * b07) * invDet,
    (a00 * b11 - a02 * b08 + a03 * b07) * invDet,
    (a32 * b02 - a30 * b05 - a33 * b01) * invDet,
    (a20 * b05 - a22 * b02 + a23 * b01) * invDet,
    (a10 * b10 - a11 * b08 + a13 * b06) * invDet,
    (a01 * b08 - a00 * b10 - a03 * b06) * invDet,
    (a30 * b04 - a31 * b02 + a33 * b00) * invDet,
    (a21 * b02 - a20 * b04 - a23 * b00) * invDet,
    (a11 * b07 - a10 * b09 - a12 * b06) * invDet,
    (a00 * b09 - a01 * b07 + a02 * b06) * invDet,
    (a31 * b01 - a30 * b03 - a32 * b00) * invDet,
    (a20 * b03 - a21 * b01 + a22 * b00) * invDet
  );
}
fn is_nan(v: f32) -> bool {
  return (bitcast<u32>(v) & 0x7fffffffu) > 0x7f800000u;
}
fn is_inf(v: f32) -> bool {
  return (bitcast<u32>(v) & 0x7fffffffu) == 0x7f800000u;
}
fn is_finite(v: f32) -> bool {
  return (bitcast<u32>(v) & 0x7fffffffu) < 0x7f800000u;
}
fn is_nan_vec2(v: vec2<f32>) -> vec2<bool> { return (bitcast<vec2<u32>>(v) & vec2<u32>(0x7fffffffu)) > vec2<u32>(0x7f800000u); }
fn is_nan_vec3(v: vec3<f32>) -> vec3<bool> { return (bitcast<vec3<u32>>(v) & vec3<u32>(0x7fffffffu)) > vec3<u32>(0x7f800000u); }
fn is_nan_vec4(v: vec4<f32>) -> vec4<bool> { return (bitcast<vec4<u32>>(v) & vec4<u32>(0x7fffffffu)) > vec4<u32>(0x7f800000u); }

fn is_inf_vec2(v: vec2<f32>) -> vec2<bool> { return (bitcast<vec2<u32>>(v) & vec2<u32>(0x7fffffffu)) == vec2<u32>(0x7f800000u); }
fn is_inf_vec3(v: vec3<f32>) -> vec3<bool> { return (bitcast<vec3<u32>>(v) & vec3<u32>(0x7fffffffu)) == vec3<u32>(0x7f800000u); }
fn is_inf_vec4(v: vec4<f32>) -> vec4<bool> { return (bitcast<vec4<u32>>(v) & vec4<u32>(0x7fffffffu)) == vec4<u32>(0x7f800000u); }

fn is_finite_vec2(v: vec2<f32>) -> vec2<bool> { return (bitcast<vec2<u32>>(v) & vec2<u32>(0x7fffffffu)) < vec2<u32>(0x7f800000u); }
fn is_finite_vec3(v: vec3<f32>) -> vec3<bool> { return (bitcast<vec3<u32>>(v) & vec3<u32>(0x7fffffffu)) < vec3<u32>(0x7f800000u); }
fn is_finite_vec4(v: vec4<f32>) -> vec4<bool> { return (bitcast<vec4<u32>>(v) & vec4<u32>(0x7fffffffu)) < vec4<u32>(0x7f800000u); }

fn flush_subnormal(v: f32) -> f32 {
  let u = bitcast<u32>(v);
  if ((u & 0x7f800000u) == 0u && (u & 0x007fffffu) != 0u) {
    return 0.0;
  }
  return v;
}
fn get_mantissa(v: f32) -> f32 {
  return frexp(v).fract;
}
fn get_exponent(v: f32) -> f32 {
  return f32(frexp(v).exp);
}

fn quat_from_axis_angle(axis: vec3<f32>, angle: f32) -> vec4<f32> {
  let half_angle = angle * 0.5;
  let s = sin(half_angle);
  let c = cos(half_angle);
  return vec4<f32>(axis * s, c);
}
fn quat_mul(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  );
}
fn quat_slerp(a: vec4<f32>, b: vec4<f32>, t: f32) -> vec4<f32> {
  let cos_half_theta = dot(a, b);
  if (abs(cos_half_theta) >= 1.0) { return a; }
  let sin_half_theta = sqrt(1.0 - cos_half_theta * cos_half_theta);
  if (abs(sin_half_theta) < 0.001) { return vec4<f32>((1.0 - t) * a + t * b); }
  let half_theta = acos(cos_half_theta);
  let ratio_a = sin((1.0 - t) * half_theta) / sin_half_theta;
  let ratio_b = sin(t * half_theta) / sin_half_theta;
  return ratio_a * a + ratio_b * b;
}
fn quat_rotate(v: vec3<f32>, q: vec4<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn quat_to_mat4(q: vec4<f32>) -> mat4x4<f32> {
  let x2 = q.x + q.x; let y2 = q.y + q.y; let z2 = q.z + q.z;
  let xx = q.x * x2; let xy = q.x * y2; let xz = q.x * z2;
  let yy = q.y * y2; let yz = q.y * z2; let zz = q.z * z2;
  let wx = q.w * x2; let wy = q.w * y2; let wz = q.w * z2;
  return mat4x4<f32>(
    1.0 - (yy + zz), xy + wz, xz - wy, 0.0,
    xy - wz, 1.0 - (xx + zz), yz + wx, 0.0,
    xz + wy, yz - wx, 1.0 - (xx + yy), 0.0,
    0.0, 0.0, 0.0, 1.0
  );
}
fn color_mix_impl(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  let outA = src.a + dst.a * (1.0 - src.a);
  if (outA < 1e-6) { return vec4<f32>(0.0); }
  return vec4<f32>((src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / outA, outA);
}
