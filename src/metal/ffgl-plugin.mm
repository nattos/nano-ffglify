
#include <array>
#include <cmath>
#include <dlfcn.h>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>
void WriteLog(const std::string &msg) {
  // Silent in production
}

extern "C" {
void RegisterMetalTextureForGL(unsigned int glHandle, void *mtlTexturePtr);
}

#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <MetalKit/MetalKit.h>

#import "AAPLOpenGLMetalInteropTexture.h"
#include <FFGL.h>
#include <FFGLLib.h>
#include <FFGLPluginSDK.h>
#include <fstream>

// =====================
// Custom OpenGL Helpers (Replacing ffglex)
// =====================

namespace native_gl {

struct ScopedFBO {
  GLint original;
  ScopedFBO() { glGetIntegerv(GL_FRAMEBUFFER_BINDING, &original); }
  ScopedFBO(GLuint fbo) : ScopedFBO() {
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  }
  ~ScopedFBO() { glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)original); }
};

// Function Pointers for VAO
typedef void (*GenVertexArraysPtr)(GLsizei, GLuint *);
typedef void (*BindVertexArrayPtr)(GLuint);
typedef void (*DeleteVertexArraysPtr)(GLsizei, const GLuint *);
typedef void (*EnableVertexAttribArrayPtr)(GLuint);
typedef void (*VertexAttribPointerPtr)(GLuint, GLint, GLenum, GLboolean,
                                       GLsizei, const GLvoid *);

static GenVertexArraysPtr glGenVertexArraysFunc = nullptr;
static BindVertexArrayPtr glBindVertexArrayFunc = nullptr;
static DeleteVertexArraysPtr glDeleteVertexArraysFunc = nullptr;
static EnableVertexAttribArrayPtr glEnableVertexAttribArrayFunc = nullptr;
static VertexAttribPointerPtr glVertexAttribPointerFunc = nullptr;

void InitGLFuncs() {
  if (!glGenVertexArraysFunc) {
    glGenVertexArraysFunc =
        (GenVertexArraysPtr)dlsym(RTLD_DEFAULT, "glGenVertexArrays");
    // Fallback to APPLE if needed? No, Core Profile should have standard.
    if (!glGenVertexArraysFunc)
      glGenVertexArraysFunc =
          (GenVertexArraysPtr)dlsym(RTLD_DEFAULT, "glGenVertexArraysAPPLE");
  }
  if (!glBindVertexArrayFunc) {
    glBindVertexArrayFunc =
        (BindVertexArrayPtr)dlsym(RTLD_DEFAULT, "glBindVertexArray");
    if (!glBindVertexArrayFunc)
      glBindVertexArrayFunc =
          (BindVertexArrayPtr)dlsym(RTLD_DEFAULT, "glBindVertexArrayAPPLE");
  }
  if (!glDeleteVertexArraysFunc) {
    glDeleteVertexArraysFunc =
        (DeleteVertexArraysPtr)dlsym(RTLD_DEFAULT, "glDeleteVertexArrays");
    if (!glDeleteVertexArraysFunc)
      glDeleteVertexArraysFunc = (DeleteVertexArraysPtr)dlsym(
          RTLD_DEFAULT, "glDeleteVertexArraysAPPLE");
  }

  // Dynamic load attribute functions too, just in case linking is broken
  if (!glEnableVertexAttribArrayFunc) {
    glEnableVertexAttribArrayFunc = (EnableVertexAttribArrayPtr)dlsym(
        RTLD_DEFAULT, "glEnableVertexAttribArray");
    if (!glEnableVertexAttribArrayFunc)
      glEnableVertexAttribArrayFunc = (EnableVertexAttribArrayPtr)dlsym(
          RTLD_DEFAULT, "glEnableVertexAttribArrayARB");
  }
  if (!glVertexAttribPointerFunc) {
    glVertexAttribPointerFunc =
        (VertexAttribPointerPtr)dlsym(RTLD_DEFAULT, "glVertexAttribPointer");
    if (!glVertexAttribPointerFunc)
      glVertexAttribPointerFunc = (VertexAttribPointerPtr)dlsym(
          RTLD_DEFAULT, "glVertexAttribPointerARB");
  }

  WriteLog("InitGLFuncs loaded symbols");
}

