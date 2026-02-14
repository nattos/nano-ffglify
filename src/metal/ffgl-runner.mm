
#import "InteropTexture.h"
#import <AppKit/AppKit.h>
#import <Cocoa/Cocoa.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <dlfcn.h>
#include <ffgl/FFGL.h>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

// Define function pointers for FFGL entry points
typedef FFMixed (*FFGLPluginMainPtr)(FFUInt32, FFMixed, FFInstanceID);

// Simple Base64 Encoder
static const std::string base64_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                                        "abcdefghijklmnopqrstuvwxyz"
                                        "0123456789+/";

std::string base64_encode(unsigned char const *bytes_to_encode,
                          unsigned int in_len) {
  std::string ret;
  int i = 0;
  int j = 0;
  unsigned char char_array_3[3];
  unsigned char char_array_4[4];

  while (in_len--) {
    char_array_3[i++] = *(bytes_to_encode++);
    if (i == 3) {
      char_array_4[0] = (char_array_3[0] & 0xfc) >> 2;
      char_array_4[1] =
          ((char_array_3[0] & 0x03) << 4) + ((char_array_3[1] & 0xf0) >> 4);
      char_array_4[2] =
          ((char_array_3[1] & 0x0f) << 2) + ((char_array_3[2] & 0xc0) >> 6);
      char_array_4[3] = char_array_3[2] & 0x3f;

      for (i = 0; (i < 4); i++)
        ret += base64_chars[char_array_4[i]];
      i = 0;
    }
  }

  if (i) {
    for (j = i; j < 3; j++)
      char_array_3[j] = '\0';

    char_array_4[0] = (char_array_3[0] & 0xfc) >> 2;
    char_array_4[1] =
        ((char_array_3[0] & 0x03) << 4) + ((char_array_3[1] & 0xf0) >> 4);
    char_array_4[2] =
        ((char_array_3[1] & 0x0f) << 2) + ((char_array_3[2] & 0xc0) >> 6);
    char_array_4[3] = char_array_3[2] & 0x3f;

    for (j = 0; (j < i + 1); j++)
      ret += base64_chars[char_array_4[j]];

    while ((i++ < 3))
      ret += '=';
  }

  return ret;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      std::cerr << "{\"error\": \"Usage: ffgl-runner <path-to-bundle> [width height] [frames]\"}"
                << std::endl;
      return 1;
    }

    // 1. Setup OpenGL Context (Core Profile 3.2+)
    NSOpenGLPixelFormatAttribute attrs[] = {NSOpenGLPFAAccelerated,
                                            NSOpenGLPFAColorSize,
                                            24,
                                            NSOpenGLPFAAlphaSize,
                                            8,
                                            NSOpenGLPFADepthSize,
                                            24,
                                            NSOpenGLPFAOpenGLProfile,
                                            NSOpenGLProfileVersion3_2Core,
                                            0};
    NSOpenGLPixelFormat *pixelFormat =
        [[NSOpenGLPixelFormat alloc] initWithAttributes:attrs];
    if (!pixelFormat) {
      std::cerr << "{\"error\": \"Failed to create NSOpenGLPixelFormat\"}"
                << std::endl;
      return 1;
    }
    NSOpenGLContext *context =
        [[NSOpenGLContext alloc] initWithFormat:pixelFormat shareContext:nil];
    [context makeCurrentContext];

    // 2. Load Plugin Bundle
    NSString *bundlePath = [NSString stringWithUTF8String:argv[1]];
    NSBundle *bundle = [NSBundle bundleWithPath:bundlePath];
    if (!bundle) {
      std::cerr << "{\"error\": \"Failed to load bundle at path: " << argv[1]
                << "\"}" << std::endl;
      return 1;
    }

    // Load the bundle executable
    if (![bundle load]) {
      std::cerr << "{\"error\": \"Failed to load bundle executable\"}"
                << std::endl;
      return 1;
    }

    // Get the entry point
    void *handle =
        dlopen([[bundle executablePath] UTF8String], RTLD_LAZY | RTLD_LOCAL);
    if (!handle) {
      std::cerr << "{\"error\": \"dlopen failed on bundle executable: "
                << dlerror() << "\"}" << std::endl;
      return 1;
    }

    FFGLPluginMainPtr plugMain = (FFGLPluginMainPtr)dlsym(handle, "plugMain");
    typedef void (*RegisterTexPtr)(unsigned int, void *);
    RegisterTexPtr registerTex =
        (RegisterTexPtr)dlsym(handle, "RegisterMetalTextureForGL");

    if (!plugMain) {
      std::cerr << "{\"error\": \"Failed to find plugMain symbol\"}"
                << std::endl;
      dlclose(handle);
      return 1;
    }

    // 3. Get Plugin Info
    FFMixed infoResult = plugMain(
        FF_GET_INFO, (FFMixed){.PointerValue = nullptr}, (FFInstanceID)0);
    PluginInfoStruct *info = (PluginInfoStruct *)infoResult.PointerValue;
    std::string pluginName = "Unknown";
    std::string pluginID = "XXXX";
    if (info) {
      char nameBuf[17] = {0};
      memcpy(nameBuf, info->PluginName, 16);
      pluginName = nameBuf;

      char idBuf[5] = {0};
      memcpy(idBuf, info->PluginUniqueID, 4);
      pluginID = idBuf;
    }

    unsigned int pluginType = info ? info->PluginType : 0;

    // 4. Initialize Plugin
    // FF_INITIALISE_V2 is mandatory for FFGL 2.0+
    FFMixed result = plugMain(
        FF_INITIALISE_V2, (FFMixed){.PointerValue = nullptr}, (FFInstanceID)0);
    if (result.UIntValue == FF_FAIL) {
      // Try V1 just in case? No, we target V2.
      std::cerr << "{\"error\": \"FF_INITIALISE_V2 failed\"}" << std::endl;
      dlclose(handle);
      return 1;
    }

    // 5. Instantiate Plugin
    // Defines viewport size for the instance
    int width = 640;
    int height = 480;
    int numFrames = 1;
    if (argc >= 4) {
      width = std::stoi(argv[2]);
      height = std::stoi(argv[3]);
    }
    if (argc >= 5) {
      numFrames = std::stoi(argv[4]);
    }

    FFGLViewportStruct viewport = {0, 0, (FFUInt32)width, (FFUInt32)height};
    result = plugMain(FF_INSTANTIATE_GL, (FFMixed){.PointerValue = &viewport},
                      (FFInstanceID)0);

    if (result.UIntValue == FF_FAIL) {
      std::cerr << "{\"error\": \"FF_INSTANTIATE_GL failed\"}" << std::endl;
      plugMain(FF_DEINITIALISE, (FFMixed){.PointerValue = nullptr},
               (FFInstanceID)0);
      dlclose(handle);
      return 1;
    }
    FFInstanceID instanceID = (FFInstanceID)result.PointerValue;

    // Optional: Call Resize just to be explicit, though instantiate does it too
    plugMain(FF_RESIZE, (FFMixed){.PointerValue = &viewport}, instanceID);

    // 6. Setup OpenGL Resources (FBO & Textures)
    GLuint fbo, texColor;
    glGenFramebuffers(1, &fbo);
    glGenTextures(1, &texColor);

    // Bind texture and set parameters
    glBindTexture(GL_TEXTURE_2D, texColor);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA,
                 GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);

    // Attach texture to FBO
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                           texColor, 0);

    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
      std::cerr << "{\"error\": \"Framebuffer is not complete\"}" << std::endl;
      return 1;
    }

    // Clear to black
    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);

    // 7. Process Frame
    // FFGL 2.1 uses ProcessOpenGLStruct
    // We provide up to 2 input textures.
    const int numInputs = 2;
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();

    // Use C++ InteropTexture
    std::unique_ptr<InteropTexture> interopInputs[numInputs];
    FFGLTextureStruct inputTextureStr[numInputs];
    FFGLTextureStruct *inputTextures[numInputs];

    for (int i = 0; i < numInputs; ++i) {
      interopInputs[i] = std::make_unique<InteropTexture>(
          device, context,
          false, // createOpenGLFBO
          MTLPixelFormatBGRA8Unorm, width, height);

      glBindTexture(GL_TEXTURE_RECTANGLE, interopInputs[i]->getOpenGLTexture());
      // Fill with different colors for testing (e.g. Red for 0, Green for 1)
      std::vector<unsigned char> data(width * height * 4);
      for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
          int idx = (y * width + x) * 4;
          if (i == 0) {
            // Input 0: Horizontal Red Gradient
            data[idx + 0] = (unsigned char)((float)x / width * 255.0f);
            data[idx + 1] = 0;
            data[idx + 2] = 0;
            data[idx + 3] = 255;
          } else {
            // Input 1: Solid Green
            data[idx + 0] = 0;
            data[idx + 1] = 255;
            data[idx + 2] = 0;
            data[idx + 3] = 255;
          }
        }
      }
      glTexSubImage2D(GL_TEXTURE_RECTANGLE, 0, 0, 0, width, height, GL_RGBA,
                      GL_UNSIGNED_BYTE, data.data());

      if (registerTex) {
        registerTex(interopInputs[i]->getOpenGLTexture(),
                    (__bridge void *)interopInputs[i]->getMetalTexture());
      }

      inputTextureStr[i].Width = width;
      inputTextureStr[i].Height = height;
      inputTextureStr[i].HardwareWidth = width;
      inputTextureStr[i].HardwareHeight = height;
      inputTextureStr[i].Handle = interopInputs[i]->getOpenGLTexture();
      inputTextures[i] = &inputTextureStr[i];
    }

    ProcessOpenGLStruct processStruct;
    processStruct.numInputTextures = numInputs;
    processStruct.inputTextures = inputTextures;
    processStruct.HostFBO = fbo;

    // Activate FBO and calls ProcessOpenGL
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glViewport(0, 0, width, height);

    // Ensure GL writes are finished before Metal reads
    glFlush();

    const char *ver = (const char *)glGetString(GL_VERSION);
    if (ver)
      std::cerr << "Runner GL Version: " << ver << std::endl;
    else
      std::cerr << "Runner GL Version: NULL" << std::endl;

    // Run multiple frames with time progression (simulates Resolume)
    double dt = 1.0 / 60.0; // 60fps
    for (int frame = 0; frame < numFrames; frame++) {
      double t = frame * dt;
      plugMain(FF_SET_TIME, (FFMixed){.PointerValue = &t}, instanceID);
      plugMain(FF_PROCESS_OPENGL, (FFMixed){.PointerValue = &processStruct},
               instanceID);
      glFlush(); // Ensure each frame's GL work is flushed
    }
    std::cerr << "Processed " << numFrames << " frame(s)" << std::endl;

    // 8. Readback and Encode
    std::vector<unsigned char> pixels(width * height * 4);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());

    // Basic Base64 Encode
    std::string b64 = base64_encode(pixels.data(), pixels.size());

    // 9. Output JSON
    std::cout << "{"
              << "\"success\": true, "
              << "\"name\": \"" << pluginName << "\", "
              << "\"id\": \"" << pluginID << "\", "
              << "\"type\": " << pluginType << ", "
              << "\"width\": " << width << ", "
              << "\"height\": " << height << ", "
              << "\"image\": \"" << b64 << "\""
              << "}" << std::endl;

    // 9. Cleanup
    glDeleteTextures(1, &texColor);
    // InteropTexture destructor handles its own cleanup via unique_ptr
    glDeleteFramebuffers(1, &fbo);

    plugMain(FF_DEINSTANTIATE_GL, (FFMixed){.PointerValue = nullptr},
             instanceID);
    plugMain(FF_DEINITIALISE, (FFMixed){.PointerValue = nullptr},
             (FFInstanceID)0);

    dlclose(handle);
  }
  return 0;
}
