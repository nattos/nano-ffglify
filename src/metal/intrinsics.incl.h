
// Bit-cast helpers for packing int32 into float32 storage (preserves bit pattern).
// Used by atomic counters: CPU stores int bits as float, GPU reads via atomic_int*.
inline float int_bits_to_float(int v) { float f; std::memcpy(&f, &v, 4); return f; }
inline int float_bits_to_int(float f) { int v; std::memcpy(&v, &f, 4); return v; }

template <typename T, typename F> inline auto applyUnary(T val, F fn) {
  return fn(val);
}

template <typename T, size_t N, typename F>
inline std::array<T, N> applyUnary(const std::array<T, N> &val, F fn) {
  std::array<T, N> result;
  for (size_t i = 0; i < N; ++i)
    result[i] = fn(val[i]);
  return result;
}

template <typename T, typename F> inline auto applyBinary(T a, T b, F fn) {
  return fn(a, b);
}

template <typename T, size_t N, typename F>
inline std::array<T, N> applyBinary(const std::array<T, N> &a,
                                    const std::array<T, N> &b, F fn) {
  std::array<T, N> result;
  for (size_t i = 0; i < N; ++i)
    result[i] = fn(a[i], b[i]);
  return result;
}

template <typename T, size_t N, typename F>
inline std::array<T, N> applyBinary(const std::array<T, N> &a, T b, F fn) {
  std::array<T, N> result;
  for (size_t i = 0; i < N; ++i)
    result[i] = fn(a[i], b);
  return result;
}

template <typename T, size_t N, typename F>
inline std::array<T, N> applyBinary(T a, const std::array<T, N> &b, F fn) {
  std::array<T, N> result;
  for (size_t i = 0; i < N; ++i)
    result[i] = fn(a, b[i]);
  return result;
}

template <typename T, size_t N>
inline T vec_dot(const std::array<T, N> &a, const std::array<T, N> &b) {
  T sum = 0;
  for (size_t i = 0; i < N; ++i)
    sum += a[i] * b[i];
  return sum;
}

template <typename T, size_t N> inline T vec_length(const std::array<T, N> &v) {
  return std::sqrt(vec_dot(v, v));
}

template <typename T, size_t N>
inline std::array<T, N> vec_normalize(const std::array<T, N> &v) {
  T len = vec_length(v);
  std::array<T, N> result;
  for (size_t i = 0; i < N; ++i)
    result[i] = len > 0 ? v[i] / len : 0;
  return result;
}

// Element-wise math function overloads for std::array
#define DEFINE_ELEMENTWISE_UNARY(NAME, FN)                                     \
  template <typename T, size_t N>                                              \
  inline std::array<T, N> NAME(const std::array<T, N> &v) {                    \
    std::array<T, N> result;                                                   \
    for (size_t i = 0; i < N; ++i)                                             \
      result[i] = FN(v[i]);                                                    \
    return result;                                                             \
  }

#define DEFINE_ELEMENTWISE_BINARY(NAME, FN)                                    \
  template <typename T, size_t N>                                              \
  inline std::array<T, N> NAME(const std::array<T, N> &a,                      \
                               const std::array<T, N> &b) {                    \
    std::array<T, N> result;                                                   \
    for (size_t i = 0; i < N; ++i)                                             \
      result[i] = FN(a[i], b[i]);                                              \
    return result;                                                             \
  }                                                                            \
  template <typename T, size_t N>                                              \
  inline std::array<T, N> NAME(const std::array<T, N> &a, T b) {               \
    std::array<T, N> result;                                                   \
    for (size_t i = 0; i < N; ++i)                                             \
      result[i] = FN(a[i], b);                                                 \
    return result;                                                             \
  }                                                                            \
  template <typename T, size_t N>                                              \
  inline std::array<T, N> NAME(T a, const std::array<T, N> &b) {               \
    std::array<T, N> result;                                                   \
    for (size_t i = 0; i < N; ++i)                                             \
      result[i] = FN(a, b[i]);                                                 \
    return result;                                                             \
  }

namespace elem {
DEFINE_ELEMENTWISE_UNARY(abs, std::abs)
DEFINE_ELEMENTWISE_UNARY(sin, std::sin)
DEFINE_ELEMENTWISE_UNARY(cos, std::cos)
DEFINE_ELEMENTWISE_UNARY(tan, std::tan)
DEFINE_ELEMENTWISE_UNARY(asin, std::asin)
DEFINE_ELEMENTWISE_UNARY(acos, std::acos)
DEFINE_ELEMENTWISE_UNARY(atan, std::atan)
DEFINE_ELEMENTWISE_UNARY(sinh, std::sinh)
DEFINE_ELEMENTWISE_UNARY(cosh, std::cosh)
DEFINE_ELEMENTWISE_UNARY(tanh, std::tanh)
DEFINE_ELEMENTWISE_UNARY(sqrt, std::sqrt)
DEFINE_ELEMENTWISE_UNARY(exp, std::exp)
DEFINE_ELEMENTWISE_UNARY(exp2, std::exp2)
DEFINE_ELEMENTWISE_UNARY(log, std::log)
DEFINE_ELEMENTWISE_UNARY(log2, std::log2)
DEFINE_ELEMENTWISE_UNARY(ceil, std::ceil)
DEFINE_ELEMENTWISE_UNARY(floor, std::floor)
DEFINE_ELEMENTWISE_UNARY(round, std::round)
DEFINE_ELEMENTWISE_UNARY(trunc, std::trunc)

DEFINE_ELEMENTWISE_BINARY(fmod, std::fmod)
DEFINE_ELEMENTWISE_BINARY(pow, std::pow)
DEFINE_ELEMENTWISE_BINARY(min, std::min)
DEFINE_ELEMENTWISE_BINARY(max, std::max)
DEFINE_ELEMENTWISE_BINARY(atan2, std::atan2)
} // namespace elem

// re-export into global namespace for simpler generated code
using elem::abs;
using elem::acos;
using elem::asin;
using elem::atan;
using elem::atan2;
using elem::ceil;
using elem::cos;
using elem::cosh;
using elem::exp;
using elem::exp2;
using elem::floor;
using elem::fmod;
using elem::log;
using elem::log2;
using elem::max;
using elem::min;
using elem::pow;
using elem::round;
using elem::sin;
using elem::sinh;
using elem::sqrt;
using elem::tan;
using elem::tanh;
using elem::trunc;

// Common vector aliases
template <typename T, size_t N>
inline T dot(const std::array<T, N> &a, const std::array<T, N> &b) {
  return vec_dot(a, b);
}

template <typename T, size_t N> inline T length(const std::array<T, N> &v) {
  return vec_length(v);
}

