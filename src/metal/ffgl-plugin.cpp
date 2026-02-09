#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <MetalKit/MetalKit.h>

#import "AAPLOpenGLMetalInteropTexture.h"
#include <FFGLSDK.h>
#include <memory>
#include <string>

using namespace ffglex;

#define PLUGIN_NAME "NanoFFGL"
#define PLUGIN_CODE "NANO"

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

    SetParamInfo(0, "Brightness", FF_TYPE_STANDARD, 1.0f);
    _device = MTLCreateSystemDefaultDevice();
    _commandQueue = [_device newCommandQueue];
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

    // Ensure interop textures are ready (resizing if needed)
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

    if (!_pipelineState) {
      NSBundle *bundle =
          [NSBundle bundleForClass:[AAPLOpenGLMetalInteropTexture class]];
      NSError *error = nil;
      // Try to load default library from bundle
      id<MTLLibrary> library =
          [_device newDefaultLibraryWithBundle:bundle error:&error];
      if (!library) {
        // Fallback: try explicit path in Resources
        NSURL *libUrl =
            [bundle URLForResource:@"default" withExtension:@"metallib"];
        if (libUrl) {
          library = [_device newLibraryWithURL:libUrl error:&error];
        }
      }

      if (library) {
        id<MTLFunction> kernel = [library newFunctionWithName:@"solid_color"];
        if (kernel) {
          _pipelineState =
              [_device newComputePipelineStateWithFunction:kernel error:&error];
        }
      }

      if (!_pipelineState) {
        // If we still fail, we can't do much.
        // In a real app we might log this.
        return FF_SUCCESS;
      }
    }

    id<MTLCommandBuffer> commandBuffer = [_commandQueue commandBuffer];
    id<MTLComputeCommandEncoder> encoder =
        [commandBuffer computeCommandEncoder];
    [encoder setComputePipelineState:_pipelineState];
    [encoder setTexture:_interopTexture.metalTexture atIndex:0];

    NSUInteger w = _pipelineState.threadExecutionWidth;
    NSUInteger h = _pipelineState.maxTotalThreadsPerThreadgroup / w;
    MTLSize threadsPerThreadgroup = MTLSizeMake(w, h, 1);
    MTLSize threadgroupsPerGrid =
        MTLSizeMake((_interopTexture.width + w - 1) / w,
                    (_interopTexture.height + h - 1) / h, 1);

    [encoder dispatchThreadgroups:threadgroupsPerGrid
            threadsPerThreadgroup:threadsPerThreadgroup];
    [encoder endEncoding];

    // Commit, but no need to wait. Metal orders buffer read-write dependencies.
    [commandBuffer commit];

    // Blit result back to OpenGL output texture.
    {
      auto &shader = _blitShader;
      ScopedShaderBinding shaderBinding(shader.GetGLID());
      ScopedSamplerActivation activateSampler(0);
      ScopedTextureBinding textureBinding(GL_TEXTURE_RECTANGLE,
                                          _interopTexture.openGLTexture);
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

  // Parameters
  FFResult SetFloatParameter(unsigned int index, float value) override {
    return FF_SUCCESS;
  }

  float GetFloatParameter(unsigned int index) override { return 0.0f; }

  FFResult SetTextParameter(unsigned int index, const char *value) override {
    return FF_SUCCESS;
  }

  char *GetTextParameter(unsigned int index) override { return (char *)""; }

private:
  id<MTLDevice> _device;
  id<MTLCommandQueue> _commandQueue;
  id<MTLComputePipelineState> _pipelineState;
  AAPLOpenGLMetalInteropTexture *_interopTexture;

  FFGLShader _blitShader;
  FFGLScreenQuad _screenQuad;
};

static CFFGLPluginInfo PluginInfo(PluginFactory<NanoPlugin>, PLUGIN_CODE,
                                  PLUGIN_NAME,
                                  2, // API Major
                                  1, // API Minor
                                  1, // Plugin Major
                                  0, // Plugin Minor
                                  FF_EFFECT, "Nano FFGL Plugin",
                                  "Nano FFGL by Google DeepMind");
