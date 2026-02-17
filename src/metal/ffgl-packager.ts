import { IVirtualFileSystem } from './virtual-fs';
import { CppGenerator } from './cpp-generator';
import { MslGenerator } from './msl-generator';
import { IRDocument } from '../domain/types';

// Browser-safe path helpers (POSIX style for bash scripts)
const path = {
  join: (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
  basename: (p: string, ext?: string) => {
    const b = p.split('/').pop() || '';
    if (ext && b.endsWith(ext)) return b.slice(0, -ext.length);
    return b;
  },
  dirname: (p: string) => p.split('/').slice(0, -1).join('/') || '.'
};

export interface MetalCompileResult {
  metallibPath: string;
  airPath: string;
}

export interface MetalRunResult {
  result: number;
}

export interface CppCompileOptions {
  sourcePaths: string[];
  outputPath: string;
  frameworks?: string[];
  extraFlags?: string[];
}

export interface FFGLCompilePaths {
  ffglSdkDir: string;
  pluginSource: string;
  interopSource: string;
  additionalIncludes?: string[];
}

export interface FFGLCompileOptions {
  outputPath: string; // .../NanoFFGL.bundle
  name?: string;
  pluginId?: string;
  textureInputCount?: number;
  internalResourceCount?: number;
  paths?: FFGLCompilePaths;
}

/**
 * Generate bash commands to compile a Metal shader file to a metallib
 */
export function generateMetalCompileCmds(shaderPath: string, outputDir: string): string[] {
  const shaderName = path.basename(shaderPath, '.metal');
  const airPath = path.join(outputDir, `${shaderName}.air`);
  const metallibPath = path.join(outputDir, `${shaderName}.metallib`);

  return [
    `# Compile Metal Shader: ${shaderName}`,
    `mkdir -p "${outputDir}"`,
    `xcrun -sdk macosx metal -fno-fast-math -c "${shaderPath}" -o "${airPath}"`,
    `xcrun -sdk macosx metallib "${airPath}" -o "${metallibPath}"`
  ];
}

/**
 * Generate bash command to compile an Objective-C++ source file
 */
export function generateCppCompileCmd(options: CppCompileOptions): string {
  const { sourcePaths, outputPath, frameworks = ['Metal', 'Foundation'], extraFlags = [] } = options;
  const outputDir = path.dirname(outputPath);

  const frameworkFlags = frameworks.map(f => `-framework ${f}`).join(' ');
  const cmd = `clang++ -std=c++17 -O2 -D GL_SILENCE_DEPRECATION -D TARGET_MACOS=1 -x objective-c++ ${frameworkFlags} ${extraFlags.join(' ')} "${sourcePaths.join('" "')}" -o "${outputPath}"`;

  return [
    `# Compile C++ Host: ${path.basename(outputPath)}`,
    `mkdir -p "${outputDir}"`,
    cmd
  ].join('\n');
}

/**
 * Generate bash commands to compile the FFGL plugin bundle
 */
export function generateFFGLPluginCmds(options: FFGLCompileOptions): string[] {
  const { outputPath, paths } = options;

  if (!paths) {
    throw new Error('FFGLCompileOptions.paths must be provided');
  }

  const { ffglSdkDir, pluginSource, interopSource, additionalIncludes = [] } = paths;

  const bundleName = options.name ? options.name.replace(/\s+/g, '') : path.basename(outputPath, '.bundle');
  const parentDir = path.dirname(outputPath);

  const actualBundlePath = path.join(parentDir, `${bundleName}.bundle`);
  const contentsDir = path.join(actualBundlePath, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const binaryPath = path.join(macOsDir, bundleName);
  const infoPlistPath = path.join(contentsDir, 'Info.plist');

  const cmds: string[] = [];

  cmds.push(`# Build FFGL Plugin: ${bundleName}`);
  cmds.push(`rm -rf "${actualBundlePath}"`);
  cmds.push(`mkdir -p "${macOsDir}"`);
  cmds.push(`mkdir -p "${resourcesDir}"`);

  // Source files
  const sources = [
    `"${pluginSource}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGL.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLLog.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLThumbnailInfo.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLPluginInfo.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLPluginInfoData.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLPluginManager.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLPluginSDK.cpp')}"`,
    `"${interopSource}"`,
  ];

  // Includes
  const includeFlags = [
    `-I"${ffglSdkDir}"`,
    `-I"${path.join(ffglSdkDir, 'ffgl')}"`,
    `-I"${path.join(ffglSdkDir, 'ffglex')}"`,
    `-I"${path.dirname(interopSource)}"`,
    ...additionalIncludes.map(p => `-I"${p}"`)
  ].join(' ');

  // Frameworks
  const frameworks = [
    'Cocoa', 'OpenGL', 'Metal', 'MetalKit', 'IOSurface', 'CoreVideo',
  ];
  const frameworkFlags = frameworks.map(f => `-framework ${f}`).join(' ');

  // Plugin properties
  const inputCount = options.textureInputCount ?? 0;
  let pluginType = 0; // Effect
  if (inputCount === 0) pluginType = 1; // Source
  if (inputCount === 1) pluginType = 0; // Effect
  if (inputCount >= 2) pluginType = 2; // Mixer

  const flags = [
    '-std=c++17',
    '-x objective-c++',
    '-bundle',
    '-fobjc-arc',
    '-D TARGET_MACOS=1',
    '-D GL_SILENCE_DEPRECATION',
    '-Wl,-exported_symbol,_plugMain',
    '-g',
    options.name ? `-DPLUGIN_NAME='"${options.name}"'` : '',
    options.pluginId ? `-DPLUGIN_CODE='"${options.pluginId}"'` : '',
    `-DPLUGIN_TYPE=${pluginType}`,
    `-DMIN_INPUTS=${inputCount}`,
    `-DMAX_INPUTS=${inputCount}`,
    `-DINTERNAL_RESOURCE_COUNT=${options.internalResourceCount ?? 0}`,
  ].filter(f => f !== '').join(' ');

  // Compile
  cmds.push(`clang++ ${flags} ${includeFlags} ${frameworkFlags} ${sources.join(' ')} -o "${binaryPath}"`);

  // Codesign
  cmds.push(`codesign -s - "${binaryPath}"`);

  // Info.plist
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleExecutable</key>
\t<string>${bundleName}</string>
\t<key>CFBundleIdentifier</key>
\t<string>com.nano.${bundleName}</string>
\t<key>CFBundleName</key>
\t<string>${bundleName}</string>
\t<key>CFBundlePackageType</key>
\t<string>BNDL</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.0</string>
\t<key>CFBundleVersion</key>
\t<string>1</string>
</dict>
</plist>`;

  cmds.push(`cat <<EOF > "${infoPlistPath}"
${plistContent}
EOF`);

  return cmds;
}

/**
 * Generate a complete build script from a list of steps
 */
export function generateBuildScript(steps: string[]): string {
  return [
    '#!/bin/bash',
    'set -e',
    '',
    '# Change to the directory where the script is located',
    'cd "$(dirname "$0")"',
    '',
    '# Check for Xcode command line tools',
    'if ! xcode-select -p &>/dev/null; then',
    '  echo "Error: Xcode Command Line Tools not found. Please install them with \'xcode-select --install\'."',
    '  exit 1',
    'fi',
    '',
    '# Check for metal compiler',
    'if ! xcrun -sdk macosx -find metal &>/dev/null; then',
    '  echo "Error: Metal compiler not found. Please ensure Xcode is installed and configured correctly."',
    '  exit 1',
    'fi',
    '',
    ...steps
  ].join('\n');
}

export interface PackagingOptions {
  ir: IRDocument;
}

// GitHub raw URLs for downloadable files
const GITHUB_FFGL = 'https://raw.githubusercontent.com/resolume/ffgl/master/source/lib/ffgl';
const GITHUB_NANO = 'https://raw.githubusercontent.com/nattos/nano-ffglify/main/src/metal';
const LOCAL_FFGL = 'modules/ffgl/source/lib/ffgl';
const LOCAL_NANO = 'src/metal';

const FFGL_SDK_FILES = [
  'FFGL.cpp', 'FFGL.h', 'FFGLLib.h', 'FFGLLog.cpp', 'FFGLLog.h',
  'FFGLPlatform.h', 'FFGLPluginInfo.cpp', 'FFGLPluginInfo.h',
  'FFGLPluginInfoData.cpp', 'FFGLPluginManager.cpp', 'FFGLPluginManager.h',
  'FFGLPluginSDK.cpp', 'FFGLPluginSDK.h', 'FFGLThumbnailInfo.cpp', 'FFGLThumbnailInfo.h'
];

const NANO_PROJECT_FILES: Array<{ file: string; vfsDir: string }> = [
  { file: 'ffgl-plugin.mm', vfsDir: 'src' },
  { file: 'InteropTexture.m', vfsDir: 'src' },
  { file: 'InteropTexture.h', vfsDir: 'src' },
  { file: 'intrinsics.incl.h', vfsDir: 'src' },
  { file: 'msl-intrinsics.incl.h', vfsDir: 'generated' },
];

/**
 * Register all downloadable files as remote on a shell script VFS.
 * For ZipFileSystem this is a harmless no-op per file (registerRemote is no-op).
 */
export function registerFFGLRemotes(vfs: IVirtualFileSystem): void {
  if (!vfs.registerRemote) return;

  for (const file of FFGL_SDK_FILES) {
    vfs.registerRemote(
      `ffgl-sdk/ffgl/${file}`,
      `${GITHUB_FFGL}/${file}`,
      `${LOCAL_FFGL}/${file}`
    );
  }

  for (const { file, vfsDir } of NANO_PROJECT_FILES) {
    vfs.registerRemote(
      `${vfsDir}/${file}`,
      `${GITHUB_NANO}/${file}`,
      `${LOCAL_NANO}/${file}`
    );
  }
}

/**
 * Packages a complete FFGL plugin build environment into a virtual filesystem.
 */
export async function packageFFGLPlugin(vfs: IVirtualFileSystem, options: PackagingOptions) {
  const { ir } = options;
  const { FFGL_ASSETS } = await import('./ffgl-assets');
  const assets = FFGL_ASSETS;

  const name = ir.meta.name || 'NanoFFGL';
  const hash = (Array.from(name) as string[]).reduce((h: number, c: string) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0);
  const pluginId = Math.abs(hash).toString(16).slice(-4).toUpperCase().padStart(4, '0');

  const textureInputCount = (ir.inputs || []).filter((i: any) => i.type === 'texture2d').length;
  const internalResourceCount = (ir.resources || []).filter((r: any) => !r.isOutput).length;

  // 1. Write Assets (SDK + Project Files)
  // We mirror the structure expected by the build scripts
  const relSdk = 'ffgl-sdk';
  const relSrc = 'src';
  const relGen = 'generated';
  const relBuild = 'build';

  for (const [name, content] of Object.entries(assets)) {
    if (name.startsWith('ffgl/')) {
      vfs.writeFile(`${relSdk}/${name}`, content);
    } else {
      vfs.writeFile(`${relSrc}/${name}`, content);
    }
  }

  // 1b. Write MSL intrinsics header to generated/ (same dir as shaders.metal)
  if (assets['msl-intrinsics.incl.h']) {
    vfs.writeFile(`${relGen}/msl-intrinsics.incl.h`, assets['msl-intrinsics.incl.h']);
  }

  // 2. Generate Logic and Shader Code
  const cppGen = new CppGenerator();
  const { code: cppCode, shaderFunctions } = cppGen.compile(ir, ir.entryPoint);
  vfs.writeFile(`${relGen}/logic.cpp`, cppCode);

  const mslGen = new MslGenerator();
  const stages = new Map<string, 'compute' | 'vertex' | 'fragment'>();
  shaderFunctions.forEach((f: any) => { if (f.stage) stages.set(f.id, f.stage); });
  const { code: mslCode } = mslGen.compileLibrary(ir, shaderFunctions.map((s: any) => s.id), { stages });
  vfs.writeFile(`${relGen}/shaders.metal`, mslCode);

  // 3. Generate Build Script
  const steps: string[] = [];

  // Metal Compile Steps
  const metalCmds = generateMetalCompileCmds(`${relGen}/shaders.metal`, relBuild);
  steps.push(...metalCmds);

  // FFGL Compile Steps
  const bundleName = name.replace(/\s+/g, '');
  const bundlePath = `../${bundleName}.bundle`;
  const ffglCmds = generateFFGLPluginCmds({
    name,
    pluginId,
    textureInputCount,
    internalResourceCount,
    outputPath: bundlePath,
    paths: {
      ffglSdkDir: relSdk,
      pluginSource: `${relSrc}/ffgl-plugin.mm`,
      interopSource: `${relSrc}/InteropTexture.m`,
      additionalIncludes: [relSrc, relGen, '.']
    }
  });
  steps.push(...ffglCmds);

  // Resource Copy Step (Metallib)
  steps.push(`mkdir -p "${bundlePath}/Contents/Resources"`);
  steps.push(`cp "${relBuild}/shaders.metallib" "${bundlePath}/Contents/Resources/default.metallib"`);

  // Final Script
  const scriptContent = generateBuildScript(steps);
  vfs.writeFile('build.sh', scriptContent);
  vfs.chmod('build.sh', '755');
}