struct ScopedShader {
  GLint original;
  ScopedShader() { glGetIntegerv(GL_CURRENT_PROGRAM, &original); }
  ScopedShader(GLuint program) : ScopedShader() { glUseProgram(program); }
  ~ScopedShader() { glUseProgram((GLuint)original); }
};

struct ScopedTexture {
  GLenum target;
  GLint original;
  ScopedTexture(GLenum t, GLuint tex) : target(t) {
    if (t == GL_TEXTURE_2D)
      glGetIntegerv(GL_TEXTURE_BINDING_2D, &original);
    else
      glGetIntegerv(GL_TEXTURE_BINDING_RECTANGLE, &original);
    glBindTexture(t, tex);
  }
  ~ScopedTexture() { glBindTexture(target, (GLuint)original); }
};

struct ScopedSampler {
  GLint active;
  ScopedSampler(int unit) {
    glGetIntegerv(GL_ACTIVE_TEXTURE, &active);
    glActiveTexture(GL_TEXTURE0 + unit);
  }
  ~ScopedSampler() { glActiveTexture((GLenum)active); }
};

class GLShader {
public:
  GLuint program = 0;
  bool Compile(const char *vs, const char *fs) {
    GLuint v = glCreateShader(GL_VERTEX_SHADER);
    glShaderSource(v, 1, &vs, NULL);
    glCompileShader(v);

    GLuint f = glCreateShader(GL_FRAGMENT_SHADER);
    glShaderSource(f, 1, &fs, NULL);
    glCompileShader(f);

    program = glCreateProgram();
    glAttachShader(program, v);
    glAttachShader(program, f);

    glBindAttribLocation(program, 0, "vPos");
    glBindAttribLocation(program, 1, "vTex");

    glLinkProgram(program);

    glDeleteShader(v);
    glDeleteShader(f);

    GLint status;
    glGetProgramiv(program, GL_LINK_STATUS, &status);
    if (status != GL_TRUE) {
      WriteLog("Shader Link Failed");
    }
    return status == GL_TRUE;
  }
  void SetInt(const char *name, int val) {
    glUniform1i(glGetUniformLocation(program, name), val);
  }
  void SetFloat(const char *name, float val) {
    glUniform1f(glGetUniformLocation(program, name), val);
  }
  void SetVec2(const char *name, float v1, float v2) {
    glUniform2f(glGetUniformLocation(program, name), v1, v2);
  }
  void Free() {
    if (program)
      glDeleteProgram(program);
    program = 0;
  }
};

class GLQuad {
  GLuint vao = 0, vbo = 0;

public:
  void Initialise() {
    InitGLFuncs(); // Ensure pointers are loaded

    float verts[] = {-1, -1, 0, 0, 1, -1, 1, 0, 1, 1, 1, 1, -1, 1, 0, 1};

    if (glGenVertexArraysFunc) {
      glGenVertexArraysFunc(1, &vao);
    } else {
      WriteLog("ERROR: glGenVertexArrays not found!");
    }

    if (vao == 0) {
      WriteLog("VAO Generation Failed");
      return;
    }

    glGenBuffers(1, &vbo);

    if (glBindVertexArrayFunc)
      glBindVertexArrayFunc(vao);

    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
    if (glEnableVertexAttribArrayFunc)
      glEnableVertexAttribArrayFunc(0);
    else
      glEnableVertexAttribArray(0);

    if (glVertexAttribPointerFunc)
      glVertexAttribPointerFunc(0, 2, GL_FLOAT, GL_FALSE, 4 * 4, 0);
    else
      glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * 4, 0);

    GLenum err = glGetError();
    if (err != GL_NO_ERROR)
      WriteLog("Error setting Pos attrib: " + std::to_string(err));

    if (glEnableVertexAttribArrayFunc)
      glEnableVertexAttribArrayFunc(1);
    else
      glEnableVertexAttribArray(1);

