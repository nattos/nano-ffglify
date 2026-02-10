
// FFGL SDK Imports
import ffglCpp from '../../modules/ffgl/source/lib/ffgl/FFGL.cpp?raw';
import ffglH from '../../modules/ffgl/source/lib/ffgl/FFGL.h?raw';
import ffglLibH from '../../modules/ffgl/source/lib/ffgl/FFGLLib.h?raw';
import ffglLogCpp from '../../modules/ffgl/source/lib/ffgl/FFGLLog.cpp?raw';
import ffglLogH from '../../modules/ffgl/source/lib/ffgl/FFGLLog.h?raw';
import ffglPlatformH from '../../modules/ffgl/source/lib/ffgl/FFGLPlatform.h?raw';
import ffglPluginInfoCpp from '../../modules/ffgl/source/lib/ffgl/FFGLPluginInfo.cpp?raw';
import ffglPluginInfoH from '../../modules/ffgl/source/lib/ffgl/FFGLPluginInfo.h?raw';
import ffglPluginInfoDataCpp from '../../modules/ffgl/source/lib/ffgl/FFGLPluginInfoData.cpp?raw';
import ffglPluginManagerCpp from '../../modules/ffgl/source/lib/ffgl/FFGLPluginManager.cpp?raw';
import ffglPluginManagerH from '../../modules/ffgl/source/lib/ffgl/FFGLPluginManager.h?raw';
import ffglPluginSdkCpp from '../../modules/ffgl/source/lib/ffgl/FFGLPluginSDK.cpp?raw';
import ffglPluginSdkH from '../../modules/ffgl/source/lib/ffgl/FFGLPluginSDK.h?raw';
import ffglThumbnailInfoCpp from '../../modules/ffgl/source/lib/ffgl/FFGLThumbnailInfo.cpp?raw';
import ffglThumbnailInfoH from '../../modules/ffgl/source/lib/ffgl/FFGLThumbnailInfo.h?raw';

// Project Imports
import pluginMm from './ffgl-plugin.mm?raw';
import interopM from './InteropTexture.m?raw';
import interopH from './InteropTexture.h?raw';
import intrinsicsH from './intrinsics.incl.h?raw';

export const FFGL_ASSETS: Record<string, string> = {
  // FFGL SDK
  'ffgl/FFGL.cpp': ffglCpp,
  'ffgl/FFGL.h': ffglH,
  'ffgl/FFGLLib.h': ffglLibH,
  'ffgl/FFGLLog.cpp': ffglLogCpp,
  'ffgl/FFGLLog.h': ffglLogH,
  'ffgl/FFGLPlatform.h': ffglPlatformH,
  'ffgl/FFGLPluginInfo.cpp': ffglPluginInfoCpp,
  'ffgl/FFGLPluginInfo.h': ffglPluginInfoH,
  'ffgl/FFGLPluginInfoData.cpp': ffglPluginInfoDataCpp,
  'ffgl/FFGLPluginManager.cpp': ffglPluginManagerCpp,
  'ffgl/FFGLPluginManager.h': ffglPluginManagerH,
  'ffgl/FFGLPluginSDK.cpp': ffglPluginSdkCpp,
  'ffgl/FFGLPluginSDK.h': ffglPluginSdkH,
  'ffgl/FFGLThumbnailInfo.cpp': ffglThumbnailInfoCpp,
  'ffgl/FFGLThumbnailInfo.h': ffglThumbnailInfoH,

  // Project Files
  'ffgl-plugin.mm': pluginMm,
  'InteropTexture.m': interopM,
  'InteropTexture.h': interopH,
  'intrinsics.incl.h': intrinsicsH
};