template <typename T, size_t N>
inline std::array<T, N> normalize(const std::array<T, N> &v) {
  return vec_normalize(v);
}

template <typename T, size_t N>
inline T distance(const std::array<T, N> &a, const std::array<T, N> &b) {
  return length(applyBinary(a, b, [](T x, T y) { return x - y; }));
}

template <typename T, size_t N>
inline std::array<T, N> cross(const std::array<T, N> &a,
                              const std::array<T, N> &b) {
  static_assert(N == 3, "Cross product only defined for 3-component vectors");
  return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
          a[0] * b[1] - a[1] * b[0]};
}

template <typename T, size_t N>
inline std::array<T, N> reflect(const std::array<T, N> &i,
                                const std::array<T, N> &n) {
  T d = 2 * vec_dot(i, n);
  std::array<T, N> result;
  for (size_t k = 0; k < N; ++k)
    result[k] = i[k] - d * n[k];
  return result;
}

// Matrix multiplication helpers
template <size_t R, size_t C, size_t K>
inline std::array<float, R * C>
mat_mul_impl(const std::array<float, R * K> &a,
             const std::array<float, K * C> &b) {
  std::array<float, R * C> result = {};
  for (size_t r = 0; r < R; ++r)
    for (size_t c = 0; c < C; ++c)
      for (size_t k = 0; k < K; ++k)
        result[r * C + c] += a[r * K + k] * b[k * C + c];
  return result;
}

// mat3x3 * mat3x3
inline std::array<float, 9> mat_mul(const std::array<float, 9> &a,
                                    const std::array<float, 9> &b) {
  return mat_mul_impl<3, 3, 3>(a, b);
}
// mat4x4 * mat4x4
inline std::array<float, 16> mat_mul(const std::array<float, 16> &a,
                                     const std::array<float, 16> &b) {
  return mat_mul_impl<4, 4, 4>(a, b);
}
// mat3x3 * vec3
inline std::array<float, 3> mat_mul(const std::array<float, 9> &m,
                                    const std::array<float, 3> &v) {
  std::array<float, 3> r = {};
  for (size_t i = 0; i < 3; ++i)
    for (size_t j = 0; j < 3; ++j)
      r[i] += m[j * 3 + i] * v[j]; // column-major: M[row,col] = m[col*3+row]
  return r;
}
// mat4x4 * vec4
inline std::array<float, 4> mat_mul(const std::array<float, 16> &m,
                                    const std::array<float, 4> &v) {
  std::array<float, 4> r = {};
  for (size_t i = 0; i < 4; ++i)
    for (size_t j = 0; j < 4; ++j)
      r[i] += m[j * 4 + i] * v[j]; // column-major: M[row,col] = m[col*4+row]
  return r;
}
// vec4 * mat4x4 (pre-multiplication)
inline std::array<float, 4> mat_mul(const std::array<float, 4> &v,
                                    const std::array<float, 16> &m) {
  std::array<float, 4> r = {};
  for (size_t i = 0; i < 4; ++i)
    for (size_t j = 0; j < 4; ++j)
      r[i] += v[j] * m[j * 4 + i];
  return r;
}

// Vector mix: a + (b - a) * t (scalar t)
template <typename T, size_t N>
inline std::array<T, N> vec_mix_impl(const std::array<T, N> &a,
                                     const std::array<T, N> &b, T t) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a[i] + (b[i] - a[i]) * t;
  return r;
}
// Vector mix: a + (b - a) * t (vector t, element-wise)
template <typename T, size_t N>
inline std::array<T, N> vec_mix_impl(const std::array<T, N> &a,
                                     const std::array<T, N> &b,
                                     const std::array<T, N> &t) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a[i] + (b[i] - a[i]) * t[i];
  return r;
}

// Matrix transpose
inline std::array<float, 9> mat_transpose(const std::array<float, 9> &m) {
  return {m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]};
}
inline std::array<float, 16> mat_transpose(const std::array<float, 16> &m) {
  return {m[0], m[4], m[8],  m[12], m[1], m[5], m[9],  m[13],
          m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]};
}

// Quaternion operations (xyzw layout)
inline std::array<float, 4> quat_mul(const std::array<float, 4> &a,
                                     const std::array<float, 4> &b) {
  float x1 = a[0], y1 = a[1], z1 = a[2], w1 = a[3];
  float x2 = b[0], y2 = b[1], z2 = b[2], w2 = b[3];
  return {w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
          w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
          w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
          w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2};
}

inline std::array<float, 3> quat_rotate(const std::array<float, 4> &q,
                                        const std::array<float, 3> &v) {
  float qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  float vx = v[0], vy = v[1], vz = v[2];
  float tx = 2.0f * (qy * vz - qz * vy);
  float ty = 2.0f * (qz * vx - qx * vz);
  float tz = 2.0f * (qx * vy - qy * vx);
  return {vx + qw * tx + (qy * tz - qz * ty),
          vy + qw * ty + (qz * tx - qx * tz),
          vz + qw * tz + (qx * ty - qy * tx)};
}

inline std::array<float, 4> quat_slerp(const std::array<float, 4> &a,
                                       const std::array<float, 4> &b_in,
                                       float t) {
  float ax = a[0], ay = a[1], az = a[2], aw = a[3];
  float bx = b_in[0], by = b_in[1], bz = b_in[2], bw = b_in[3];
  float cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;
  if (std::abs(cosHalfTheta) >= 1.0f)
    return a;
  if (cosHalfTheta < 0.0f) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosHalfTheta = -cosHalfTheta;
  }
  float sinHalfTheta = std::sqrt(1.0f - cosHalfTheta * cosHalfTheta);
  if (std::abs(sinHalfTheta) < 0.001f) {
    return {ax * 0.5f + bx * 0.5f, ay * 0.5f + by * 0.5f, az * 0.5f + bz * 0.5f,
            aw * 0.5f + bw * 0.5f};
  }
  float halfTheta = std::acos(cosHalfTheta);
  float ratioA = std::sin((1.0f - t) * halfTheta) / sinHalfTheta;
  float ratioB = std::sin(t * halfTheta) / sinHalfTheta;
  return {ax * ratioA + bx * ratioB, ay * ratioA + by * ratioB,
          az * ratioA + bz * ratioB, aw * ratioA + bw * ratioB};
}

inline std::array<float, 16> quat_to_float4x4(const std::array<float, 4> &q) {
  float x = q[0], y = q[1], z = q[2], w = q[3];
  float x2 = x + x, y2 = y + y, z2 = z + z;
  float xx = x * x2, xy = x * y2, xz = x * z2;
  float yy = y * y2, yz = y * z2, zz = z * z2;
  float wx = w * x2, wy = w * y2, wz = w * z2;
  return {1 - (yy + zz),
          xy + wz,
          xz - wy,
          0,
          xy - wz,
          1 - (xx + zz),
          yz + wx,
          0,
          xz + wy,
          yz - wx,
          1 - (xx + yy),
          0,
          0,
          0,
          0,
          1};
}

