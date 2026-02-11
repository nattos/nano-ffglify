// Metal GPU compute harness
// Compiles MSL source, dispatches compute kernel, reads back buffers, outputs
// JSON

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <fstream>
#include <iomanip>
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
      std::cerr
          << "{\"error\": \"Usage: metal-gpu-harness <metal_source> "
             "<globals_size> [-g globals_data] [buffer_id:size:data ...]\"}"
          << std::endl;
      return 1;
    }

    NSString *sourcePath = [NSString stringWithUTF8String:argv[1]];
    int globalsSize = std::atoi(argv[2]);
    std::vector<float> initialGlobals;

    // Parse buffer and texture definitions
    struct BufferDef {
      std::string id;
      int binding; // Metal buffer index
      int size;
      std::vector<float> data;
    };
    std::vector<BufferDef> bufferDefs;

    // texId:binding:width:height:filter:wrap:data
    struct TextureDef {
      std::string id;
      int binding; // Metal texture index
      int width;
      int height;
      std::string filter; // "linear" or "nearest"
      std::string wrap;   // "clamp", "repeat", or "mirror"
      std::vector<float> data;
    };
    std::vector<TextureDef> textureDefs;

    for (int i = 3; i < argc; i++) {
      std::string arg = argv[i];

      // Check for -g prefix (globals)
      if (arg == "-g" && i + 1 < argc) {
        i++;
        initialGlobals = parseFloatArray(argv[i]);
        continue;
      }

      // Check for -t prefix (texture)
      if (arg == "-t" && i + 1 < argc) {
        i++;
        std::string texArg = argv[i];

        // Parse: texId:binding:width:height:filter:wrap:data
        size_t p1 = texArg.find(':');
        size_t p2 = texArg.find(':', p1 + 1);
        size_t p3 = texArg.find(':', p2 + 1);
        size_t p4 = texArg.find(':', p3 + 1);
        size_t p5 = texArg.find(':', p4 + 1);
        size_t p6 = texArg.find(':', p5 + 1);
        if (p1 != std::string::npos && p6 != std::string::npos) {
          TextureDef def;
          def.id = texArg.substr(0, p1);
          def.binding = std::atoi(texArg.substr(p1 + 1, p2 - p1 - 1).c_str());
          def.width = std::atoi(texArg.substr(p2 + 1, p3 - p2 - 1).c_str());
          def.height = std::atoi(texArg.substr(p3 + 1, p4 - p3 - 1).c_str());
          def.filter = texArg.substr(p4 + 1, p5 - p4 - 1);
          def.wrap = texArg.substr(p5 + 1, p6 - p5 - 1);
          def.data = parseFloatArray(texArg.substr(p6 + 1));
          textureDefs.push_back(def);
        }
        continue;
      }

      // Parse buffer: bufferId:binding:size:data
      size_t p1 = arg.find(':');
      size_t p2 = arg.find(':', p1 + 1);
      size_t p3 = arg.find(':', p2 + 1);
      if (p1 != std::string::npos && p3 != std::string::npos) {
        BufferDef def;
        def.id = arg.substr(0, p1);
        def.binding = std::atoi(arg.substr(p1 + 1, p2 - p1 - 1).c_str());
        def.size = std::atoi(arg.substr(p2 + 1, p3 - p2 - 1).c_str());
        def.data = parseFloatArray(arg.substr(p3 + 1));
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
    compileOptions.fastMathEnabled =
        NO; // Ensure IEEE 754 compliance (NaN, Inf)
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
    float *gptr = (float *)[globalsBuffer contents];
    memset(gptr, 0, globalsSize);
    for (size_t j = 0;
         j < initialGlobals.size() && j < (globalsSize / sizeof(float)); j++) {
      gptr[j] = initialGlobals[j];
    }

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

    // 7b. Create textures and samplers
    std::vector<id<MTLTexture>> resourceTextures;
    std::vector<id<MTLSamplerState>> resourceSamplers;
    for (const auto &def : textureDefs) {
      // Create texture descriptor
      MTLTextureDescriptor *texDesc = [[MTLTextureDescriptor alloc] init];
      texDesc.textureType = MTLTextureType2D;
      // Auto-detect format: if data has 4 floats per pixel, use RGBA32F;
      // otherwise R32F
      size_t pixelCount = def.width * def.height;
      bool isRGBA = (def.data.size() >= pixelCount * 4);
      texDesc.pixelFormat =
          isRGBA ? MTLPixelFormatRGBA32Float : MTLPixelFormatR32Float;
      texDesc.width = def.width;
      texDesc.height = def.height;
      texDesc.usage = MTLTextureUsageShaderRead;
      texDesc.storageMode = MTLStorageModeShared;

      id<MTLTexture> texture = [device newTextureWithDescriptor:texDesc];

      // Upload texture data
      MTLRegion region = MTLRegionMake2D(0, 0, def.width, def.height);
      int bytesPerPixel = isRGBA ? (4 * sizeof(float)) : sizeof(float);
      [texture replaceRegion:region
                 mipmapLevel:0
                   withBytes:def.data.data()
                 bytesPerRow:def.width * bytesPerPixel];

      resourceTextures.push_back(texture);

      // Create sampler
      MTLSamplerDescriptor *samplerDesc = [[MTLSamplerDescriptor alloc] init];

      // Parse filter mode
      if (def.filter == "nearest") {
        samplerDesc.minFilter = MTLSamplerMinMagFilterNearest;
        samplerDesc.magFilter = MTLSamplerMinMagFilterNearest;
      } else {
        samplerDesc.minFilter = MTLSamplerMinMagFilterLinear;
        samplerDesc.magFilter = MTLSamplerMinMagFilterLinear;
      }

      // Parse wrap mode
      MTLSamplerAddressMode addressMode = MTLSamplerAddressModeClampToEdge;
      if (def.wrap == "repeat") {
        addressMode = MTLSamplerAddressModeRepeat;
      } else if (def.wrap == "mirror") {
        addressMode = MTLSamplerAddressModeMirrorRepeat;
      }
      samplerDesc.sAddressMode = addressMode;
      samplerDesc.tAddressMode = addressMode;

      id<MTLSamplerState> sampler =
          [device newSamplerStateWithDescriptor:samplerDesc];
      resourceSamplers.push_back(sampler);
    }

    // 8. Create command queue and buffer
    id<MTLCommandQueue> commandQueue = [device newCommandQueue];
    id<MTLCommandBuffer> commandBuffer = [commandQueue commandBuffer];

    // 9. Encode compute command
    id<MTLComputeCommandEncoder> encoder =
        [commandBuffer computeCommandEncoder];
    [encoder setComputePipelineState:pipeline];

    // Set buffers: binding 0 = globals, then resource buffers at their binding
    // indices
    [encoder setBuffer:globalsBuffer offset:0 atIndex:0];
    for (size_t i = 0; i < bufferDefs.size(); i++) {
      [encoder setBuffer:resourceBuffers[i]
                  offset:0
                 atIndex:bufferDefs[i].binding];
    }

    // Set textures and samplers at their binding indices
    for (size_t i = 0; i < textureDefs.size(); i++) {
      [encoder setTexture:resourceTextures[i] atIndex:textureDefs[i].binding];
      [encoder setSamplerState:resourceSamplers[i]
                       atIndex:textureDefs[i].binding];
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
    auto emitFloat = [](float val) {
      if (std::isnan(val))
        std::cout << "null";
      else if (std::isinf(val))
        std::cout << (val > 0 ? "1e999" : "-1e999");
      else
        std::cout << std::setprecision(10) << val;
    };

    std::cout << "{\"resources\": [";
    for (size_t i = 0; i < resourceBuffers.size(); i++) {
      if (i > 0)
        std::cout << ", ";
      float *ptr = (float *)[resourceBuffers[i] contents];
      std::cout << "{\"id\": \"" << bufferDefs[i].id << "\", \"data\": [";
      for (int j = 0; j < bufferDefs[i].size; j++) {
        if (j > 0)
          std::cout << ", ";
        emitFloat(ptr[j]);
      }
      std::cout << "]}";
    }
    std::cout << "]";

    // Output globals buffer data for local var readback
    if (globalsSize > 0) {
      float *gptr = (float *)[globalsBuffer contents];
      int floatCount = globalsSize / sizeof(float);
      std::cout << ", \"globals\": [";
      for (int j = 0; j < floatCount; j++) {
        if (j > 0)
          std::cout << ", ";
        emitFloat(gptr[j]);
      }
      std::cout << "]";
    }

    std::cout << "}" << std::endl;

    return 0;
  }
}
