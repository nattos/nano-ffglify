/*
See LICENSE folder for this sample’s licensing information.

Abstract:
Implemenation of class representing a texture shared between OpenGL and Metal
*/

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import "AAPLGLHeaders.h"

#ifdef TARGET_MACOS
#import <AppKit/AppKit.h>
#define PlatformGLContext NSOpenGLContext
#else // if!(TARGET_IOS || TARGET_TVOS)
#import <UIKit/UIKit.h>
#define PlatformGLContext EAGLContext
#endif // !(TARGET_IOS || TARGET_TVOS)

@interface AAPLOpenGLMetalInteropTexture : NSObject

- (nonnull instancetype)initWithMetalDevice:(nonnull id <MTLDevice>) mtlDevice
                              openGLContext:(nonnull PlatformGLContext*) glContext
                            createOpenGLFBO:(BOOL)createOpenGLFBO
                           metalPixelFormat:(MTLPixelFormat)mtlPixelFormat
                                      width:(int)width
                                     height:(int)height;

@property (readonly, nonnull, nonatomic) id<MTLDevice> metalDevice;
@property (readonly, nonnull, nonatomic) id<MTLTexture> metalTexture;

@property (readonly, nonnull, nonatomic) PlatformGLContext *openGLContext;
@property (readonly, nonatomic) GLuint openGLTexture;
@property (readonly, nonatomic) GLuint openGLFBO;

@property (readonly, nonatomic) CGSize size;
@property (readonly, nonatomic) int width;
@property (readonly, nonatomic) int height;

@end