// Arithmetic operator overloads for std::array (broadcasting)
template <typename T, size_t N>
inline std::array<T, N> operator+(const std::array<T, N> &a,
                                  const std::array<T, N> &b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a[i] + b[i];
  return r;
}
template <typename T, size_t N>
inline std::array<T, N> operator-(const std::array<T, N> &a,
                                  const std::array<T, N> &b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a[i] - b[i];
  return r;
}
template <typename T, size_t N>
inline std::array<T, N> operator*(const std::array<T, N> &a,
                                  const std::array<T, N> &b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a[i] * b[i];
  return r;
}
template <typename T, size_t N>
inline std::array<T, N> operator/(const std::array<T, N> &a,
                                  const std::array<T, N> &b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a[i] / b[i];
  return r;
}
// Scalar broadcasting: array op scalar
template <typename T, size_t N>
inline std::array<T, N> operator+(const std::array<T, N> &a, T b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a[i] + b;
  return r;
}
template <typename T, size_t N>
inline std::array<T, N> operator-(const std::array<T, N> &a, T b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a[i] - b;
  return r;
}
template <typename T, size_t N>
inline std::array<T, N> operator*(const std::array<T, N> &a, T b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a[i] * b;
  return r;
}
template <typename T, size_t N>
inline std::array<T, N> operator/(const std::array<T, N> &a, T b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a[i] / b;
  return r;
}
// Scalar broadcasting: scalar op array
template <typename T, size_t N>
inline std::array<T, N> operator+(T a, const std::array<T, N> &b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a + b[i];
  return r;
}
template <typename T, size_t N>
inline std::array<T, N> operator-(T a, const std::array<T, N> &b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a - b[i];
  return r;
}
template <typename T, size_t N>
inline std::array<T, N> operator*(T a, const std::array<T, N> &b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a * b[i];
  return r;
}
template <typename T, size_t N>
inline std::array<T, N> operator/(T a, const std::array<T, N> &b) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = a / b[i];
  return r;
}
// Unary negation
template <typename T, size_t N>
inline std::array<T, N> operator-(const std::array<T, N> &a) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = -a[i];
  return r;
}

// Clamp helper (works for scalars and arrays with broadcasting)
inline float clamp_val(float v, float lo, float hi) {
  return std::max(lo, std::min(hi, v));
}
template <typename T, size_t N>
inline std::array<T, N> clamp_val(const std::array<T, N> &v, T lo, T hi) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = std::max(lo, std::min(hi, v[i]));
  return r;
}
template <typename T, size_t N>
inline std::array<T, N> clamp_val(const std::array<T, N> &v,
                                  const std::array<T, N> &lo,
                                  const std::array<T, N> &hi) {
  std::array<T, N> r;
  for (size_t i = 0; i < N; ++i)
    r[i] = std::max(lo[i], std::min(hi[i], v[i]));
  return r;
}

// Resource state structure
struct ResourceState {
  std::vector<float> data;
  size_t width = 0;
  size_t height = 0;
  bool isExternal = false;
  id<MTLTexture> externalTexture = nil;
  id<MTLBuffer> retainedMetalBuffer = nil;   // Persistent GPU buffer across frames
  id<MTLTexture> retainedStagingTexture = nil; // Cached staging texture for external textures

  // Store a vector at the given index (vec stored as contiguous floats)
  template <size_t N>
  void storeVec(size_t idx, const std::array<float, N> &vec) {
    if (isExternal)
      return;
    size_t base = idx * N;
    if (base + N > data.size())
      data.resize(base + N);
    for (size_t i = 0; i < N; ++i)
      data[base + i] = vec[i];
  }

  // Load a vector from the given index
  template <size_t N> std::array<float, N> loadVec(size_t idx) const {
    if (isExternal)
      return;
    std::array<float, N> result = {};
    size_t base = idx * N;
    for (size_t i = 0; i < N && base + i < data.size(); ++i) {
      result[i] = data[base + i];
    }
    return result;
  }
};

// Context passed to generated code - includes Metal dispatch support
struct EvalContext {
  std::vector<ResourceState *> resources;

  // IR global inputs (for input inheritance)
  std::unordered_map<std::string, float> inputs;

  // Metal infrastructure
  id<MTLDevice> device = nil;
  id<MTLLibrary> library = nil;
  id<MTLCommandQueue> commandQueue = nil;
  std::unordered_map<std::string, id<MTLComputePipelineState>> pipelines;
  std::vector<id<MTLBuffer>> metalBuffers;

  // Texture support
  std::vector<bool> isTextureResource;
  std::vector<int> texWidths;
  std::vector<int> texHeights;
  std::vector<id<MTLTexture>> metalTextures;

  // Staging textures: for external (IOSurface-backed) textures that may lack
  // MTLTextureUsageShaderWrite, we create internal staging textures with full
  // usage and blit results to the external texture after GPU work completes.
  std::vector<id<MTLTexture>> stagingTextures;

  // Sampler configuration per texture: 0=repeat, 1=clamp
  std::vector<int> texWrapModes;
  std::vector<id<MTLSamplerState>> metalSamplers;

  // Deferred synchronization support
  id<MTLCommandBuffer> pendingCmdBuffer = nil;

  void waitForPendingCommands() {
    if (pendingCmdBuffer) {
      [pendingCmdBuffer waitUntilCompleted];
      pendingCmdBuffer = nil;
    }
    blitStagingToExternal();
    syncFromMetal();
  }

  // Copy staging texture contents to external (IOSurface-backed) textures.
  // This is needed because IOSurface textures may lack ShaderWrite usage,
  // so we render into a staging texture and blit the result.
  void blitStagingToExternal() {
    bool needsBlit = false;
    for (size_t i = 0; i < resources.size(); ++i) {
      if (i < stagingTextures.size() && stagingTextures[i] != nil &&
          resources[i]->isExternal && resources[i]->externalTexture) {
        needsBlit = true;
        break;
      }
    }
    if (!needsBlit) return;

    id<MTLCommandBuffer> cmdBuffer = [commandQueue commandBuffer];
    id<MTLBlitCommandEncoder> blit = [cmdBuffer blitCommandEncoder];
    for (size_t i = 0; i < resources.size(); ++i) {
      if (i < stagingTextures.size() && stagingTextures[i] != nil &&
          resources[i]->isExternal && resources[i]->externalTexture) {
        int w = stagingTextures[i].width;
        int h = stagingTextures[i].height;
        [blit copyFromTexture:stagingTextures[i]
                  sourceSlice:0
                  sourceLevel:0
                 sourceOrigin:MTLOriginMake(0, 0, 0)
                   sourceSize:MTLSizeMake(w, h, 1)
                    toTexture:resources[i]->externalTexture
             destinationSlice:0
             destinationLevel:0
            destinationOrigin:MTLOriginMake(0, 0, 0)];
      }
    }
    [blit endEncoding];
    [cmdBuffer commit];
    [cmdBuffer waitUntilScheduled];
  }

