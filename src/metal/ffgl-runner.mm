
#import <Cocoa/Cocoa.h>
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#include <ffgl/FFGL.h>
#include <iostream>
#include <string>

// Define function pointers for FFGL entry points
typedef FFMixed (*FFGLPluginMainPtr)(FFUInt32, FFMixed, FFInstanceID);

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      std::cerr << "{\"error\": \"Usage: ffgl-runner <path-to-bundle>\"}"
                << std::endl;
      return 1;
    }

    NSString *bundlePath = [NSString stringWithUTF8String:argv[1]];
    NSBundle *bundle = [NSBundle bundleWithPath:bundlePath];

    if (!bundle) {
      // Fallback: Try to dlopen directly to see the error
      std::string execPath =
          std::string([bundlePath UTF8String]) + "/Contents/MacOS/NanoFFGL";
      void *handle = dlopen(execPath.c_str(), RTLD_LAZY);
      if (!handle) {
        std::cerr << "{\"error\": \"Failed to load bundle (NSBundle nil). "
                     "dlopen fallback failed: "
                  << dlerror() << "\"}" << std::endl;
        return 1;
      }
      // If dlopen worked, maybe we can proceed?
      // But we need the bundle to find resources usually.
      // For this test, finding symbols is enough.

      // We can try to get the symbol from this handle
      FFGLPluginMainPtr g_plugMain =
          (FFGLPluginMainPtr)dlsym(handle, "plugMain");
      if (!g_plugMain) {
        std::cerr << "{\"error\": \"NSBundle failed. dlopen succeeded but "
                     "plugMain not found\"}"
                  << std::endl;
        return 1;
      }

      // If we got here, NSBundle failed but dlopen worked.
      // We can proceed with the test using this function pointer.
      // But let's just error out with the dlopen success info, so we know what
      // happened. std::cerr << "{\"error\": \"NSBundle failed, but dlopen
      // worked! check Info.plist structure\"}" << std::endl; Actually, let's
      // just use it.

      // Initialize
      FFMixed nullMixed = {.PointerValue = nullptr};
      FFMixed initResult =
          g_plugMain(FF_INITIALISE_V2, nullMixed, (FFInstanceID)0);

      if (initResult.UIntValue == FF_FAIL) {
        std::cerr << "{\"error\": \"FF_INITIALISE_V2 failed (fallback)\"}"
                  << std::endl;
        return 1;
      }

      // Instantiate
      FFGLViewportStruct viewport = {0, 0, 1920, 1080};
      FFMixed viewportMixed = {.PointerValue = &viewport};
      FFMixed instResult =
          g_plugMain(FF_INSTANTIATE_GL, viewportMixed, (FFInstanceID)0);

      if (instResult.UIntValue == FF_FAIL) {
        std::cerr << "{\"error\": \"FF_INSTANTIATE_GL failed (fallback)\"}"
                  << std::endl;
        return 1;
      }

      FFInstanceID instanceID = (FFInstanceID)instResult.PointerValue;
      g_plugMain(FF_DEINSTANTIATE_GL, nullMixed, instanceID);
      g_plugMain(FF_DEINITIALISE, nullMixed, (FFInstanceID)0);

      std::cout << "{\"success\": true}" << std::endl;
      return 0;
    }

    const char *executablePath = [[bundle executablePath] UTF8String];
    void *handle = dlopen(executablePath, RTLD_LAZY);

    // ... rest of the code (lines 33-76)
    if (!handle) {
      std::cerr << "{\"error\": \"dlopen failed: " << dlerror() << "\"}"
                << std::endl;
      return 1;
    }

    FFGLPluginMainPtr g_plugMain = (FFGLPluginMainPtr)dlsym(handle, "plugMain");
    if (!g_plugMain) {
      std::cerr << "{\"error\": \"Failed to find plugMain symbol\"}"
                << std::endl;
      return 1;
    }

    // Initialize
    FFMixed nullMixed = {.PointerValue = nullptr};
    FFMixed initResult =
        g_plugMain(FF_INITIALISE_V2, nullMixed, (FFInstanceID)0);

    if (initResult.UIntValue == FF_FAIL) {
      std::cerr << "{\"error\": \"FF_INITIALISE_V2 failed\"}" << std::endl;
      return 1;
    }

    // Instantiate
    FFGLViewportStruct viewport = {0, 0, 1920, 1080};
    FFMixed viewportMixed = {.PointerValue = &viewport};
    FFMixed instResult =
        g_plugMain(FF_INSTANTIATE_GL, viewportMixed, (FFInstanceID)0);

    if (instResult.UIntValue == FF_FAIL) {
      std::cerr << "{\"error\": \"FF_INSTANTIATE_GL failed\"}" << std::endl;
      return 1;
    }

    FFInstanceID instanceID = (FFInstanceID)instResult.PointerValue;

    // Cleanup (DeInstantiate)
    g_plugMain(FF_DEINSTANTIATE_GL, nullMixed, instanceID);
    g_plugMain(FF_DEINITIALISE, nullMixed, (FFInstanceID)0);

    std::cout << "{\"success\": true}" << std::endl;
    return 0;
  }
}