    if (glVertexAttribPointerFunc)
      glVertexAttribPointerFunc(1, 2, GL_FLOAT, GL_FALSE, 4 * 4, (void *)8);
    else
      glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * 4, (void *)8);

    err = glGetError();
    if (err != GL_NO_ERROR)
      WriteLog("Error setting UV attrib: " + std::to_string(err));

    if (glBindVertexArrayFunc)
      glBindVertexArrayFunc(0);
  }
  void Draw() {
    if (vao == 0)
      WriteLog("Draw called with VAO=0");
    if (glBindVertexArrayFunc) {
      glBindVertexArrayFunc(vao);
      glDrawArrays(GL_TRIANGLE_FAN, 0, 4);
      glBindVertexArrayFunc(0);
    } else {
      WriteLog("ERROR: glBindVertexArray not found in Draw!");
    }
  }
  void Free() {
    if (vao && glDeleteVertexArraysFunc)
      glDeleteVertexArraysFunc(1, &vao);
    if (vbo)
      glDeleteBuffers(1, &vbo);
    vao = vbo = 0;
  }
};

} // namespace native_gl

#ifndef PLUGIN_NAME
#define PLUGIN_NAME "NanoFFGL"
#endif
#ifndef PLUGIN_CODE
#define PLUGIN_CODE "NANO"
#endif
#ifndef PLUGIN_TYPE
#define PLUGIN_TYPE FF_EFFECT
#endif
#ifndef MIN_INPUTS
#define MIN_INPUTS 1
#endif
#ifndef MAX_INPUTS
#define MAX_INPUTS 1
#endif

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
      r[i] += m[i * 3 + j] * v[j];
  return r;
}
// mat4x4 * vec4
inline std::array<float, 4> mat_mul(const std::array<float, 16> &m,
                                    const std::array<float, 4> &v) {
  std::array<float, 4> r = {};
  for (size_t i = 0; i < 4; ++i)
    for (size_t j = 0; j < 4; ++j)
      r[i] += m[i * 4 + j] * v[j];
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

// Resource state structure
struct ResourceState {
  std::vector<float> data;
  size_t width = 0;
  size_t height = 0;
  bool isExternal = false;
  id<MTLTexture> externalTexture = nil;

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

  template <size_t N> std::array<float, N> loadVec(size_t idx) const {
    if (isExternal)
      return {};
    std::array<float, N> result = {};
    size_t base = idx * N;
    for (size_t i = 0; i < N && base + i < data.size(); ++i) {
      result[i] = data[base + i];
    }
    return result;
  }
};

struct EvalContext {
  std::vector<ResourceState *> resources;
  std::unordered_map<std::string, float> inputs;

  id<MTLDevice> device = nil;
  id<MTLLibrary> library = nil;
  id<MTLCommandQueue> commandQueue = nil;
  id<MTLSamplerState> samplerState = nil;
  std::unordered_map<std::string, id<MTLComputePipelineState>> pipelines;

  ResourceState *getResource(size_t idx) {
    return idx < resources.size() ? resources[idx] : nullptr;
  }

  void resizeResource(size_t idx, int newSize, bool clearData) {
    if (idx < resources.size()) {
      auto *res = resources[idx];
      if (res->isExternal)
        return;
      res->width = static_cast<size_t>(newSize);
      res->height = 1;
      if (clearData) {
        res->data.assign(static_cast<size_t>(newSize), 0.0f);
      } else {
        res->data.resize(static_cast<size_t>(newSize), 0.0f);
      }
    }
  }

  float getInput(const std::string &name) {
    auto it = inputs.find(name);
    if (it != inputs.end())
      return it->second;
    return 0.0f;
  }

  void initMetal(id<MTLDevice> existingDevice,
                 id<MTLCommandQueue> existingQueue,
                 id<MTLLibrary> existingLib = nil) {
    device = existingDevice;
    commandQueue = existingQueue;
    library = existingLib;

    MTLSamplerDescriptor *samplerDesc = [MTLSamplerDescriptor new];
    samplerDesc.minFilter = MTLSamplerMinMagFilterLinear;
    samplerDesc.magFilter = MTLSamplerMinMagFilterLinear;
    samplerDesc.sAddressMode = MTLSamplerAddressModeClampToEdge;
    samplerDesc.tAddressMode = MTLSamplerAddressModeClampToEdge;
    samplerState = [device newSamplerStateWithDescriptor:samplerDesc];
  }

  id<MTLComputePipelineState> getPipeline(const std::string &funcName) {
    auto it = pipelines.find(funcName);
    if (it != pipelines.end())
      return it->second;

    NSString *name = [NSString stringWithUTF8String:funcName.c_str()];
    if (!library) {
      library = [device newDefaultLibrary];
    }

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

  void dispatchShaderImpl(const char *funcName, int dimX, int dimY, int dimZ,
                          float *args, size_t argCount) {
    id<MTLComputePipelineState> pipeline = getPipeline(funcName);
    if (!pipeline)
      return;

    id<MTLCommandBuffer> cmdBuffer = [commandQueue commandBuffer];
    id<MTLComputeCommandEncoder> encoder = [cmdBuffer computeCommandEncoder];
    [encoder setComputePipelineState:pipeline];

    if (argCount > 0) {
      id<MTLBuffer> argsBuffer =
          [device newBufferWithBytes:args
                              length:argCount * sizeof(float)
                             options:MTLResourceStorageModeShared];
      [encoder setBuffer:argsBuffer offset:0 atIndex:0];
    } else {
      float dummy = 0;
      id<MTLBuffer> argsBuffer =
          [device newBufferWithBytes:&dummy
                              length:sizeof(float)
                             options:MTLResourceStorageModeShared];
      [encoder setBuffer:argsBuffer offset:0 atIndex:0];
    }

    for (size_t i = 0; i < resources.size(); ++i) {
      auto *res = resources[i];
      if (res->isExternal && res->externalTexture) {
        [encoder setTexture:res->externalTexture atIndex:i + 1];
        [encoder setSamplerState:samplerState atIndex:i + 1];
      }
    }

    MTLSize gridSize = MTLSizeMake(dimX, dimY, dimZ);
    NSUInteger w = pipeline.threadExecutionWidth;
    NSUInteger h = pipeline.maxTotalThreadsPerThreadgroup / w;
    MTLSize threadGroupSize = MTLSizeMake(w, h, 1);

    [encoder dispatchThreads:gridSize threadsPerThreadgroup:threadGroupSize];
    [encoder endEncoding];

    [cmdBuffer commit];
    [cmdBuffer waitUntilCompleted];
  }

  void dispatchShader(const char *funcName, int dimX, int dimY, int dimZ) {
    dispatchShaderImpl(funcName, dimX, dimY, dimZ, nullptr, 0);
  }

  void dispatchShader(const char *funcName, int dimX, int dimY, int dimZ,
                      const std::vector<float> &args) {
    dispatchShaderImpl(funcName, dimX, dimY, dimZ,
                       const_cast<float *>(args.data()), args.size());
  }

  void dispatchShader(const char *funcName, int dimX, int dimY, int dimZ,
                      std::initializer_list<float> args) {
    std::vector<float> argsVec(args);
    dispatchShaderImpl(funcName, dimX, dimY, dimZ, argsVec.data(),
                       argsVec.size());
  }
};

// Forward declarations of generated functions
void func_main(EvalContext &ctx);

static const char _blitFromRectVertexShaderCode[] = R"(#version 410 core
uniform vec2 MaxUV;

layout(location = 0) in vec4 vPosition;
layout(location = 1) in vec2 vUV;

out vec2 uv;

void main() {
  gl_Position = vPosition;
  uv = vUV;
  uv = uv * MaxUV;
}
)";

static const char _blitFromRectFragmentShaderCode[] = R"(#version 410 core
uniform sampler2DRect InputTexture;

in vec2 uv;

out vec4 fragColor;

void main() {
  fragColor = texture(InputTexture, uv);
}
)";

