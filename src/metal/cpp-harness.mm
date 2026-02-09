// Extended Metal/C++ runner for conformance tests
// Accepts generated C++ and resource definitions, executes, returns JSON

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

// =====================
// Intrinsic Helpers (same as cpp-generator.ts emits)
// =====================

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
      r[i] += m[j * 3 + i] * v[j];  // column-major: M[row,col] = m[col*3+row]
  return r;
}
// mat4x4 * vec4
inline std::array<float, 4> mat_mul(const std::array<float, 16> &m,
                                    const std::array<float, 4> &v) {
  std::array<float, 4> r = {};
  for (size_t i = 0; i < 4; ++i)
    for (size_t j = 0; j < 4; ++j)
      r[i] += m[j * 4 + i] * v[j];  // column-major: M[row,col] = m[col*4+row]
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
  return {m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13],
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
  if (std::abs(cosHalfTheta) >= 1.0f) return a;
  if (cosHalfTheta < 0.0f) { bx = -bx; by = -by; bz = -bz; bw = -bw; cosHalfTheta = -cosHalfTheta; }
  float sinHalfTheta = std::sqrt(1.0f - cosHalfTheta * cosHalfTheta);
  if (std::abs(sinHalfTheta) < 0.001f) {
    return {ax * 0.5f + bx * 0.5f, ay * 0.5f + by * 0.5f,
            az * 0.5f + bz * 0.5f, aw * 0.5f + bw * 0.5f};
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
  return {1-(yy+zz), xy+wz, xz-wy, 0,
          xy-wz, 1-(xx+zz), yz+wx, 0,
          xz+wy, yz-wx, 1-(xx+yy), 0,
          0, 0, 0, 1};
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

  // Store a vector at the given index (vec stored as contiguous floats)
  template <size_t N>
  void storeVec(size_t idx, const std::array<float, N> &vec) {
    size_t base = idx * N;
    if (base + N > data.size())
      data.resize(base + N);
    for (size_t i = 0; i < N; ++i)
      data[base + i] = vec[i];
  }

  // Load a vector from the given index
  template <size_t N> std::array<float, N> loadVec(size_t idx) const {
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

  void setReturnValue(float val) {
    returnValue = {val};
  }

  template <size_t N>
  void setReturnValue(const std::array<float, N> &val) {
    returnValue.assign(val.begin(), val.end());
  }

  void resizeResource(size_t idx, int newSize, int stride, bool clearData) {
    if (idx < resources.size()) {
      auto *res = resources[idx];
      res->width = static_cast<size_t>(newSize);
      res->height = 1;
      size_t totalFloats = static_cast<size_t>(newSize) * static_cast<size_t>(stride);
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
      res->width = static_cast<size_t>(w);
      res->height = static_cast<size_t>(h);
      size_t total = static_cast<size_t>(w) * static_cast<size_t>(h);
      // For textures, RGBA = 4 floats per pixel
      bool isTex = idx < isTextureResource.size() && isTextureResource[idx];
      if (isTex) total *= 4;
      if (clearData) {
        res->data.assign(total, 0.0f);
      } else {
        res->data.resize(total, 0.0f);
      }
      actionLog.push_back({"resize", "", w, h});
    }
  }

  float getInput(const std::string &name) {
    auto it = inputs.find(name);
    if (it != inputs.end())
      return it->second;
    return 0.0f;
  }

  // Initialize Metal if not already done
  void initMetal() {
    if (!device) {
      device = MTLCreateSystemDefaultDevice();
      commandQueue = [device newCommandQueue];
    }
  }

  // Load a .metallib file
  bool loadMetalLib(const char *path) {
    initMetal();
    NSError *error = nil;
    NSString *nsPath = [NSString stringWithUTF8String:path];
    library = [device newLibraryWithFile:nsPath error:&error];
    if (!library) {
      std::cerr << "Failed to load metallib: "
                << (error ? [[error localizedDescription] UTF8String]
                          : "unknown")
                << std::endl;
      return false;
    }
    return true;
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

    for (size_t i = 0; i < resources.size(); ++i) {
      auto *res = resources[i];
      if (i < isTextureResource.size() && isTextureResource[i]) {
        // Create a Metal texture for texture resources
        MTLTextureDescriptor *desc = [[MTLTextureDescriptor alloc] init];
        desc.textureType = MTLTextureType2D;
        desc.pixelFormat = MTLPixelFormatRGBA8Unorm;
        desc.width = texWidths[i];
        desc.height = texHeights[i];
        desc.usage = MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead;
        desc.storageMode = MTLStorageModeShared;
        id<MTLTexture> texture = [device newTextureWithDescriptor:desc];
        metalTextures[i] = texture;
        // Create a dummy buffer placeholder to keep indices aligned
        float dummy = 0;
        metalBuffers.push_back(
            [device newBufferWithBytes:&dummy
                                length:sizeof(float)
                               options:MTLResourceStorageModeShared]);
      } else {
        size_t byteSize = res->data.size() * sizeof(float);
        id<MTLBuffer> buffer =
            [device newBufferWithBytes:res->data.data()
                                length:byteSize
                               options:MTLResourceStorageModeShared];
        metalBuffers.push_back(buffer);
        metalTextures.push_back(nil);
      }
    }
  }

  // Sync Metal buffers and textures back to CPU
  void syncFromMetal() {
    for (size_t i = 0; i < resources.size(); ++i) {
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

    // Bind resource buffers and textures (starting at binding 1)
    for (size_t i = 0; i < resources.size(); ++i) {
      if (i < metalTextures.size() && metalTextures[i] != nil) {
        [encoder setTexture:metalTextures[i] atIndex:i + 1];
      } else if (i < metalBuffers.size()) {
        [encoder setBuffer:metalBuffers[i] offset:0 atIndex:i + 1];
      }
    }

    MTLSize gridSize = MTLSizeMake(dimX, dimY, dimZ);
    MTLSize threadGroupSize = MTLSizeMake(1, 1, 1);
    [encoder dispatchThreads:gridSize threadsPerThreadgroup:threadGroupSize];
    [encoder endEncoding];

    [cmdBuffer commit];
    [cmdBuffer waitUntilCompleted];

    // Sync back to CPU
    syncFromMetal();
  }
};

// =====================
// Generated code will be included here
// =====================
#include "generated_code.cpp"

// =====================
// Main harness
// =====================

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    // Parse arguments: [metallib_path] [-i name:value ...] <resource_specs...>
    // If first arg ends with .metallib, it's the shader library path
    // -i name:value sets an input variable
    // Resource specs: <size> for buffers, T:<width>:<height> for textures

    EvalContext ctx;
    std::vector<ResourceState> resourceStorage;

    int argStart = 1;

    // Check if first argument is a metallib path
    if (argc > 1) {
      std::string firstArg = argv[1];
      if (firstArg.size() > 9 &&
          firstArg.substr(firstArg.size() - 9) == ".metallib") {
        ctx.loadMetalLib(argv[1]);
        argStart = 2;
      }
    }

    // Parse -i input args first, then resource specs
    std::vector<std::string> resourceArgs;
    for (int i = argStart; i < argc; ++i) {
      std::string arg = argv[i];
      if (arg == "-i" && i + 1 < argc) {
        // Parse name:value
        std::string input = argv[++i];
        auto colonPos = input.find(':');
        if (colonPos != std::string::npos) {
          std::string name = input.substr(0, colonPos);
          float value = std::stof(input.substr(colonPos + 1));
          ctx.inputs[name] = value;
        }
      } else {
        resourceArgs.push_back(arg);
      }
    }

    // Parse resource specs
    for (const auto &arg : resourceArgs) {
      if (arg.size() > 2 && arg[0] == 'T' && arg[1] == ':') {
        // Texture: T:<width>:<height>
        auto firstColon = arg.find(':', 2);
        int w = std::stoi(arg.substr(2, firstColon - 2));
        int h = std::stoi(arg.substr(firstColon + 1));
        // RGBA8 texture: w*h*4 floats
        resourceStorage.push_back(
            ResourceState{std::vector<float>(w * h * 4, 0.0f), (size_t)w,
                          (size_t)h});
        ctx.isTextureResource.push_back(true);
        ctx.texWidths.push_back(w);
        ctx.texHeights.push_back(h);
      } else {
        // Buffer: <size>
        size_t size = std::stoull(arg);
        resourceStorage.push_back(
            ResourceState{std::vector<float>(size, 0.0f), size, 1});
        ctx.isTextureResource.push_back(false);
        ctx.texWidths.push_back(0);
        ctx.texHeights.push_back(0);
      }
    }

    // Set up context pointers
    for (auto &res : resourceStorage) {
      ctx.resources.push_back(&res);
    }

    // Call generated entry point
    func_main(ctx);

    // Helper to output JSON-safe float (NaN → null, ±Inf → ±1e999)
    auto emitFloat = [](float v) {
      if (std::isnan(v)) std::cout << "null";
      else if (std::isinf(v)) std::cout << (v > 0 ? "1e999" : "-1e999");
      else std::cout << std::setprecision(10) << v;
    };

    // Output resources as JSON
    std::cout << "{\"resources\":[";
    for (size_t r = 0; r < ctx.resources.size(); ++r) {
      if (r > 0)
        std::cout << ",";
      auto *res = ctx.resources[r];
      bool isTex = r < ctx.isTextureResource.size() && ctx.isTextureResource[r];
      std::cout << "{\"type\":\"" << (isTex ? "texture" : "buffer")
                << "\",\"width\":" << res->width
                << ",\"height\":" << res->height
                << ",\"data\":[";
      for (size_t i = 0; i < res->data.size(); ++i) {
        if (i > 0)
          std::cout << ",";
        emitFloat(res->data[i]);
      }
      std::cout << "]}";
    }
    std::cout << "]";

    // Output return value if set
    if (!ctx.returnValue.empty()) {
      std::cout << ",\"returnValue\":[";
      for (size_t i = 0; i < ctx.returnValue.size(); ++i) {
        if (i > 0) std::cout << ",";
        emitFloat(ctx.returnValue[i]);
      }
      std::cout << "]";
    }

    // Output action log
    if (!ctx.actionLog.empty()) {
      std::cout << ",\"log\":[";
      for (size_t i = 0; i < ctx.actionLog.size(); ++i) {
        if (i > 0) std::cout << ",";
        auto &a = ctx.actionLog[i];
        std::cout << "{\"type\":\"" << a.type << "\"";
        if (!a.target.empty()) std::cout << ",\"target\":\"" << a.target << "\"";
        std::cout << ",\"width\":" << a.width << ",\"height\":" << a.height;
        std::cout << "}";
      }
      std::cout << "]";
    }

    std::cout << "}" << std::endl;

    return 0;
  }
}
