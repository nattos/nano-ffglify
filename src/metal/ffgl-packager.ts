import { IVirtualFileSystem } from './virtual-fs';
import { FFGLCompileOptions, generateMetalCompileCmds, generateFFGLPluginCmds, generateBuildScript } from './metal-compile';
import { CppGenerator } from './cpp-generator';
import { MslGenerator } from './msl-generator';
import { IRGraph } from '../domain/types';

export interface PackagingOptions {
  options: FFGLCompileOptions;
  ir: IRGraph;
  assets: Record<string, string>;
}

/**
 * Packages a complete FFGL plugin build environment into a virtual filesystem.
 */
export async function packageFFGLPlugin(vfs: IVirtualFileSystem, options: PackagingOptions) {
  const { ir, assets, options: compileOptions } = options;

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

  // 2. Generate Logic and Shader Code
  const cppGen = new CppGenerator();
  const { code: cppCode, shaderFunctions } = cppGen.compile(ir, 'fn_main_cpu');
  vfs.writeFile(`${relGen}/logic.cpp`, cppCode);

  const mslGen = new MslGenerator();
  const { code: mslCode } = mslGen.compileLibrary(ir, shaderFunctions.map(s => s.id));
  vfs.writeFile(`${relGen}/shaders.metal`, mslCode);

  // 3. Generate Build Script
  const steps: string[] = [];

  // Metal Compile Steps
  const metalCmds = generateMetalCompileCmds(`${relGen}/shaders.metal`, relBuild);
  steps.push(...metalCmds);

  // FFGL Compile Steps
  const bundlePath = `${relBuild}/${(compileOptions.name || 'NanoFFGL').replace(/\s+/g, '')}.bundle`;
  const ffglCmds = generateFFGLPluginCmds({
    ...compileOptions,
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
