/// <reference types="@webgpu/types" />
import { IRDocument, DataType, ResourceDef, FunctionDef, Node as IRNode } from '../../ir/types';
import { inferFunctionTypes, validateIR } from '../../ir/validator';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { InterpretedExecutor } from '../../interpreter/executor';
import { gpuSemaphore } from './gpu-singleton';
import { TestBackend } from './types';
import { WebGpuBackend } from './webgpu-backend';
import { WgslGenerator } from '../../webgpu/wgsl-generator';
import { GpuCache } from '../../webgpu/gpu-cache';
import { ShaderLayout, packBuffer } from '../../webgpu/shader-layout';

// Helper: Calculate size per element
const getElementSize = (type?: string) => {
  if (!type) return 4;
  if (type.startsWith('vec2') || type === 'float2') return 8;
  if (type.startsWith('vec3') || type === 'float3') return 16; // WGSL vec3 alignment is 16 bytes.
  if (type.startsWith('vec4') || type === 'float4') return 16;
  if (type.startsWith('mat4') || type === 'float4x4') return 64;
  return 4;
};

/**
 * ForceOntoGPUTestBackend
 *
 * A specialized backend that forces the Execution Graph (which is usually CPU logic in conformance tests)
 * to run as a Compute Shader on the GPU.
 *
 * Strategy:
 * 1. Analyze the Entry Point Function.
 * 2. Identify all 'var_set' and 'var_get' operations on globals.
 * 3. Allocate a 'Global Storage Buffer' to hold these values.
 * 4. Generate WGSL that treats 'fn_main' as a compute kernel, mapping global vars to storage buffer offsets.
 * 5. Dispatch (1, 1, 1).
 * 6. Read back the storage buffer and populate the EvaluationContext variables.
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

    // 1. Analyze and Transform GPU Kernel
    const nodeTypes = inferFunctionTypes(originalFunc, ir);
    const varCaptures = new Map<string, { offset: number, type: DataType }>();
    let currentOffset = 0;

    originalFunc.nodes.forEach(n => {
      if (n.op === 'var_set') {
        const varId = n['var'];
        if (!varCaptures.has(varId)) {
          const type = nodeTypes.get(n.id) || nodeTypes.get(n['val']) || 'float';
          varCaptures.set(varId, { offset: currentOffset, type });
          currentOffset += getComponentCount(type);
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
            value: node.id,
            exec_in: lastNodeId
          });
          lastNodeId = storeId;
        } else {
          for (let i = 0; i < count; i++) {
            const swizzleId = `capture_swizzle_${node.id}_${i}`;
            const storeId = `capture_store_${node.id}_${i}`;
            const channels = ['x', 'y', 'z', 'w'];

            newNodes.push({
              id: swizzleId,
              op: 'vec_swizzle',
              vec: node.id,
              channels: channels[i]
            });
            newNodes.push({
              id: storeId,
              op: 'buffer_store',
              buffer: captureBufferId,
              index: capture.offset + i,
              value: swizzleId,
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
          dispatch: [1, 1, 1], // Default to 1,1,1 for basic tests
          args: Object.fromEntries(originalFunc.inputs.map(i => [i.id, i.id]))
        },
        {
          id: 'sync',
          op: 'cmd_sync_to_cpu',
          resource: captureBufferId,
          exec_in: 'dispatch'
        },
        {
          id: 'wait',
          op: 'cmd_wait_cpu_sync',
          resource: captureBufferId,
          exec_in: 'sync'
        }
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
      // Ensure we have a frame to set variables in
      if (ctx.stack.length === 0) {
        ctx.pushFrame(originalEntryPointId);
      }
      varCaptures.forEach((cap, varId) => {
        const count = getComponentCount(cap.type);
        if (count === 1) {
          ctx.setVar(varId, captureRes.data![cap.offset]);
        } else {
          const slice = captureRes.data!.slice(cap.offset, cap.offset + count);
          ctx.setVar(varId, slice);
        }
      });
    }
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await ForceOntoGPUTestBackend.createContext(ir, inputs);
    await ForceOntoGPUTestBackend.run(ctx, entryPoint);
    return ctx;
  }
};
