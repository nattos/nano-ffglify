import { IVirtualFileSystem } from './virtual-fs';
import { generateMetalCompileCmds, generateFFGLPluginCmds, generateBuildScript } from './metal-compile';
import { CppGenerator } from './cpp-generator';
import { MslGenerator } from './msl-generator';
import { IRDocument } from '../domain/types';

export interface PackagingOptions {
  ir: IRDocument;
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
  const bundleName = name.replace(/\s+/g, '');
  const bundlePath = `${relBuild}/${bundleName}.bundle`;
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