  ResourceState *getResource(size_t idx) {
    return idx < resources.size() ? resources[idx] : nullptr;
  }

  // Action log (resize, dispatch, etc.)
  struct LogAction {
    std::string type;
    std::string target;
    int width = 0;
    int height = 0;
  };
  std::vector<LogAction> actionLog;

  // Return value storage (for func_return)
  std::vector<float> returnValue;

  void setReturnValue(float val) { returnValue = {val}; }
  void setReturnValue(int val) { returnValue = {static_cast<float>(val)}; }

  template <size_t N> void setReturnValue(const std::array<float, N> &val) {
    returnValue.assign(val.begin(), val.end());
  }

  template <size_t N> void setReturnValue(const std::array<int, N> &val) {
    returnValue.resize(N);
    for (size_t i = 0; i < N; i++) returnValue[i] = static_cast<float>(val[i]);
  }

  void resizeResource(size_t idx, int newSize, int stride, bool clearData) {
    if (idx < resources.size()) {
      auto *res = resources[idx];
      if (res->isExternal)
        return;
      res->width = static_cast<size_t>(newSize);
      res->height = 1;
      size_t totalFloats =
          static_cast<size_t>(newSize) * static_cast<size_t>(stride);
      size_t newByteSize = totalFloats * sizeof(float);

      // GPU-to-GPU buffer copy when a retained GPU buffer exists
      if (res->retainedMetalBuffer != nil && device != nil) {
        id<MTLBuffer> newBuffer = resizeGpuBuffer(res->retainedMetalBuffer, newByteSize, clearData);
        res->retainedMetalBuffer = newBuffer;
        if (!metalBuffers.empty() && idx < metalBuffers.size()) {
          metalBuffers[idx] = newBuffer;
        }
      } else {
        metalBuffers.clear(); // Force syncToMetal() on next dispatch
      }

      // Always keep CPU data sized correctly (for metadata, syncFromMetal)
      if (clearData) {
        res->data.assign(totalFloats, 0.0f);
      } else {
        res->data.resize(totalFloats, 0.0f);
      }
      actionLog.push_back({"resize", "", newSize, 1});
    }
  }

  void resizeResource2D(size_t idx, int w, int h, bool clearData) {
    if (idx < resources.size()) {
      auto *res = resources[idx];
      if (res->isExternal)
        return;
      res->width = static_cast<size_t>(w);
      res->height = static_cast<size_t>(h);
      size_t total = static_cast<size_t>(w) * static_cast<size_t>(h);
      // For textures, RGBA = 4 floats per pixel
      bool isTex = idx < isTextureResource.size() && isTextureResource[idx];
      if (isTex)
        total *= 4;
      size_t newByteSize = total * sizeof(float);

      // GPU-to-GPU buffer copy when a retained GPU buffer exists
      if (res->retainedMetalBuffer != nil && device != nil) {
        id<MTLBuffer> newBuffer = resizeGpuBuffer(res->retainedMetalBuffer, newByteSize, clearData);
        res->retainedMetalBuffer = newBuffer;
        if (!metalBuffers.empty() && idx < metalBuffers.size()) {
          metalBuffers[idx] = newBuffer;
        }
      } else {
        metalBuffers.clear(); // Force syncToMetal() on next dispatch
      }

      // Always keep CPU data sized correctly (for metadata, syncFromMetal)
      if (clearData) {
        res->data.assign(total, 0.0f);
      } else {
        res->data.resize(total, 0.0f);
      }
      actionLog.push_back({"resize", "", w, h});
    }
  }

  void resizeResource2DWithClear(size_t idx, int w, int h,
                                 std::initializer_list<float> clearVal) {
    if (idx < resources.size()) {
      auto *res = resources[idx];
      res->width = static_cast<size_t>(w);
      res->height = static_cast<size_t>(h);
      size_t total = static_cast<size_t>(w) * static_cast<size_t>(h);
      bool isTex = idx < isTextureResource.size() && isTextureResource[idx];
      size_t elemSize = isTex ? 4 : 1;
      std::vector<float> pattern(clearVal);
      // Pad pattern to elemSize if needed
      while (pattern.size() < elemSize)
        pattern.push_back(0.0f);
      res->data.resize(total * elemSize);
      for (size_t i = 0; i < total; ++i) {
        for (size_t j = 0; j < elemSize && j < pattern.size(); ++j) {
          res->data[i * elemSize + j] = pattern[j];
        }
      }

      // CPU pattern data is authoritative — upload from CPU
      if (res->retainedMetalBuffer != nil && device != nil) {
        size_t byteSize = res->data.size() * sizeof(float);
        id<MTLBuffer> newBuffer =
            [device newBufferWithBytes:res->data.data()
                                length:std::max(byteSize, (size_t)sizeof(float))
                               options:MTLResourceStorageModeShared];
        res->retainedMetalBuffer = newBuffer;
        if (!metalBuffers.empty() && idx < metalBuffers.size()) {
          metalBuffers[idx] = newBuffer;
        }
      } else {
        metalBuffers.clear(); // Force syncToMetal() on next dispatch
      }
      actionLog.push_back({"resize", "", w, h});
    }
  }

  // Copy elements between buffers. stride = floats per typed element.
  // count = -1 means copy as many as fit.
  void copyBuffer(size_t srcIdx, size_t dstIdx, int stride, int srcOffset, int dstOffset, int count) {
    if (srcIdx >= resources.size() || dstIdx >= resources.size()) return;
    auto *srcRes = resources[srcIdx];
    auto *dstRes = resources[dstIdx];
    int srcElems = static_cast<int>(srcRes->data.size()) / stride;
    int dstElems = static_cast<int>(dstRes->data.size()) / stride;
    int maxFromSrc = srcElems - srcOffset;
    int maxToDst = dstElems - dstOffset;
    int actualCount = std::min(maxFromSrc, maxToDst);
    if (count >= 0) actualCount = std::min(actualCount, count);
    if (actualCount <= 0) return;
    for (int i = 0; i < actualCount; i++) {
      for (int j = 0; j < stride; j++) {
        dstRes->data[(dstOffset + i) * stride + j] = srcRes->data[(srcOffset + i) * stride + j];
      }
    }
  }

