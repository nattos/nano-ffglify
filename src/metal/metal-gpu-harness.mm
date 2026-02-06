// Metal GPU compute harness
// Compiles MSL source, dispatches compute kernel, reads back buffers, outputs
// JSON

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <fstream>
#include <iostream>
#include <sstream>
#include <vector>

// Parse a JSON-like array of numbers from a string
std::vector<float> parseFloatArray(const std::string &str) {
  std::vector<float> result;
  std::stringstream ss(str);
  char c;
  float val;
  while (ss >> c) {
    if (c == '[' || c == ',' || c == ' ')
      continue;
    if (c == ']')
      break;
    ss.putback(c);
    if (ss >> val) {
      result.push_back(val);
    }
  }
  return result;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    // Usage: metal-gpu-harness <metal_source> <globals_size> <buffer_defs...>
    // buffer_def format: bufferId:size:initialData
    // Example: metal-gpu-harness source.metal 16 b_result:4:[]

    if (argc < 3) {
      std::cerr << "{\"error\": \"Usage: metal-gpu-harness <metal_source> "
                   "<globals_size> [buffer_id:size:data ...]\"}"
                << std::endl;
      return 1;
    }

    NSString *sourcePath = [NSString stringWithUTF8String:argv[1]];
    int globalsSize = std::atoi(argv[2]);

    // Parse buffer definitions
    struct BufferDef {
      std::string id;
      int size;
      std::vector<float> data;
    };
    std::vector<BufferDef> bufferDefs;

    for (int i = 3; i < argc; i++) {
      std::string arg = argv[i];
      size_t p1 = arg.find(':');
      size_t p2 = arg.find(':', p1 + 1);
      if (p1 != std::string::npos && p2 != std::string::npos) {
        BufferDef def;
        def.id = arg.substr(0, p1);
        def.size = std::atoi(arg.substr(p1 + 1, p2 - p1 - 1).c_str());
        def.data = parseFloatArray(arg.substr(p2 + 1));
        bufferDefs.push_back(def);
      }
    }

    // 1. Get Metal device
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) {
      std::cerr << "{\"error\": \"No Metal device found\"}" << std::endl;
      return 1;
    }

    // 2. Read source file
    NSError *error = nil;
    NSString *source = [NSString stringWithContentsOfFile:sourcePath
                                                 encoding:NSUTF8StringEncoding
                                                    error:&error];
    if (!source) {
      std::cerr << "{\"error\": \"Failed to read source: " <<
          [[error localizedDescription] UTF8String] << "\"}" << std::endl;
      return 1;
    }

    // 3. Compile to library
    MTLCompileOptions *compileOptions = [[MTLCompileOptions alloc] init];
    id<MTLLibrary> library = [device newLibraryWithSource:source
                                                  options:compileOptions
                                                    error:&error];
    if (!library) {
      std::cerr << "{\"error\": \"MSL compilation failed: " <<
          [[error localizedDescription] UTF8String] << "\"}" << std::endl;
      return 1;
    }

    // 4. Get kernel function
    id<MTLFunction> kernelFunc = [library newFunctionWithName:@"main_kernel"];
    if (!kernelFunc) {
      std::cerr << "{\"error\": \"Failed to find main_kernel function\"}"
                << std::endl;
      return 1;
    }

    // 5. Create compute pipeline
    id<MTLComputePipelineState> pipeline =
        [device newComputePipelineStateWithFunction:kernelFunc error:&error];
    if (!pipeline) {
      std::cerr << "{\"error\": \"Failed to create pipeline: " <<
          [[error localizedDescription] UTF8String] << "\"}" << std::endl;
      return 1;
    }

    // 6. Create globals buffer
    id<MTLBuffer> globalsBuffer =
        [device newBufferWithLength:globalsSize
                            options:MTLResourceStorageModeShared];
    memset([globalsBuffer contents], 0, globalsSize);

    // 7. Create resource buffers
    std::vector<id<MTLBuffer>> resourceBuffers;
    for (const auto &def : bufferDefs) {
      size_t byteSize = def.size * sizeof(float);
      id<MTLBuffer> buffer =
          [device newBufferWithLength:byteSize
                              options:MTLResourceStorageModeShared];
      float *ptr = (float *)[buffer contents];
      for (size_t j = 0; j < def.size; j++) {
        ptr[j] = (j < def.data.size()) ? def.data[j] : 0.0f;
      }
      resourceBuffers.push_back(buffer);
    }

    // 8. Create command queue and buffer
    id<MTLCommandQueue> commandQueue = [device newCommandQueue];
    id<MTLCommandBuffer> commandBuffer = [commandQueue commandBuffer];

    // 9. Encode compute command
    id<MTLComputeCommandEncoder> encoder =
        [commandBuffer computeCommandEncoder];
    [encoder setComputePipelineState:pipeline];

    // Set buffers: binding 0 = globals, then resource buffers in order
    [encoder setBuffer:globalsBuffer offset:0 atIndex:0];
    for (size_t i = 0; i < resourceBuffers.size(); i++) {
      [encoder setBuffer:resourceBuffers[i] offset:0 atIndex:i + 1];
    }

    // Dispatch single thread
    MTLSize gridSize = MTLSizeMake(1, 1, 1);
    MTLSize threadGroupSize = MTLSizeMake(1, 1, 1);
    [encoder dispatchThreads:gridSize threadsPerThreadgroup:threadGroupSize];
    [encoder endEncoding];

    // 10. Submit and wait
    [commandBuffer commit];
    [commandBuffer waitUntilCompleted];

    // 11. Read back results and output JSON
    std::cout << "{\"resources\": [";
    for (size_t i = 0; i < resourceBuffers.size(); i++) {
      if (i > 0)
        std::cout << ", ";
      float *ptr = (float *)[resourceBuffers[i] contents];
      std::cout << "{\"id\": \"" << bufferDefs[i].id << "\", \"data\": [";
      for (int j = 0; j < bufferDefs[i].size; j++) {
        if (j > 0)
          std::cout << ", ";
        float val = ptr[j];
        if (std::isnan(val)) {
          std::cout << "null"; // JSON-compatible for NaN
        } else if (std::isinf(val)) {
          std::cout << (val > 0 ? "1e38" : "-1e38"); // Large finite value
        } else {
          std::cout << val;
        }
      }
      std::cout << "]}";
    }
    std::cout << "]}" << std::endl;

    return 0;
  }
}
