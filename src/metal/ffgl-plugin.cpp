
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <MetalKit/MetalKit.h>

#import "AAPLOpenGLMetalInteropTexture.h"
#include <FFGLSDK.h>

#ifndef PLUGIN_NAME
#define PLUGIN_NAME "NanoFFGL"
#endif
#ifndef PLUGIN_CODE
#define PLUGIN_CODE "NANO"
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
      }
    }

    MTLSize gridSize = MTLSizeMake(dimX, dimY, dimZ);
    NSUInteger w = pipeline.threadExecutionWidth;
    NSUInteger h = pipeline.maxTotalThreadsPerThreadgroup / w;
    MTLSize threadGroupSize = MTLSizeMake(w, h, 1);

    [encoder dispatchThreads:gridSize threadsPerThreadgroup:threadGroupSize];
    [encoder endEncoding];

    [cmdBuffer commit];
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

// Include generated code
#include "generated/logic.cpp"

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

inline FFGLTexCoords GetMaxGLTexCoordsRect(int width, int height) {
  FFGLTexCoords texCoords;
  texCoords.s = ((GLfloat)width);
  texCoords.t = ((GLfloat)height);
  return texCoords;
}

class NanoPlugin : public CFFGLPlugin {
public:
  NanoPlugin() : CFFGLPlugin() {
    SetMinInputs(1);
    SetMaxInputs(1);

    SetParamInfo(0, "Scale", FF_TYPE_STANDARD, 0.5f);
    SetParamInfo(1, "Time", FF_TYPE_STANDARD, 0.0f);

    _device = MTLCreateSystemDefaultDevice();
    _commandQueue = [_device newCommandQueue];

    NSBundle *bundle =
        [NSBundle bundleForClass:[AAPLOpenGLMetalInteropTexture class]];
    NSError *error = nil;
    _library = [_device newDefaultLibraryWithBundle:bundle error:&error];
    if (!_library) {
      NSURL *libUrl =
          [bundle URLForResource:@"default" withExtension:@"metallib"];
      if (libUrl) {
        _library = [_device newLibraryWithURL:libUrl error:&error];
      }
    }
  }

  ~NanoPlugin() {
    _blitShader.FreeGLResources();
    _screenQuad.Release();
  }

  FFResult InitGL(const FFGLViewportStruct *vp) override {
    _blitShader.Compile(_blitFromRectVertexShaderCode,
                        _blitFromRectFragmentShaderCode);
    _screenQuad.Initialise();
    return CFFGLPlugin::InitGL(vp);
  }

  FFResult DeInitGL() override {
    _blitShader.FreeGLResources();
    _screenQuad.Release();
    return FF_SUCCESS;
  }

  FFResult ProcessOpenGL(ProcessOpenGLStruct *pGL) override {
    if (pGL->numInputTextures < 1 || pGL->inputTextures[0] == NULL) {
      return FF_FAIL;
    }
    const auto *inputTexture = pGL->inputTextures[0];

    if (!_interopTexture ||
        _interopTexture.width != inputTexture->HardwareWidth ||
        _interopTexture.height != inputTexture->HardwareHeight) {
      _interopTexture = [[AAPLOpenGLMetalInteropTexture alloc]
          initWithMetalDevice:_device
                openGLContext:[NSOpenGLContext currentContext]
              createOpenGLFBO:YES
             metalPixelFormat:MTLPixelFormatBGRA8Unorm
                        width:inputTexture->HardwareWidth
                       height:inputTexture->HardwareHeight];
    }

    EvalContext ctx;
    ctx.initMetal(_device, _commandQueue, _library);

    float scale = GetFloatParameter(0) * 20.0f;
    float time = GetFloatParameter(1) * 100.0f;
    ctx.inputs["scale"] = scale;
    ctx.inputs["time"] = time;

    ResourceState outputState;
    outputState.width = _interopTexture.width;
    outputState.height = _interopTexture.height;
    outputState.isExternal = true;
    outputState.externalTexture = _interopTexture.metalTexture;

    ctx.resources.push_back(&outputState);

    func_main(ctx);

    {
      auto &shader = _blitShader;
      ffglex::ScopedShaderBinding shaderBinding(shader.GetGLID());
      ffglex::ScopedSamplerActivation activateSampler(0);
      ffglex::ScopedTextureBinding textureBinding(
          GL_TEXTURE_RECTANGLE, _interopTexture.openGLTexture);
      glSamplerParameteri(GL_TEXTURE0, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
      glSamplerParameteri(GL_TEXTURE0, GL_TEXTURE_MAG_FILTER, GL_NEAREST);

      shader.Set("InputTexture", 0);
      FFGLTexCoords maxCoords =
          GetMaxGLTexCoordsRect(_interopTexture.width, _interopTexture.height);
      shader.Set("MaxUV", maxCoords.s, maxCoords.t);
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

  std::map<unsigned int, float> _params;

  ffglex::FFGLShader _blitShader;
  ffglex::FFGLScreenQuad _screenQuad;
};

static CFFGLPluginInfo PluginInfo(PluginFactory<NanoPlugin>, PLUGIN_CODE,
                                  PLUGIN_NAME,
                                  2, // API Major
                                  1, // API Minor
                                  1, // Plugin Major
                                  0, // Plugin Minor
                                  FF_EFFECT, "Nano FFGL Plugin",
                                  "Nano FFGL by Google DeepMind");
