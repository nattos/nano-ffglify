// Extended Metal/C++ runner for conformance tests
// Accepts generated C++ and resource definitions, executes, returns JSON

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <sstream>
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

// Resource state structure
struct ResourceState {
  std::vector<float> data;
  size_t width = 0;
  size_t height = 0;
};

// Context passed to generated code
struct EvalContext {
  std::vector<ResourceState *> resources;
  ResourceState *getResource(size_t idx) {
    return idx < resources.size() ? resources[idx] : nullptr;
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
    // Parse arguments: <buffer_sizes...>
    // Each argument is either a size (for buffers) or "0" (placeholder)

    EvalContext ctx;
    std::vector<ResourceState> resourceStorage;

    // Parse resource sizes from command line
    for (int i = 1; i < argc; ++i) {
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