  // Copy/blit pixels between textures.
  // sampleMode: 0=direct, 1=nearest, 2=bilinear
  // Rects: sx, sy, sw, sh, dx, dy, dw, dh (-1 = use full texture dimension)
  void copyTexture(size_t srcIdx, size_t dstIdx,
                   float sx, float sy, float sw, float sh,
                   float dx, float dy, float dw, float dh,
                   int sampleMode, float alpha, bool normalized) {
    if (srcIdx >= resources.size() || dstIdx >= resources.size()) return;
    auto *srcRes = resources[srcIdx];
    auto *dstRes = resources[dstIdx];
    int srcW = static_cast<int>(srcRes->width);
    int srcH = static_cast<int>(srcRes->height);
    int dstW = static_cast<int>(dstRes->width);
    int dstH = static_cast<int>(dstRes->height);

    // Resolve rects
    int isx, isy, isw, ish, idx_, idy, idw, idh;
    if (sx < 0) { isx = 0; isy = 0; isw = srcW; ish = srcH; }
    else if (normalized) {
      isx = static_cast<int>(floorf(sx * srcW));
      isy = static_cast<int>(floorf(sy * srcH));
      isw = static_cast<int>(floorf(sw * srcW));
      ish = static_cast<int>(floorf(sh * srcH));
    } else {
      isx = static_cast<int>(floorf(sx)); isy = static_cast<int>(floorf(sy));
      isw = static_cast<int>(floorf(sw)); ish = static_cast<int>(floorf(sh));
    }
    if (dx < 0) { idx_ = 0; idy = 0; idw = dstW; idh = dstH; }
    else if (normalized) {
      idx_ = static_cast<int>(floorf(dx * dstW));
      idy = static_cast<int>(floorf(dy * dstH));
      idw = static_cast<int>(floorf(dw * dstW));
      idh = static_cast<int>(floorf(dh * dstH));
    } else {
      idx_ = static_cast<int>(floorf(dx)); idy = static_cast<int>(floorf(dy));
      idw = static_cast<int>(floorf(dw)); idh = static_cast<int>(floorf(dh));
    }

    if (alpha <= 0.0f) return;

    auto getSrcPixel = [&](int px, int py) -> std::array<float, 4> {
      int cx = std::max(0, std::min(srcW - 1, px));
      int cy = std::max(0, std::min(srcH - 1, py));
      size_t off = (cy * srcW + cx) * 4;
      if (off + 3 < srcRes->data.size()) {
        return {srcRes->data[off], srcRes->data[off+1], srcRes->data[off+2], srcRes->data[off+3]};
      }
      return {0, 0, 0, 0};
    };

    auto sampleBilinear = [&](float u, float v) -> std::array<float, 4> {
      float tx = u - 0.5f, ty = v - 0.5f;
      int x0 = static_cast<int>(floorf(tx)), y0 = static_cast<int>(floorf(ty));
      float fx = tx - x0, fy = ty - y0;
      auto s00 = getSrcPixel(x0, y0);
      auto s10 = getSrcPixel(x0+1, y0);
      auto s01 = getSrcPixel(x0, y0+1);
      auto s11 = getSrcPixel(x0+1, y0+1);
      std::array<float, 4> r;
      for (int c = 0; c < 4; c++) {
        float top = s00[c] * (1-fx) + s10[c] * fx;
        float bot = s01[c] * (1-fx) + s11[c] * fx;
        r[c] = top * (1-fy) + bot * fy;
      }
      return r;
    };

    bool needsSampling = sampleMode > 0 && (isw != idw || ish != idh);

    for (int py = 0; py < idh; py++) {
      for (int px = 0; px < idw; px++) {
        int dstX = idx_ + px;
        int dstY = idy + py;
        if (dstX < 0 || dstX >= dstW || dstY < 0 || dstY >= dstH) continue;

        std::array<float, 4> pixel;
        if (needsSampling) {
          float srcU = isx + (px + 0.5f) * isw / idw;
          float srcV = isy + (py + 0.5f) * ish / idh;
          if (sampleMode == 2) {
            pixel = sampleBilinear(srcU, srcV);
          } else {
            pixel = getSrcPixel(static_cast<int>(floorf(srcU)), static_cast<int>(floorf(srcV)));
          }
        } else {
          int srcX = isx + std::min(px, isw - 1);
          int srcY = isy + std::min(py, ish - 1);
          pixel = getSrcPixel(srcX, srcY);
        }

        size_t dstOff = (dstY * dstW + dstX) * 4;
        if (dstOff + 3 >= dstRes->data.size()) continue;

        if (alpha >= 1.0f) {
          dstRes->data[dstOff]   = pixel[0];
          dstRes->data[dstOff+1] = pixel[1];
          dstRes->data[dstOff+2] = pixel[2];
          dstRes->data[dstOff+3] = pixel[3];
        } else {
          float srcA = pixel[3] * alpha;
          float dA = dstRes->data[dstOff+3];
          float outA = srcA + dA * (1.0f - srcA);
          if (outA < 1e-5f) {
            dstRes->data[dstOff] = dstRes->data[dstOff+1] = dstRes->data[dstOff+2] = 0.0f;
          } else {
            for (int c = 0; c < 3; c++) {
              dstRes->data[dstOff+c] = (pixel[c] * srcA + dstRes->data[dstOff+c] * dA * (1.0f - srcA)) / outA;
            }
          }
          dstRes->data[dstOff+3] = outA;
        }
      }
    }
  }

  float getInput(const std::string &name) {
    auto it = inputs.find(name);
    if (it != inputs.end())
      return it->second;
    return 0.0f;
  }

  // Create a new Metal buffer and optionally blit old data into it (GPU-to-GPU copy).
  // Serial queue ordering ensures the blit executes after any pending dispatch.
  id<MTLBuffer> resizeGpuBuffer(id<MTLBuffer> oldBuffer, size_t newByteSize, bool clearData) {
    size_t safeSize = std::max(newByteSize, (size_t)sizeof(float));
    id<MTLBuffer> newBuffer = [device newBufferWithLength:safeSize
                                                  options:MTLResourceStorageModeShared];
    if (!clearData && oldBuffer != nil && oldBuffer.length > 0 && newByteSize > 0) {
      size_t copySize = std::min((size_t)oldBuffer.length, newByteSize);
      id<MTLCommandBuffer> cmdBuf = [commandQueue commandBuffer];
      id<MTLBlitCommandEncoder> blit = [cmdBuf blitCommandEncoder];
      [blit copyFromBuffer:oldBuffer sourceOffset:0
                  toBuffer:newBuffer destinationOffset:0
                      size:copySize];
      [blit endEncoding];
      [cmdBuf commit];
      pendingCmdBuffer = cmdBuf;
    }
    return newBuffer;
  }

