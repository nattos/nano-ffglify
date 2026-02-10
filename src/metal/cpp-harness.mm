// Extended Metal/C++ runner for conformance tests
// Accepts generated C++ and resource definitions, executes, returns JSON

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <array>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "intrinsics.incl.h"

// Load a .metallib file
id<MTLLibrary> loadMetalLib(id<MTLDevice> device, const char *path) {
  NSError *error = nil;
  NSString *nsPath = [NSString stringWithUTF8String:path];
  NSURL *libraryURL = [NSURL fileURLWithPath:nsPath];
  id<MTLLibrary> library = [device newLibraryWithURL:libraryURL error:&error];
  if (!library) {
    std::cerr << "Failed to load metallib: "
              << (error ? [[error localizedDescription] UTF8String] : "unknown")
              << std::endl;
    return nil;
  }
  return library;
}

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
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        id<MTLCommandQueue> commandQueue = [device newCommandQueue];
        id<MTLLibrary> library = loadMetalLib(device, argv[1]);
        ctx.initMetal(device, commandQueue, library);
        argStart = 2;
      }
    }

    // Parse -i input args, -d data file, then resource specs
    std::vector<std::string> resourceArgs;
    std::string dataFilePath;
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
      } else if (arg == "-d" && i + 1 < argc) {
        dataFilePath = argv[++i];
      } else {
        resourceArgs.push_back(arg);
      }
    }

    // Parse resource specs
    for (const auto &arg : resourceArgs) {
      if (arg.size() > 2 && arg[0] == 'T' && arg[1] == ':') {
        // Texture: T:<width>:<height>[:<wrap>]
        auto firstColon = arg.find(':', 2);
        auto secondColon = arg.find(':', firstColon + 1);
        int w = std::stoi(arg.substr(2, firstColon - 2));
        std::string hStr =
            (secondColon != std::string::npos)
                ? arg.substr(firstColon + 1, secondColon - firstColon - 1)
                : arg.substr(firstColon + 1);
        int h = std::stoi(hStr);
        int wrap = 0; // 0=repeat, 1=clamp
        if (secondColon != std::string::npos) {
          wrap = std::stoi(arg.substr(secondColon + 1));
        }
        // RGBA8 texture: w*h*4 floats
        resourceStorage.push_back(ResourceState{
            std::vector<float>(w * h * 4, 0.0f), (size_t)w, (size_t)h});
        ctx.isTextureResource.push_back(true);
        ctx.texWidths.push_back(w);
        ctx.texHeights.push_back(h);
        ctx.texWrapModes.push_back(wrap);
      } else if (arg.size() > 2 && arg[0] == 'B' && arg[1] == ':') {
        // Buffer with stride: B:<size>:<stride>
        auto firstColon = arg.find(':', 2);
        size_t size = std::stoull(arg.substr(2, firstColon - 2));
        size_t stride = 1;
        if (firstColon != std::string::npos) {
          stride = std::stoull(arg.substr(firstColon + 1));
        }
        size_t totalFloats = size * stride;
        resourceStorage.push_back(
            ResourceState{std::vector<float>(totalFloats, 0.0f), size, 1});
        ctx.isTextureResource.push_back(false);
        ctx.texWidths.push_back(0);
        ctx.texHeights.push_back(0);
      } else {
        // Buffer: <size> (legacy format, stride=1)
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

    // Load pre-populated resource data from JSON file if provided
    if (!dataFilePath.empty()) {
      std::ifstream dataFile(dataFilePath);
      if (dataFile.is_open()) {
        std::string json((std::istreambuf_iterator<char>(dataFile)),
                         std::istreambuf_iterator<char>());
        // Simple JSON parser for {"idx": [float, ...], ...}
        size_t pos = 0;
        while ((pos = json.find('"', pos)) != std::string::npos) {
          pos++; // skip opening quote
          size_t endQuote = json.find('"', pos);
          if (endQuote == std::string::npos)
            break;
          int idx = std::stoi(json.substr(pos, endQuote - pos));
          pos = json.find('[', endQuote);
          if (pos == std::string::npos)
            break;
          pos++; // skip [
          std::vector<float> values;
          while (pos < json.size() && json[pos] != ']') {
            while (pos < json.size() && (json[pos] == ' ' || json[pos] == ','))
              pos++;
            if (pos < json.size() && json[pos] != ']') {
              size_t numEnd = pos;
              while (numEnd < json.size() && json[numEnd] != ',' &&
                     json[numEnd] != ']' && json[numEnd] != ' ')
                numEnd++;
              values.push_back(std::stof(json.substr(pos, numEnd - pos)));
              pos = numEnd;
            }
          }
          if (idx >= 0 && (size_t)idx < resourceStorage.size()) {
            resourceStorage[idx].data = values;
          }
          if (pos < json.size())
            pos++; // skip ]
        }
      }
    }

    // Call generated entry point
    func_main(ctx);

    // Ensure GPU work is done and results synced back
    ctx.waitForPendingCommands();

    // Helper to output JSON-safe float (NaN → null, ±Inf → ±1e999)
    auto emitFloat = [](float v) {
      if (std::isnan(v))
        std::cout << "null";
      else if (std::isinf(v))
        std::cout << (v > 0 ? "1e999" : "-1e999");
      else
        std::cout << std::setprecision(10) << v;
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
                << ",\"height\":" << res->height << ",\"data\":[";
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
        if (i > 0)
          std::cout << ",";
        emitFloat(ctx.returnValue[i]);
      }
      std::cout << "]";
    }

    // Output action log
    if (!ctx.actionLog.empty()) {
      std::cout << ",\"log\":[";
      for (size_t i = 0; i < ctx.actionLog.size(); ++i) {
        if (i > 0)
          std::cout << ",";
        auto &a = ctx.actionLog[i];
        std::cout << "{\"type\":\"" << a.type << "\"";
        if (!a.target.empty())
          std::cout << ",\"target\":\"" << a.target << "\"";
        std::cout << ",\"width\":" << a.width << ",\"height\":" << a.height;
        std::cout << "}";
      }
      std::cout << "]";
    }

    std::cout << "}" << std::endl;

    return 0;
  }
}
