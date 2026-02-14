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
  const t = type.toLowerCase();
  if (t === 'float2' || t === 'int2' || t === 'vec2<float>' || t === 'vec2<f32>' || t === 'vec2<i32>') return 2;
  if (t === 'float3' || t === 'int3' || t === 'vec3<float>' || t === 'vec3<f32>' || t === 'vec3<i32>') return 3;
  if (t === 'float4' || t === 'int4' || t === 'vec4<float>' || t === 'vec4<f32>' || t === 'vec4<i32>') return 4;
  if (t === 'float3x3' || t === 'mat3x3<float>' || t === 'mat3x3<f32>') return 9;
  if (t === 'float4x4' || t === 'mat4x4<float>' || t === 'mat4x4<f32>') return 16;
  if (t.startsWith('array<')) {
    const match = t.match(/,\s*(\d+)>/);
    if (match) return parseInt(match[1]);
  }
  return 1;
};

export const ForceOntoGPUTestBackend: TestBackend = {
  name: 'ForceOntoGPU',

  createContext: async (ir: IRDocument, inputs?: Map<string, RuntimeValue>, builtins?: Map<string, RuntimeValue>) => {
    // Validate IR
    const errors = validateIR(ir);
    const criticalErrors = errors.filter(e => e.severity === 'error');
    if (criticalErrors.length > 0) {
      console.error('[ForceOntoGPUTestBackend] IR Validation Failed:', criticalErrors);
      throw new Error(`IR Validation Failed:\n${criticalErrors.map(e => e.message).join('\n')}`);
    }

    // Reuse WebGpuBackend's context creation (device init, resource alloc)
    const ctx = await WebGpuBackend.createContext(ir, inputs, builtins);
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
    const RETURN_CAPTURE_VAR = '__force_gpu_return';

    // 1. Analyze for Variable Capture
    const nodeTypes = inferFunctionTypes(originalFunc, ir);
    const varCaptures = new Map<string, { offset: number, type: DataType }>();
    let currentOffset = 0;

    originalFunc.nodes.forEach(n => {
      if (n.op === 'var_set' || n.op === 'func_return') {
        const varId = n.op === 'var_set' ? n['var'] : RETURN_CAPTURE_VAR;
        if (!varCaptures.has(varId)) {
          let type: string | undefined;
          if (n.op === 'var_set') {
            // Use the local var's declared type (handles inline swizzle refs correctly)
            const localVar = originalFunc.localVars.find(v => v.id === varId);
            type = localVar?.type as DataType;
          }
          if (!type) {
            const valId = n['val'];
            // Handle inline swizzle: "nodeId.xyz" — resolve base and compute swizzled type
            let baseValId = valId;
            let swizzleLen = 0;
            if (typeof valId === 'string' && valId.includes('.')) {
              const dotIdx = valId.indexOf('.');
              baseValId = valId.substring(0, dotIdx);
              swizzleLen = valId.length - dotIdx - 1;
            }
            type = nodeTypes.get(baseValId) ||
              (originalFunc.localVars.find(v => v.id === baseValId)?.type as DataType) ||
              (originalFunc.inputs.find(i => i.id === baseValId)?.type as DataType) ||
              'float';
            if (swizzleLen > 0) {
              // Compute swizzled type from base type
              const isInt = (type as string).startsWith('int');
              const prefix = isInt ? 'int' : 'float';
              type = (swizzleLen === 1 ? prefix : `${prefix}${swizzleLen}`) as DataType;
            }
          }
          const count = getComponentCount(type as string);
          varCaptures.set(varId, { offset: currentOffset, type: type as any });
          currentOffset += count;
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

    // Update recursive calls
    originalFunc.nodes = originalFunc.nodes.map(n => {
      if (n.op === 'call_func' && n['func'] === originalEntryPointId) {
        return { ...n, func: gpuKernelId };
      }
      return n;
    });

    const injectCaptureNodes = (nodes: IRNode[], lastNodeId: string, offset: number, valId: string, type: any, count: number) => {
      if (count === 1) {
        const storeId = `capture_${lastNodeId}_${valId}`;
        nodes.push({
          id: storeId,
          op: 'buffer_store',
          buffer: captureBufferId,
          index: offset,
          value: valId,
          exec_in: lastNodeId
        });
      } else {
        for (let i = 0; i < count; i++) {
          const extractId = `capture_extract_${lastNodeId}_${valId}_${i}`;
          const storeId = `capture_store_${lastNodeId}_${valId}_${i}`;
          const op = (type as string).startsWith('array') ? 'array_extract' : 'vec_get_element';

          const extractNode: any = { id: extractId, op: op, index: i };
          if (op === 'array_extract') extractNode.array = valId;
          else extractNode.vec = valId;

          nodes.push(extractNode);
          nodes.push({
            id: storeId,
            op: 'buffer_store',
            buffer: captureBufferId,
            index: offset + i,
            value: extractId,
            exec_in: i === 0 ? lastNodeId : `capture_store_${lastNodeId}_${valId}_${i - 1}`
          });
        }
      }
    };

    const newNodes: IRNode[] = [];
    originalFunc.nodes.forEach(node => {
      if (node.op === 'var_set') {
        newNodes.push(node);
        const varId = node['var'];
        const capture = varCaptures.get(varId)!;
        const count = getComponentCount(capture.type);
        // Use a var_get to read the local var after the var_set,
        // so inline swizzles and type coercions are properly materialized.
        const varGetId = `capture_varget_${node.id}_${varId}`;
        newNodes.push({ id: varGetId, op: 'var_get', var: varId } as any);
        injectCaptureNodes(newNodes, node.id, capture.offset, varGetId, capture.type, count);
      } else if (node.op === 'func_return') {
        const capture = varCaptures.get(RETURN_CAPTURE_VAR)!;
        const count = getComponentCount(capture.type);
        // Inject prefix stores BEFORE the return
        injectCaptureNodes(newNodes, (node as any).exec_in, capture.offset, node['val'], capture.type, count);
        newNodes.push(node);
      } else {
        newNodes.push(node);
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

    // Mark all resources reachable by GPU as gpuDirty so sync works
    ir.resources.forEach(res => {
      const runtimeRes = ctx.getResource(res.id);
      if (runtimeRes) (runtimeRes as any).gpuDirty = true;
    });

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
        let val: any;
        if (count === 1) {
          val = captureRes.data![cap.offset];
        } else {
          const slice = captureRes.data!.slice(cap.offset, cap.offset + count);
          val = Array.from(slice);
        }

        if (varId === RETURN_CAPTURE_VAR) {
          ctx.result = val;
        } else {
          ctx.setVar(varId, val);
        }
      });
    }
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map(), builtins?: Map<string, RuntimeValue>) => {
    const ctx = await ForceOntoGPUTestBackend.createContext(ir, inputs, builtins);
    await ForceOntoGPUTestBackend.run(ctx, entryPoint);
    return ctx;
  }
};
