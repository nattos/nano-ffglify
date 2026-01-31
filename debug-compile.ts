
import { WgslGenerator } from './src/webgpu/wgsl-generator';
import { IRDocument } from './src/ir/types';

const ir: IRDocument = {
  functions: [
    {
      id: 'main',
      type: 'shader',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'op_0', op: 'float2', x: 1, y: 2 },
        { id: 'comp_0_0', op: 'vec_swizzle', vec: 'op_0', channels: 'x' },
        { id: 'store_0_0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'comp_0_0' },
        { id: 'comp_0_1', op: 'vec_swizzle', vec: 'op_0', channels: 'y' },
        { id: 'store_0_1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'comp_0_1' }
      ],
      edges: [
        { from: 'store_0_0', portOut: 'exec_out', to: 'store_0_1', portIn: 'exec_in', type: 'execution' }
      ]
    }
  ],
  resources: [
    { id: 'b_result', type: 'buffer', dataType: 'float' }
  ],
  structs: []
};

const generator = new WgslGenerator();
try {
  console.log("Starting compilation...");
  const code = generator.compile(ir, 'main', {
    resourceBindings: new Map([['b_result', 0]]),
    resourceDefs: new Map([['b_result', ir.resources[0]]])
  });
  console.log("Compilation successful!");
  console.log(code);
} catch (e: any) {
  console.error("Compilation failed:", e.message);
  console.error(e.stack);
}