  // CPU-side texture sampling (for CPU functions that sample textures directly)
  // wrapMode: 0=repeat, 1=clamp, 2=mirror
  // filterMode: 0=nearest, 1=linear
  // elemStride: number of floats per texel (1 for R32F, 4 for RGBA8)
  std::array<float, 4> sampleTexture(size_t resIdx, float u, float v,
                                     int wrapMode, int filterMode,
                                     int elemStride) {
    if (resIdx >= resources.size())
      return {0, 0, 0, 0};
    auto *res = resources[resIdx];
    int w = static_cast<int>(res->width);
    int h = static_cast<int>(res->height);
    if (w <= 0 || h <= 0)
      return {0, 0, 0, 0};

    auto applyWrap = [](float coord, int mode) -> float {
      if (mode == 1) { // clamp
        return std::max(0.0f, std::min(1.0f, coord));
      } else if (mode == 2) { // mirror
        float c = fmod(coord, 2.0f);
        if (c < 0)
          c += 2.0f;
        return c > 1.0f ? 2.0f - c : c;
      } else { // repeat
        return coord - floorf(coord);
      }
    };

    auto getSample = [&](int x, int y) -> std::array<float, 4> {
      // Apply wrap in pixel space
      if (wrapMode == 1) { // clamp
        x = std::max(0, std::min(w - 1, x));
        y = std::max(0, std::min(h - 1, y));
      } else if (wrapMode == 0) { // repeat
        x = ((x % w) + w) % w;
        y = ((y % h) + h) % h;
      } else if (wrapMode == 2) { // mirror
        int mx = ((x % (2 * w)) + (2 * w)) % (2 * w);
        x = mx >= w ? 2 * w - 1 - mx : mx;
        int my = ((y % (2 * h)) + (2 * h)) % (2 * h);
        y = my >= h ? 2 * h - 1 - my : my;
      }
      size_t idx = y * w + x;
      std::array<float, 4> result = {0, 0, 0, 1};
      size_t base = idx * elemStride;
      for (int i = 0; i < elemStride && i < 4 && base + i < res->data.size();
           ++i) {
        result[i] = res->data[base + i];
      }
      // For single-channel textures, replicate to RGB
      if (elemStride == 1) {
        result[1] = result[0];
        result[2] = result[0];
        result[3] = 1.0f;
      }
      return result;
    };

    float wu = applyWrap(u, wrapMode);
    float wv = applyWrap(v, wrapMode);

    if (filterMode == 0) { // nearest
      int x = std::min(static_cast<int>(wu * w), w - 1);
      int y = std::min(static_cast<int>(wv * h), h - 1);
      return getSample(x, y);
    } else { // linear (bilinear)
      float tx = wu * w - 0.5f;
      float ty = wv * h - 0.5f;
      int x0 = static_cast<int>(floorf(tx));
      int y0 = static_cast<int>(floorf(ty));
      float fx = tx - x0;
      float fy = ty - y0;

      auto s00 = getSample(x0, y0);
      auto s10 = getSample(x0 + 1, y0);
      auto s01 = getSample(x0, y0 + 1);
      auto s11 = getSample(x0 + 1, y0 + 1);

      std::array<float, 4> result;
      for (int i = 0; i < 4; ++i) {
        float r0 = s00[i] * (1 - fx) + s10[i] * fx;
        float r1 = s01[i] * (1 - fx) + s11[i] * fx;
        result[i] = r0 * (1 - fy) + r1 * fy;
      }
      return result;
    }
  }

  // Initialize Metal if not already done
  void initMetal(id<MTLDevice> existingDevice,
                 id<MTLCommandQueue> existingQueue,
                 id<MTLLibrary> existingLib = nil) {
    device = existingDevice;
    commandQueue = existingQueue;
    library = existingLib;
  }

  // Get or create pipeline for a shader function
  id<MTLComputePipelineState> getPipeline(const std::string &funcName) {
    auto it = pipelines.find(funcName);
    if (it != pipelines.end())
      return it->second;

    NSString *name = [NSString stringWithUTF8String:funcName.c_str()];
    id<MTLFunction> func = [library newFunctionWithName:name];
    if (!func) {
      std::cerr << "Shader function not found: " << funcName << std::endl;
      return nil;
    }

    NSError *error = nil;
    id<MTLComputePipelineState> pipeline =
        [device newComputePipelineStateWithFunction:func error:&error];
    if (!pipeline) {
      std::cerr << "Failed to create pipeline: "
                << (error ? [[error localizedDescription] UTF8String]
                          : "unknown")
                << std::endl;
      return nil;
    }

    pipelines[funcName] = pipeline;
    return pipeline;
  }

