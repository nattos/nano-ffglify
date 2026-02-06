// Metal compute shader runner
// Loads a metallib, dispatches a compute kernel, reads back buffer, prints JSON result

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <iostream>

int main(int argc, const char* argv[]) {
    @autoreleasepool {
        // Get metallib path from command line argument
        if (argc < 2) {
            std::cerr << "{\"error\": \"Usage: metal-runner <path-to-metallib>\"}" << std::endl;
            return 1;
        }

        NSString* metallibPath = [NSString stringWithUTF8String:argv[1]];

        // 1. Get Metal device
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) {
            std::cerr << "{\"error\": \"No Metal device found\"}" << std::endl;
            return 1;
        }

        // 2. Load the metallib
        NSError* error = nil;
        NSURL* libraryURL = [NSURL fileURLWithPath:metallibPath];
        id<MTLLibrary> library = [device newLibraryWithURL:libraryURL error:&error];
        if (!library) {
            std::cerr << "{\"error\": \"Failed to load metallib: "
                      << [[error localizedDescription] UTF8String] << "\"}" << std::endl;
            return 1;
        }

        // 3. Get the kernel function
        id<MTLFunction> kernelFunc = [library newFunctionWithName:@"main_kernel"];
        if (!kernelFunc) {
            std::cerr << "{\"error\": \"Failed to find main_kernel function\"}" << std::endl;
            return 1;
        }

        // 4. Create compute pipeline
        id<MTLComputePipelineState> pipeline = [device newComputePipelineStateWithFunction:kernelFunc
                                                                                     error:&error];
        if (!pipeline) {
            std::cerr << "{\"error\": \"Failed to create pipeline: "
                      << [[error localizedDescription] UTF8String] << "\"}" << std::endl;
            return 1;
        }

        // 5. Create output buffer (1 float = 4 bytes)
        const NSUInteger bufferSize = sizeof(float);
        id<MTLBuffer> outputBuffer = [device newBufferWithLength:bufferSize
                                                         options:MTLResourceStorageModeShared];
        if (!outputBuffer) {
            std::cerr << "{\"error\": \"Failed to create buffer\"}" << std::endl;
            return 1;
        }

        // Initialize buffer to 0
        float* bufferPtr = (float*)[outputBuffer contents];
        *bufferPtr = 0.0f;

        // 6. Create command queue and command buffer
        id<MTLCommandQueue> commandQueue = [device newCommandQueue];
        id<MTLCommandBuffer> commandBuffer = [commandQueue commandBuffer];

        // 7. Create compute encoder and dispatch
        id<MTLComputeCommandEncoder> encoder = [commandBuffer computeCommandEncoder];
        [encoder setComputePipelineState:pipeline];
        [encoder setBuffer:outputBuffer offset:0 atIndex:0];

        // Dispatch 1 thread
        MTLSize gridSize = MTLSizeMake(1, 1, 1);
        MTLSize threadGroupSize = MTLSizeMake(1, 1, 1);
        [encoder dispatchThreads:gridSize threadsPerThreadgroup:threadGroupSize];
        [encoder endEncoding];

        // 8. Submit and wait
        [commandBuffer commit];
        [commandBuffer waitUntilCompleted];

        // 9. Read back result
        float result = *((float*)[outputBuffer contents]);

        // 10. Print as JSON
        std::cout << "{\"result\": " << result << "}" << std::endl;

        return 0;
    }
}
