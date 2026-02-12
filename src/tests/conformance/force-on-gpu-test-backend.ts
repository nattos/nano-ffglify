/// <reference types="@webgpu/types" />
import { IRDocument, DataType, ResourceDef, FunctionDef, Node as IRNode } from '../../ir/types';
import { inferFunctionTypes, validateIR } from '../../ir/validator';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { TestBackend } from './types';
import { WebGpuBackend } from './webgpu-backend';

/**
 * ForceOntoGPUTestBackend
 *
 * A specialized backend that forces the Execution Graph (which is usually CPU logic in conformance tests)
 * to run as a Compute Shader on the GPU.
 */
const getComponentCount = (type: string): number => {
  if (type === 'float2' || type === 'vec2<float>') return 2;
  if (type === 'float3' || type === 'vec3<float>') return 3;
  if (type === 'float4' || type === 'vec4<float>') return 4;
  if (type === 'float3x3' || type === 'mat3x3<float>') return 9;
  if (type === 'float4x4' || type === 'mat4x4<float>') return 16;
  if (type.startsWith('array<')) {
    const match = type.match(/,\s*(\d+)>/);
    if (match) return parseInt(match[1]);
  }
  return 1;
};

export const ForceOntoGPUTestBackend: TestBackend = {
  name: 'ForceOntoGPU',

  createContext: async (ir: IRDocument, inputs?: Map<string, RuntimeValue>) => {
    // Validate IR
    const errors = validateIR(ir);
    const criticalErrors = errors.filter(e => e.severity === 'error');
    if (criticalErrors.length > 0) {
      console.error('[ForceOntoGPUTestBackend] IR Validation Failed:', criticalErrors);
      throw new Error(`IR Validation Failed:\n${criticalErrors.map(e => e.message).join('\n')}`);
    }

    // Reuse WebGpuBackend's context creation (device init, resource alloc)
    const ctx = await WebGpuBackend.createContext(ir, inputs);
    (ctx as any)._ir = ir;
    return ctx;
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    const originalIr = (ctx as any)._ir as IRDocument || ctx.ir;
    if (!originalIr) throw new Error('[ForceOntoGPUTestBackend] IR not found');

    const ir: IRDocument = JSON.parse(JSON.stringify(originalIr));
    const originalEntryPointId = entryPoint;
    const originalFunc = ir.functions.find(f => f.id === originalEntryPointId);
    if (!originalFunc) throw new Error(`Entry point '${originalEntryPointId}' not found`);

    const gpuKernelId = `_gpu_kernel_${originalEntryPointId}`;
    const captureBufferId = 'b_force_gpu_capture';

    // 1. Analyze for Variable Capture
    const nodeTypes = inferFunctionTypes(originalFunc, ir);
    const varCaptures = new Map<string, { offset: number, type: DataType }>();
    let currentOffset = 0;

    originalFunc.nodes.forEach(n => {
      if (n.op === 'var_set') {
        const varId = n['var'];
        if (!varCaptures.has(varId)) {
          const type = nodeTypes.get(n.id) || nodeTypes.get(n['val']) || 'float';
          varCaptures.set(varId, { offset: currentOffset, type: type as any });
          currentOffset += getComponentCount(type as string);
        }
      }
    });

    // 2. Prepare Resources
    const captureDef: ResourceDef = {
      id: captureBufferId,
      type: 'buffer',
      dataType: 'float',
      size: { mode: 'fixed', value: Math.max(currentOffset, 1) },
      persistence: { cpuAccess: true, retain: false, clearEveryFrame: false, clearOnResize: false }
    };
    ir.resources.push(captureDef);

    // Manually add to context resources
    ctx.resources.set(captureBufferId, {
      def: captureDef as any,
      width: Math.max(currentOffset, 1),
      height: 1,
      data: new Array(Math.max(currentOffset, 1)).fill(0)
    } as any);

    // 3. Transform the function into a shader and inject stores
    originalFunc.id = gpuKernelId;
    originalFunc.type = 'shader';

    const newNodes: IRNode[] = [];
    originalFunc.nodes.forEach(node => {
      newNodes.push(node);
      if (node.op === 'var_set') {
        const varId = node['var'];
        const capture = varCaptures.get(varId)!;
        const count = getComponentCount(capture.type);

        const valId = node['val'];
        let lastNodeId = node.id;
        const finalNext = (node as any).exec_out || (node as any).next || (node as any)._next;
        delete (node as any).exec_out;
        delete (node as any).next;
        delete (node as any)._next;

        if (count === 1) {
          const storeId = `capture_${node.id}`;
          newNodes.push({
            id: storeId,
            op: 'buffer_store',
            buffer: captureBufferId,
            index: capture.offset,
            value: valId,
            exec_in: lastNodeId
          });
          lastNodeId = storeId;
        } else {
          for (let i = 0; i < count; i++) {
            const extractId = `capture_extract_${node.id}_${i}`;
            const storeId = `capture_store_${node.id}_${i}`;
            const op = (capture.type as string).startsWith('array') ? 'array_extract' : 'vec_get_element';

            const extractNode: any = {
              id: extractId,
              op: op,
              index: i
            };

            if (op === 'array_extract') {
              extractNode.array = valId;
            } else {
              extractNode.vec = valId;
            }

            newNodes.push(extractNode);

            newNodes.push({
              id: storeId,
              op: 'buffer_store',
              buffer: captureBufferId,
              index: capture.offset + i,
              value: extractId,
              exec_in: lastNodeId
            });
            lastNodeId = storeId;
          }
        }

        // Fix up the next node in the chain
        const lastCreatedNode = newNodes[newNodes.length - 1];
        if (finalNext) {
          (lastCreatedNode as any).exec_out = finalNext;
        }
      }
    });
    originalFunc.nodes = newNodes;

    // 4. Create CPU Trampoline
    const trampolineId = `trampoline_${originalEntryPointId}`;
    const syncNodes: IRNode[] = [];
    ir.resources.forEach((res, idx) => {
      const syncId = `sync_${res.id}`;
      const waitId = `wait_${res.id}`;
      syncNodes.push({
        id: syncId,
        op: 'cmd_sync_to_cpu',
        resource: res.id,
        exec_in: idx === 0 ? 'dispatch' : `wait_${ir.resources[idx - 1].id}`
      });
      syncNodes.push({
        id: waitId,
        op: 'cmd_wait_cpu_sync',
        resource: res.id,
        exec_in: syncId
      });
    });

    const trampolineFunc: FunctionDef = {
      id: trampolineId,
      type: 'cpu',
      inputs: [...originalFunc.inputs],
      outputs: [...originalFunc.outputs],
      localVars: [],
      nodes: [
        {
          id: 'dispatch',
          op: 'cmd_dispatch',
          func: gpuKernelId,
          dispatch: [1, 1, 1],
          args: Object.fromEntries([...originalFunc.inputs, ...(ir.inputs || [])].map(i => [i.id, i.id]))
        },
        ...syncNodes
      ]
    };
    ir.functions.push(trampolineFunc);
    ir.entryPoint = trampolineId;

    // 5. Build and execute via WebGpuBackend
    ctx.ir = ir;
    await WebGpuBackend.run(ctx, trampolineId);

    // 6. Readback captured variables into context
    const captureRes = ctx.getResource(captureBufferId);
    if (captureRes && captureRes.data) {
      if (ctx.stack.length === 0) {
        ctx.pushFrame(originalEntryPointId);
      }
      varCaptures.forEach((cap, varId) => {
        const count = getComponentCount(cap.type);
        if (count === 1) {
          ctx.setVar(varId, captureRes.data![cap.offset]);
        } else {
          const slice = captureRes.data!.slice(cap.offset, cap.offset + count);
          ctx.setVar(varId, Array.from(slice));
        }
      });
    }
    // Clear result so test runner looks at variables
    ctx.result = undefined;
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await ForceOntoGPUTestBackend.createContext(ir, inputs);
    await ForceOntoGPUTestBackend.run(ctx, entryPoint);
    return ctx;
  }
};