  // Sync CPU data to Metal buffers and textures
  void syncToMetal() {
    metalBuffers.clear();
    metalTextures.clear();
    metalTextures.resize(resources.size(), nil);
    stagingTextures.clear();
    stagingTextures.resize(resources.size(), nil);
    metalSamplers.clear();
    metalSamplers.resize(resources.size(), nil);

    for (size_t i = 0; i < resources.size(); ++i) {
      auto *res = resources[i];
      if (i < isTextureResource.size() && isTextureResource[i]) {
        if (res->isExternal && res->externalTexture) {
          // External (IOSurface-backed) textures may lack ShaderWrite usage.
          // Create a staging texture with full usage for compute/render work,
          // then blit to the external texture after GPU commands complete.
          int w = res->externalTexture.width;
          int h = res->externalTexture.height;
          // Reuse cached staging texture if dimensions match
          if (res->retainedStagingTexture != nil &&
              (int)res->retainedStagingTexture.width == w &&
              (int)res->retainedStagingTexture.height == h) {
            metalTextures[i] = res->retainedStagingTexture;
            stagingTextures[i] = res->retainedStagingTexture;
          } else {
            MTLTextureDescriptor *desc = [[MTLTextureDescriptor alloc] init];
            desc.textureType = MTLTextureType2D;
            desc.pixelFormat = res->externalTexture.pixelFormat;
            desc.width = w;
            desc.height = h;
            desc.usage = MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead |
                         MTLTextureUsageRenderTarget;
            desc.storageMode = MTLStorageModeShared;
            id<MTLTexture> staging = [device newTextureWithDescriptor:desc];
            metalTextures[i] = staging;
            stagingTextures[i] = staging;
            res->retainedStagingTexture = staging;
          }
        } else {
          // Create a Metal texture for texture resources
          MTLTextureDescriptor *desc = [[MTLTextureDescriptor alloc] init];
          desc.textureType = MTLTextureType2D;
          desc.pixelFormat = MTLPixelFormatRGBA8Unorm;
          desc.width = texWidths[i];
          desc.height = texHeights[i];
          desc.usage = MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead |
                       MTLTextureUsageRenderTarget;
          desc.storageMode = MTLStorageModeShared;
          id<MTLTexture> texture = [device newTextureWithDescriptor:desc];
          metalTextures[i] = texture;

          // Upload pre-populated texture data if available (float RGBA -> RGBA8
          // bytes)
          if (!res->data.empty()) {
            int w = texWidths[i];
            int h = texHeights[i];
            size_t pixelCount = w * h;
            if (res->data.size() >= pixelCount * 4) {
              std::vector<uint8_t> bytes(pixelCount * 4);
              for (size_t j = 0; j < pixelCount * 4; ++j) {
                float v = std::max(0.0f, std::min(1.0f, res->data[j]));
                bytes[j] = static_cast<uint8_t>(v * 255.0f + 0.5f);
              }
              MTLRegion region = MTLRegionMake2D(0, 0, w, h);
              [texture replaceRegion:region
                         mipmapLevel:0
                           withBytes:bytes.data()
                         bytesPerRow:w * 4];
            }
          }
        }

        // Create sampler for this texture (needed for both internal and
        // external)
        MTLSamplerDescriptor *samplerDesc = [[MTLSamplerDescriptor alloc] init];
        samplerDesc.minFilter = MTLSamplerMinMagFilterNearest;
        samplerDesc.magFilter = MTLSamplerMinMagFilterNearest;
        int wrapMode = (i < texWrapModes.size()) ? texWrapModes[i] : 0;
        if (wrapMode == 1) {
          samplerDesc.sAddressMode = MTLSamplerAddressModeClampToEdge;
          samplerDesc.tAddressMode = MTLSamplerAddressModeClampToEdge;
        } else {
          samplerDesc.sAddressMode = MTLSamplerAddressModeRepeat;
          samplerDesc.tAddressMode = MTLSamplerAddressModeRepeat;
        }
        metalSamplers[i] = [device newSamplerStateWithDescriptor:samplerDesc];

        // Create a dummy buffer placeholder to keep indices aligned
        float dummy = 0;
        metalBuffers.push_back([device
            newBufferWithBytes:&dummy
                        length:sizeof(float)
                       options:MTLResourceStorageModeShared]);
      } else {
        // Safety check: invalidate retained buffer if size doesn't match
        if (res->retainedMetalBuffer != nil) {
          size_t expectedSize = res->data.size() * sizeof(float);
          if (res->retainedMetalBuffer.length != expectedSize) {
            res->retainedMetalBuffer = nil;
          }
        }
        if (res->retainedMetalBuffer != nil) {
          // Reuse persistent GPU buffer (data stays on GPU across frames)
          metalBuffers.push_back(res->retainedMetalBuffer);
        } else {
          size_t byteSize = res->data.size() * sizeof(float);
          id<MTLBuffer> buffer =
              [device newBufferWithBytes:res->data.data()
                                  length:byteSize
                                 options:MTLResourceStorageModeShared];
          metalBuffers.push_back(buffer);
          res->retainedMetalBuffer = buffer;
        }
        metalTextures.push_back(nil);
      }
    }

    // Blit external input textures into their staging textures so shaders
    // can read input data. (Output textures are written by shaders and
    // blitted back to external in blitStagingToExternal.)
    blitExternalToStaging();
  }

  // Copy external (IOSurface) input textures into staging textures before
  // shader execution, so shaders can read input data with full access.
  void blitExternalToStaging() {
    bool needsBlit = false;
    for (size_t i = 0; i < resources.size(); ++i) {
      if (i < stagingTextures.size() && stagingTextures[i] != nil &&
          resources[i]->isExternal && resources[i]->externalTexture) {
        needsBlit = true;
        break;
      }
    }
    if (!needsBlit) return;

    id<MTLCommandBuffer> cmdBuffer = [commandQueue commandBuffer];
    id<MTLBlitCommandEncoder> blit = [cmdBuffer blitCommandEncoder];
    for (size_t i = 0; i < resources.size(); ++i) {
      if (i < stagingTextures.size() && stagingTextures[i] != nil &&
          resources[i]->isExternal && resources[i]->externalTexture) {
        int w = resources[i]->externalTexture.width;
        int h = resources[i]->externalTexture.height;
        [blit copyFromTexture:resources[i]->externalTexture
                  sourceSlice:0
                  sourceLevel:0
                 sourceOrigin:MTLOriginMake(0, 0, 0)
                   sourceSize:MTLSizeMake(w, h, 1)
                    toTexture:stagingTextures[i]
             destinationSlice:0
             destinationLevel:0
            destinationOrigin:MTLOriginMake(0, 0, 0)];
      }
    }
    [blit endEncoding];
    [cmdBuffer commit];
  }

  // Sync Metal buffers and textures back to CPU
  void syncFromMetal() {
    for (size_t i = 0; i < resources.size(); ++i) {
      if (resources[i]->isExternal) continue;
      if (i < metalTextures.size() && metalTextures[i] != nil) {
        // Read back texture data as RGBA8 bytes, convert to floats
        int w = texWidths[i];
        int h = texHeights[i];
        size_t bytesPerRow = w * 4; // RGBA8 = 4 bytes per pixel
        std::vector<uint8_t> bytes(w * h * 4);
        MTLRegion region = MTLRegionMake2D(0, 0, w, h);
        [metalTextures[i] getBytes:bytes.data()
                       bytesPerRow:bytesPerRow
                        fromRegion:region
                       mipmapLevel:0];
        // Convert RGBA8 bytes to float (0.0-1.0 range)
        resources[i]->data.resize(w * h * 4);
        for (size_t j = 0; j < bytes.size(); ++j) {
          resources[i]->data[j] = bytes[j] / 255.0f;
        }
      } else if (i < metalBuffers.size()) {
        float *ptr = (float *)[metalBuffers[i] contents];
        size_t count = resources[i]->data.size();
        for (size_t j = 0; j < count; ++j) {
          resources[i]->data[j] = ptr[j];
        }
      }
    }
  }

  // Dispatch a compute shader (no args version)
  void dispatchShader(const char *funcName, int dimX, int dimY, int dimZ) {
    dispatchShaderImpl(funcName, dimX, dimY, dimZ, nullptr, 0);
  }

  // Dispatch with args (initializer list)
  void dispatchShader(const char *funcName, int dimX, int dimY, int dimZ,
                      std::initializer_list<float> args) {
    std::vector<float> argsVec(args);
    dispatchShaderImpl(funcName, dimX, dimY, dimZ, argsVec.data(),
                       argsVec.size());
  }