static const char _blitFromTex2DVertexShaderCode[] = R"(#version 410 core
uniform vec2 MaxUV;

layout(location = 0) in vec4 vPosition;
layout(location = 1) in vec2 vUV;

out vec2 uv;

void main() {
  gl_Position = vPosition;
  uv = vUV;
  uv = uv * MaxUV;
}
)";

static const char _blitFromTex2DFragmentShaderCode[] = R"(#version 410 core
uniform sampler2D InputTexture;

in vec2 uv;

out vec4 fragColor;

void main() {
  fragColor = texture(InputTexture, uv);
}
)";

inline FFGLTexCoords GetMaxGLTexCoords2D(const FFGLTextureStruct &t) {
  FFGLTexCoords texCoords;
  texCoords.s = (GLfloat)t.Width / (GLfloat)t.HardwareWidth;
  texCoords.t = (GLfloat)t.Height / (GLfloat)t.HardwareHeight;
  return texCoords;
}

inline FFGLTexCoords GetMaxGLTexCoordsRect(const FFGLTextureStruct &t) {
  FFGLTexCoords texCoords;
  texCoords.s = (GLfloat)t.Width;
  texCoords.t = (GLfloat)t.Height;
  return texCoords;
}

class NanoPlugin : public CFFGLPlugin {
public:
  void init_plugin();
  void map_params(EvalContext &ctx);
  void setup_resources(EvalContext &ctx, ResourceState *outputRes,
                       const std::vector<ResourceState *> &inputRes);

public:
  NanoPlugin() : CFFGLPlugin() {
    SetMinInputs(MIN_INPUTS);
    SetMaxInputs(MAX_INPUTS);

    init_plugin();

#ifdef INTERNAL_RESOURCE_COUNT
    _internalResources.resize(INTERNAL_RESOURCE_COUNT);
#endif

    _device = MTLCreateSystemDefaultDevice();
    _commandQueue = [_device newCommandQueue];

    NSBundle *bundle =
        [NSBundle bundleForClass:[AAPLOpenGLMetalInteropTexture class]];
    NSError *error = nil;
    _library = [_device newDefaultLibraryWithBundle:bundle error:&error];
    if (!_library) {
      NSURL *libUrl = [bundle URLForResource:@"default"
                               withExtension:@"metallib"];
      if (libUrl) {
        _library = [_device newLibraryWithURL:libUrl error:&error];
      }
    }
  }

