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
DEFINE_ELEMENTWISE_UNARY(sqrt, std::sqrt)
DEFINE_ELEMENTWISE_UNARY(exp, std::exp)
DEFINE_ELEMENTWISE_UNARY(log, std::log)
DEFINE_ELEMENTWISE_UNARY(ceil, std::ceil)
DEFINE_ELEMENTWISE_UNARY(floor, std::floor)
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
using elem::exp;
using elem::floor;
using elem::fmod;
using elem::log;
using elem::max;
using elem::min;
using elem::pow;
using elem::sin;
using elem::sqrt;
using elem::tan;
using elem::trunc;

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

  // Metal infrastructure
  id<MTLDevice> device = nil;
  id<MTLLibrary> library = nil;
  id<MTLCommandQueue> commandQueue = nil;
  std::unordered_map<std::string, id<MTLComputePipelineState>> pipelines;
  std::vector<id<MTLBuffer>> metalBuffers;

  ResourceState *getResource(size_t idx) {
    return idx < resources.size() ? resources[idx] : nullptr;
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

  // Sync CPU data to Metal buffers
  void syncToMetal() {
    metalBuffers.clear();
    for (auto *res : resources) {
      size_t byteSize = res->data.size() * sizeof(float);
      id<MTLBuffer> buffer =
          [device newBufferWithBytes:res->data.data()
                              length:byteSize
                             options:MTLResourceStorageModeShared];
      metalBuffers.push_back(buffer);
    }
  }

  // Sync Metal buffers back to CPU
  void syncFromMetal() {
    for (size_t i = 0; i < metalBuffers.size() && i < resources.size(); ++i) {
      float *ptr = (float *)[metalBuffers[i] contents];
      size_t count = resources[i]->data.size();
      for (size_t j = 0; j < count; ++j) {
        resources[i]->data[j] = ptr[j];
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

    // Bind resource buffers (starting at binding 1)
    for (size_t i = 0; i < metalBuffers.size(); ++i) {
      [encoder setBuffer:metalBuffers[i] offset:0 atIndex:i + 1];
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
    // Parse arguments: [metallib_path] <buffer_sizes...>
    // If first arg ends with .metallib, it's the shader library path
    // Each other argument is a buffer size (for buffers) or "0" (placeholder)

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

    // Parse resource sizes from remaining command line args
    for (int i = argStart; i < argc; ++i) {
      size_t size = std::stoull(argv[i]);
      resourceStorage.push_back(
          ResourceState{std::vector<float>(size, 0.0f), size, 1});
    }

    // Set up context pointers
    for (auto &res : resourceStorage) {
      ctx.resources.push_back(&res);
    }

    // Call generated entry point
    func_main(ctx);

    // Output resources as JSON
    std::cout << "{\"resources\":[";
    for (size_t r = 0; r < ctx.resources.size(); ++r) {
      if (r > 0)
        std::cout << ",";
      auto *res = ctx.resources[r];
      std::cout << "{\"data\":[";
      for (size_t i = 0; i < res->data.size(); ++i) {
        if (i > 0)
          std::cout << ",";
        std::cout << std::setprecision(10) << res->data[i];
      }
      std::cout << "]}";
    }
    std::cout << "]}" << std::endl;

    return 0;
  }
}