  // Dispatch with args (vector - used for complex type marshalling)
  void dispatchShader(const char *funcName, int dimX, int dimY, int dimZ,
                      const std::vector<float> &args) {
    dispatchShaderImpl(funcName, dimX, dimY, dimZ,
                       const_cast<float *>(args.data()), args.size());
  }

  void dispatchShaderImpl(const char *funcName, int dimX, int dimY, int dimZ,
                          float *args, size_t argCount) {
    id<MTLComputePipelineState> pipeline = getPipeline(funcName);
    if (!pipeline)
      return;

    // Sync CPU data to GPU if not done yet
    if (metalBuffers.empty()) {
      syncToMetal();
    }

    id<MTLCommandBuffer> cmdBuffer = [commandQueue commandBuffer];
    id<MTLComputeCommandEncoder> encoder = [cmdBuffer computeCommandEncoder];
    [encoder setComputePipelineState:pipeline];

    // Bind uniform buffer with args (binding 0)
    if (argCount > 0) {
      id<MTLBuffer> argsBuffer =
          [device newBufferWithBytes:args
                              length:argCount * sizeof(float)
                             options:MTLResourceStorageModeShared];
      [encoder setBuffer:argsBuffer offset:0 atIndex:0];
    } else {
      // Empty uniform buffer
      float dummy = 0;
      id<MTLBuffer> argsBuffer =
          [device newBufferWithBytes:&dummy
                              length:sizeof(float)
                             options:MTLResourceStorageModeShared];
      [encoder setBuffer:argsBuffer offset:0 atIndex:0];
    }

    // Bind resource buffers, textures, and samplers (starting at binding 1)
    // Always use metalTextures (which are staging textures for external resources)
    for (size_t i = 0; i < resources.size(); ++i) {
      if (i < metalTextures.size() && metalTextures[i] != nil) {
        [encoder setTexture:metalTextures[i] atIndex:i + 1];
        if (i < metalSamplers.size() && metalSamplers[i] != nil) {
          [encoder setSamplerState:metalSamplers[i] atIndex:i + 1];
        }
      } else if (i < metalBuffers.size()) {
        [encoder setBuffer:metalBuffers[i] offset:0 atIndex:i + 1];
      }
    }

    MTLSize gridSize = MTLSizeMake(dimX, dimY, dimZ);
    NSUInteger w = pipeline.threadExecutionWidth;
    NSUInteger h = pipeline.maxTotalThreadsPerThreadgroup / w;
    MTLSize threadGroupSize = MTLSizeMake(w, h, 1);
    [encoder dispatchThreads:gridSize threadsPerThreadgroup:threadGroupSize];
    [encoder endEncoding];

    [cmdBuffer commit];
    pendingCmdBuffer = cmdBuffer;
  }

  // Draw call (render pipeline)
  void draw(size_t targetIdx, const char *vsFunc, const char *fsFunc,
            int vertexCount,
            const std::vector<float> &args = {}) {
    if (metalBuffers.empty()) {
      syncToMetal();
    }

    if (targetIdx >= metalTextures.size() || metalTextures[targetIdx] == nil) {
      std::cerr << "Draw target texture not found for index " << targetIdx
                << std::endl;
      return;
    }

    MTLRenderPipelineDescriptor *pipelineDesc =
        [[MTLRenderPipelineDescriptor alloc] init];
    pipelineDesc.colorAttachments[0].pixelFormat =
        metalTextures[targetIdx].pixelFormat;

    NSString *vsName = [NSString stringWithUTF8String:vsFunc];
    NSString *fsName = [NSString stringWithUTF8String:fsFunc];

    pipelineDesc.vertexFunction = [library newFunctionWithName:vsName];
    pipelineDesc.fragmentFunction = [library newFunctionWithName:fsName];

    if (!pipelineDesc.vertexFunction || !pipelineDesc.fragmentFunction) {
      std::cerr << "Failed to load shaders for draw: " << vsFunc << ", "
                << fsFunc << std::endl;
      return;
    }

    NSError *error = nil;
    id<MTLRenderPipelineState> pipelineState =
        [device newRenderPipelineStateWithDescriptor:pipelineDesc error:&error];
    if (!pipelineState) {
      std::cerr << "Failed to create render pipeline state: "
                << (error ? [[error localizedDescription] UTF8String]
                          : "unknown")
                << std::endl;
      return;
    }

    MTLRenderPassDescriptor *passDesc =
        [MTLRenderPassDescriptor renderPassDescriptor];
    passDesc.colorAttachments[0].texture = metalTextures[targetIdx];
    passDesc.colorAttachments[0].loadAction = MTLLoadActionClear;
    passDesc.colorAttachments[0].clearColor =
        MTLClearColorMake(0, 0, 0, 0); // Clear to transparent black
    passDesc.colorAttachments[0].storeAction = MTLStoreActionStore;

    id<MTLCommandBuffer> cmdBuffer = [commandQueue commandBuffer];
    id<MTLRenderCommandEncoder> encoder =
        [cmdBuffer renderCommandEncoderWithDescriptor:passDesc];
    [encoder setRenderPipelineState:pipelineState];

    // Bind global inputs buffer at binding 0 (shared with vertex/fragment)
    if (!args.empty()) {
      id<MTLBuffer> argsBuffer =
          [device newBufferWithBytes:args.data()
                              length:args.size() * sizeof(float)
                             options:MTLResourceStorageModeShared];
      [encoder setVertexBuffer:argsBuffer offset:0 atIndex:0];
      [encoder setFragmentBuffer:argsBuffer offset:0 atIndex:0];
    }

    // Bind resources (buffers and textures) to both vertex and fragment stages
    // Always use metalTextures (staging textures for external resources)
    for (size_t i = 0; i < resources.size(); ++i) {
      if (i < metalTextures.size() && metalTextures[i] != nil) {
        [encoder setVertexTexture:metalTextures[i] atIndex:i + 1];
        [encoder setFragmentTexture:metalTextures[i] atIndex:i + 1];
        if (i < metalSamplers.size() && metalSamplers[i] != nil) {
          [encoder setVertexSamplerState:metalSamplers[i] atIndex:i + 1];
          [encoder setFragmentSamplerState:metalSamplers[i] atIndex:i + 1];
        }
      } else if (i < metalBuffers.size()) {
        [encoder setVertexBuffer:metalBuffers[i] offset:0 atIndex:i + 1];
        [encoder setFragmentBuffer:metalBuffers[i] offset:0 atIndex:i + 1];
      }
    }

    [encoder drawPrimitives:MTLPrimitiveTypeTriangle
                vertexStart:0
                vertexCount:vertexCount];
    [encoder endEncoding];

    [cmdBuffer commit];
    pendingCmdBuffer = cmdBuffer;
  }
};