  ~NanoPlugin() {
    _blitShader.Free();
    _blitShader2D.Free();
    _screenQuad.Free();
  }

  FFResult InitGL(const FFGLViewportStruct *vp) override {
    _currentViewport = *vp;
    bool ok1 = _blitShader.Compile(_blitFromRectVertexShaderCode,
                                   _blitFromRectFragmentShaderCode);
    bool ok2 = _blitShader2D.Compile(_blitFromTex2DVertexShaderCode,
                                     _blitFromTex2DFragmentShaderCode);
    _screenQuad.Initialise();

    return CFFGLPlugin::InitGL(vp);
  }

  FFResult DeInitGL() override {
    _blitShader.Free();
    _blitShader2D.Free();
    _screenQuad.Free();
    _inputInterops.clear();
    return FF_SUCCESS;
  }

  FFResult Resize(const FFGLViewportStruct *vp) override {
    _currentViewport = *vp;
    return CFFGLPlugin::Resize(vp);
  }

  FFResult ProcessOpenGL(ProcessOpenGLStruct *pGL) override {
    WriteLog("ProcessOpenGL called. numInputs: " +
             std::to_string(pGL->numInputTextures));
    if (pGL->numInputTextures < 1 && PLUGIN_TYPE != FF_SOURCE) {
      return FF_SUCCESS;
    }

    // Use current viewport size for internal output orchestration
    unsigned int targetWidth = _currentViewport.width;
    unsigned int targetHeight = _currentViewport.height;

    static int logCount = 0;
    if (logCount < 5) {
      char buf[256];
      snprintf(buf, sizeof(buf),
               "[Plugin] ProcessOpenGL: %dx%d, Inputs: %u, HostFBO: %u",
               targetWidth, targetHeight, pGL->numInputTextures, pGL->HostFBO);
      std::ofstream fs("/tmp/ffgl_test.txt", std::ios::app);
      if (fs.is_open())
        fs << buf << std::endl;
      // logCount incremented later below
    }
    if (!_interopTexture || _interopTexture.width != targetWidth ||
        _interopTexture.height != targetHeight) {
      _interopTexture = [[AAPLOpenGLMetalInteropTexture alloc]
          initWithMetalDevice:_device
                openGLContext:[NSOpenGLContext currentContext]
              createOpenGLFBO:YES
             metalPixelFormat:MTLPixelFormatBGRA8Unorm
                        width:targetWidth
                       height:targetHeight];
    }

    // Force HostFBO binding if provided
    glBindFramebuffer(GL_FRAMEBUFFER,
                      pGL->HostFBO); // AGGRESSIVE STATE RESET for blitting
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_CULL_FACE);
    glDisable(GL_BLEND);
    glDisable(GL_SCISSOR_TEST); // Ensure we draw to full FBO
    glDisable(GL_STENCIL_TEST);
    glDepthMask(GL_FALSE);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);

    // Log extended state for debugging
    {
      char buf[512];
      snprintf(buf, sizeof(buf),
               "[Plugin] ProcessOpenGL call %d, numInputs=%d, HostFBO=%d, "
               "viewport=%dx%d",
               logCount, pGL->numInputTextures, pGL->HostFBO, targetWidth,
               targetHeight);
      std::ofstream fs("/tmp/ffgl_test.txt", std::ios::app);
      if (fs.is_open())
        fs << buf << std::endl;
      logCount++;
    }

    // 1. Manage input interops using ACTIVE dimensions to avoid stretch
    if (_inputInterops.size() < pGL->numInputTextures) {
      _inputInterops.resize(pGL->numInputTextures, nil);
    }
    for (unsigned int i = 0; i < pGL->numInputTextures && i < MAX_INPUTS; ++i) {
      if (pGL->inputTextures[i] != nullptr) {
        const auto *pInput = pGL->inputTextures[i];

        // Use ACTIVE width/height for our internal Metal processing
        unsigned int activeW = pInput->Width;
        unsigned int activeH = pInput->Height;

        {
          char buf[256];
          snprintf(buf, sizeof(buf),
                   "  Input%d: Handle=%d, Size=%dx%d, HWSize=%dx%d", i,
                   pInput->Handle, pInput->Width, pInput->Height,
                   pInput->HardwareWidth, pInput->HardwareHeight);
          std::ofstream fs("/tmp/ffgl_test.txt", std::ios::app);
          if (fs.is_open())
            fs << buf << std::endl;
        }

        if (!_inputInterops[i] || _inputInterops[i].width != activeW ||
            _inputInterops[i].height != activeH) {
          _inputInterops[i] = [[AAPLOpenGLMetalInteropTexture alloc]
              initWithMetalDevice:_device
                    openGLContext:[NSOpenGLContext currentContext]
                  createOpenGLFBO:YES
                 metalPixelFormat:MTLPixelFormatBGRA8Unorm
                            width:activeW
                           height:activeH];
        }

        // Blit host -> interop (1:1 active area)
        {
          GLenum target = GL_TEXTURE_RECTANGLE;
          // Intelligent Target Detection:
          // If HW size != Logical Size, it implies a padded texture, commonly
          // GL_TEXTURE_2D (normalized coords) or a Rectangle texture with
          // padding (uncommon for standard NPOT support). Resolume typically
          // uses GL_TEXTURE_2D for layers. Standard FFGL convention: if
          // (HardwareWidth > Width || HardwareHeight > Height) -> Likely
          // GL_TEXTURE_2D
          if (pInput->HardwareWidth > pInput->Width ||
              pInput->HardwareHeight > pInput->Height) {
            target = GL_TEXTURE_2D;
          }

          auto &activeShader =
              (target == GL_TEXTURE_2D) ? _blitShader2D : _blitShader;

          native_gl::ScopedFBO fboBinding(_inputInterops[i].openGLFBO);
          native_gl::ScopedShader shaderBinding(activeShader.program);
          native_gl::ScopedSampler activateSampler(0);
          native_gl::ScopedTexture textureBinding(target, pInput->Handle);

          glTexParameteri(target, GL_TEXTURE_MIN_FILTER,
                          GL_LINEAR); // Use Linear for quality
          glTexParameteri(target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

          activeShader.SetInt("InputTexture", 0);

          FFGLTexCoords maxCoords;
          if (target == GL_TEXTURE_2D) {
            maxCoords = GetMaxGLTexCoords2D(*pInput);
          } else {
            maxCoords = GetMaxGLTexCoordsRect(*pInput);
          }
          activeShader.SetVec2("MaxUV", maxCoords.s, maxCoords.t);

          glDisable(GL_BLEND);
          _screenQuad.Draw();
        }
      }
    }
    glFlush();

    EvalContext ctx;
    ctx.initMetal(_device, _commandQueue, _library);
    map_params(ctx);

    ResourceState outputState;
    outputState.width = targetWidth;
    outputState.height = targetHeight;
    outputState.isExternal = true;
    outputState.externalTexture = _interopTexture.metalTexture;

    std::vector<std::unique_ptr<ResourceState>> inputStates;
    std::vector<ResourceState *> inputPtrs;
    for (unsigned int i = 0; i < pGL->numInputTextures && i < MAX_INPUTS; ++i) {
      if (_inputInterops[i] != nil) {
        auto inputState = std::make_unique<ResourceState>();
        inputState->width = _inputInterops[i].width;
        inputState->height = _inputInterops[i].height;
        inputState->isExternal = true;
        inputState->externalTexture = _inputInterops[i].metalTexture;
        inputPtrs.push_back(inputState.get());
        inputStates.push_back(std::move(inputState));
      }
    }

    setup_resources(ctx, &outputState, inputPtrs);
    func_main(ctx);

    // Final blit output -> host
    {
      native_gl::ScopedFBO fboBinding(pGL->HostFBO);
      glViewport(0, 0, targetWidth, targetHeight);

      native_gl::ScopedShader shaderBinding(_blitShader.program);
      native_gl::ScopedSampler activateSampler(0);
      native_gl::ScopedTexture textureBinding(GL_TEXTURE_RECTANGLE,
                                              _interopTexture.openGLTexture);

      glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
      glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MAG_FILTER, GL_NEAREST);

      _blitShader.SetInt("InputTexture", 0);
      FFGLTexCoords maxCoords = (FFGLTexCoords){(float)_interopTexture.width,
                                                (float)_interopTexture.height};
      _blitShader.SetVec2("MaxUV", maxCoords.s, maxCoords.t);
      _screenQuad.Draw();
    }

    return FF_SUCCESS;
  }

  FFResult SetFloatParameter(unsigned int index, float value) override {
    _params[index] = value;
    return FF_SUCCESS;
  }

  float GetFloatParameter(unsigned int index) override {
    return _params[index];
  }

  FFResult SetTextParameter(unsigned int index, const char *value) override {
    return FF_SUCCESS;
  }

  char *GetTextParameter(unsigned int index) override { return (char *)""; }

private:
  id<MTLDevice> _device;
  id<MTLCommandQueue> _commandQueue;
  id<MTLLibrary> _library;
  AAPLOpenGLMetalInteropTexture *_interopTexture;
  FFGLViewportStruct _currentViewport = {0, 0, 640, 480};

  std::map<unsigned int, float> _params;

  native_gl::GLShader _blitShader;
  native_gl::GLShader _blitShader2D;
  native_gl::GLQuad _screenQuad;
  std::vector<AAPLOpenGLMetalInteropTexture *> _inputInterops;

  std::vector<ResourceState> _internalResources;
};

// Include generated code
#define PLUGIN_CLASS NanoPlugin
#include "generated/logic.cpp"
#undef PLUGIN_CLASS

static CFFGLPluginInfo PluginInfo(PluginFactory<NanoPlugin>, PLUGIN_CODE,
                                  PLUGIN_NAME,
                                  2, // API Major
                                  1, // API Minor
                                  1, // Plugin Major
                                  0, // Plugin Minor
                                  PLUGIN_TYPE, "Nano FFGL Plugin", "Nano FFGL");
