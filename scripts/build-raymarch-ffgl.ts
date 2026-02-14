import { CppGenerator } from '../src/metal/cpp-generator';
import { MslGenerator } from '../src/metal/msl-generator';
import { RAYMARCH_SHADER } from '../src/domain/example-ir';
import * as fs from 'fs';
import * as path from 'path';

const generatedDir = path.join(__dirname, '../src/metal/generated');
if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir, { recursive: true });

// Generate C++ code
const cppGen = new CppGenerator();
const { code: cppCode, shaderFunctions } = cppGen.compile(RAYMARCH_SHADER, 'fn_main_cpu');
fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), cppCode);
console.log('Generated logic.cpp');
console.log('Shader functions:', shaderFunctions.map(s => s.id));

// Generate MSL code
const mslGen = new MslGenerator();
const stages = new Map<string, 'compute' | 'vertex' | 'fragment'>();
shaderFunctions.forEach(f => { if (f.stage) stages.set(f.id, f.stage); });
const { code: mslCode } = mslGen.compileLibrary(RAYMARCH_SHADER, shaderFunctions.map(s => s.id), { stages });
fs.writeFileSync(path.join(generatedDir, 'shaders.metal'), mslCode);
console.log('Generated shaders.metal');

// Print resource info
console.log('Resources:', RAYMARCH_SHADER.resources.map(r => r.id + '(' + r.type + ', output=' + r.isOutput + ')'));
console.log('Inputs:', RAYMARCH_SHADER.inputs.map(i => i.id + '(' + (i.type || 'float') + ')'));
console.log('Internal resource count:', RAYMARCH_SHADER.resources.filter(r => !r.isOutput).length);
console.log('Texture input count:', RAYMARCH_SHADER.inputs.filter(i => i.type === 'texture2d').length);
