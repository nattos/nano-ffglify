import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { precomputeShaderInfo, precomputeResourceLayout } from '../../webgpu/precompute';
import { CompilationMetadata } from '../../webgpu/wgsl-generator';

// Load intrinsics.js and evaluate it to get access to the functions
const intrinsicsPath = path.resolve(__dirname, '../../webgpu/intrinsics.js');
const intrinsicsCode = fs.readFileSync(intrinsicsPath, 'utf8');

// We'll use a helper to get the functions since they are not exported
function getIntrinsics() {
  const context: any = {
    Array,
    Math,
    Error,
    Uint8Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    DataView,
    ArrayBuffer,
    Object,
    JSON,
    console,
    Promise,
    setTimeout,
    setInterval,
  };

  // Evaluate the code in a function context and return the functions we need
  const fn = new Function(...Object.keys(context), `
    ${intrinsicsCode}
    return { _ensureGpuResource, _ensureGpuResource2, _buffer_store, _buffer_load, _createExecutor };
  `);

  return fn(...Object.values(context));
}

const { _ensureGpuResource, _ensureGpuResource2, _buffer_store, _buffer_load, _createExecutor } = getIntrinsics();

describe('WebGPU Intrinsics', () => {
  let mockDevice: any;
  let mockQueue: any;

  beforeEach(() => {
    mockQueue = {
      writeTexture: vi.fn(),
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    };
    mockDevice = {
      createTexture: vi.fn().mockReturnValue({
        width: 0,
        height: 0,
        destroy: vi.fn(),
        createView: vi.fn().mockReturnValue({}),
      }),
      createBuffer: vi.fn().mockReturnValue({
        size: 0,
        destroy: vi.fn(),
        mapAsync: vi.fn().mockResolvedValue(undefined),
        getMappedRange: vi.fn().mockReturnValue(new ArrayBuffer(64)),
        unmap: vi.fn(),
      }),
      createBindGroup: vi.fn().mockReturnValue({}),
      createCommandEncoder: vi.fn().mockReturnValue({
        beginComputePass: vi.fn().mockReturnValue({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          dispatchWorkgroups: vi.fn(),
          end: vi.fn(),
        }),
        copyBufferToBuffer: vi.fn(),
        finish: vi.fn().mockReturnValue({}),
      }),
      queue: mockQueue,
    };
  });

  describe('_ensureGpuResource', () => {
    it('should create a texture resource', () => {
      const state = {
        def: { type: 'texture2d', format: 'rgba8unorm' },
        width: 10,
        height: 10,
        gpuTexture: null as any,
      };

      _ensureGpuResource(mockDevice, state);

      expect(mockDevice.createTexture).toHaveBeenCalledWith({
        size: [10, 10, 1],
        format: 'rgba8unorm',
        usage: 0x1F,
      });
      expect(state.gpuTexture).toBeDefined();
    });

    it('should upload texture data (flat array)', () => {
      const state = {
        def: { type: 'texture2d', format: 'rgba8unorm' },
        width: 2,
        height: 1,
        data: [1, 0, 0, 1, 0, 1, 0, 1], // 2 pixels, r,g,b,a
        gpuTexture: null as any,
      };

      _ensureGpuResource(mockDevice, state);

      expect(mockQueue.writeTexture).toHaveBeenCalled();
      const [, , , size] = mockQueue.writeTexture.mock.calls[0];
      expect(size).toEqual({ width: 2, height: 1 });
    });

    it('should upload texture data (nested arrays)', () => {
      const state = {
        def: { type: 'texture2d', format: 'rgba8unorm' },
        width: 2,
        height: 1,
        data: [[1, 0, 0, 1], [0, 1, 0, 1]],
        gpuTexture: null as any,
      };

      _ensureGpuResource(mockDevice, state);

      expect(mockQueue.writeTexture).toHaveBeenCalled();
      const [, data] = mockQueue.writeTexture.mock.calls[0];
      expect(data[0]).toBe(255); // 1 * 255
      expect(data[4]).toBe(0);   // 0 * 255 (second pixel red)
      expect(data[5]).toBe(255); // 1 * 255 (second pixel green)
    });

    it('should create a buffer resource', () => {
      const state = {
        def: { type: 'buffer' },
        width: 16, // 16 elements
        gpuBuffer: null as any,
      };

      _ensureGpuResource(mockDevice, state);

      expect(mockDevice.createBuffer).toHaveBeenCalledWith({
        size: 64, // 16 * 4
        usage: 128 | 8 | 4,
      });
      expect(state.gpuBuffer).toBeDefined();
    });

    it('should upload buffer data', () => {
      const state = {
        def: { type: 'buffer', dataType: 'float' },
        width: 4,
        data: [1.0, 2.0, 3.0, 4.0],
        gpuBuffer: null as any,
      };

      _ensureGpuResource(mockDevice, state);

      expect(mockQueue.writeBuffer).toHaveBeenCalled();
      const [, offset, data] = mockQueue.writeBuffer.mock.calls[0];
      expect(offset).toBe(0);
      expect(data).toBeInstanceOf(Float32Array);
      expect(data[0]).toBe(1.0);
    });

    it('should reuse existing resources if same size', () => {
      const existingTexture = { width: 10, height: 10, destroy: vi.fn() };
      const state = {
        def: { type: 'texture2d' },
        width: 10,
        height: 10,
        gpuTexture: existingTexture as any,
      };

      _ensureGpuResource(mockDevice, state);

      expect(mockDevice.createTexture).not.toHaveBeenCalled();
      expect(existingTexture.destroy).not.toHaveBeenCalled();
    });

    it('should recreate resources if size changes', () => {
      const existingTexture = { width: 10, height: 10, destroy: vi.fn() };
      const state = {
        def: { type: 'texture2d' },
        width: 20,
        height: 20,
        gpuTexture: existingTexture as any,
      };

      _ensureGpuResource(mockDevice, state);

      expect(existingTexture.destroy).toHaveBeenCalled();
      expect(mockDevice.createTexture).toHaveBeenCalledWith({
        size: [20, 20, 1],
        format: 'rgba8unorm',
        usage: 0x1F,
      });
    });

    it('should flatten nested buffer data (e.g. array of vectors)', () => {
      const state = {
        def: { type: 'buffer', dataType: 'float' },
        width: 4,
        data: [[1.0, 2.0], [3.0, 4.0]], // Nested vectors
        gpuBuffer: null as any,
      };

      _ensureGpuResource(mockDevice, state);

      expect(mockQueue.writeBuffer).toHaveBeenCalled();
      const [, , data] = mockQueue.writeBuffer.mock.calls[0];
      expect(data).toBeInstanceOf(Float32Array);
      expect(Array.from(data)).toEqual([1.0, 2.0, 3.0, 4.0]);
    });

    it('should flatten deeply nested buffer data', () => {
      const state = {
        def: { type: 'buffer', dataType: 'float' },
        width: 4,
        data: [[[1.0]], [[2.0]], [[3.0]], [[4.0]]],
        gpuBuffer: null as any,
      };

      _ensureGpuResource(mockDevice, state);

      expect(mockQueue.writeBuffer).toHaveBeenCalled();
      const [, , data] = mockQueue.writeBuffer.mock.calls[0];
      expect(Array.from(data)).toEqual([1.0, 2.0, 3.0, 4.0]);
    });
  });

  describe('_ensureGpuResource2', () => {
    it('should create and upload texture data using precomputed info', () => {
      const def = { type: 'texture2d', format: 'rgba8unorm' };
      const info = precomputeResourceLayout(def);
      const state = {
        def,
        width: 2,
        height: 1,
        data: [[1, 0, 0, 1], [0, 1, 0, 1]],
        gpuTexture: null as any,
      };

      _ensureGpuResource2(mockDevice, state, info);

      expect(mockDevice.createTexture).toHaveBeenCalled();
      expect(mockQueue.writeTexture).toHaveBeenCalled();
      const [, data] = mockQueue.writeTexture.mock.calls[0];
      expect(data[0]).toBe(255);
      expect(data[5]).toBe(255);
    });

    it('should create and upload buffer data using precomputed info', () => {
      const def = { type: 'buffer', dataType: 'float' };
      const info = precomputeResourceLayout(def);
      const state = {
        def,
        width: 4,
        data: [[1.0, 2.0], [3.0, 4.0]],
        gpuBuffer: null as any,
      };

      _ensureGpuResource2(mockDevice, state, info);

      expect(mockDevice.createBuffer).toHaveBeenCalled();
      expect(mockQueue.writeBuffer).toHaveBeenCalled();
      const [, , data] = mockQueue.writeBuffer.mock.calls[0];
      expect(Array.from(data)).toEqual([1.0, 2.0, 3.0, 4.0]);
    });
  });

  describe('precomputeResourceLayout', () => {
    it('should map IR formats to WebGPU formats correctly', () => {
      const cases = [
        { ir: 'rgba8', gpu: 'rgba8unorm', tc: 4, ta: 'Uint8Array' },
        { ir: 'rgba32f', gpu: 'rgba32float', tc: 4, ta: 'Float32Array' },
        { ir: 'rgba16f', gpu: 'rgba16float', tc: 4, ta: 'Float32Array' },
        { ir: 'r32f', gpu: 'r32float', tc: 1, ta: 'Float32Array' },
        { ir: 'r16f', gpu: 'r16float', tc: 1, ta: 'Float32Array' },
        { ir: 'r8', gpu: 'r8unorm', tc: 1, ta: 'Uint8Array' },
      ];

      for (const c of cases) {
        const info = precomputeResourceLayout({ type: 'texture2d', format: c.ir });
        expect(info.format).toBe(c.gpu);
        expect(info.componentCount).toBe(c.tc);
        expect(info.typedArray).toBe(c.ta);
      }
    });

    it('should use rgba8unorm as default for textures', () => {
      const info = precomputeResourceLayout({ type: 'texture2d' });
      expect(info.format).toBe('rgba8unorm');
    });
  });

  describe('_buffer_store', () => {
    it('should store value and invalidate GPU buffer', () => {
      const gpuBuffer = { destroy: vi.fn() };
      const resState = {
        def: { type: 'buffer' },
        data: [0, 0, 0],
        gpuBuffer: gpuBuffer as any,
      };
      const resources = new Map([['buf1', resState]]);

      _buffer_store(resources, 'buf1', 1, 123);

      expect(resState.data[1]).toBe(123);
      expect(resState.gpuBuffer).toBeUndefined();
      expect(gpuBuffer.destroy).toHaveBeenCalled();
    });
  });

  describe('_buffer_load', () => {
    it('should load value', () => {
      const resState = {
        def: { type: 'buffer' },
        data: [10, 20, 30],
      };
      const resources = new Map([['buf1', resState]]);

      const val = _buffer_load(resources, 'buf1', 1);
      expect(val).toBe(20);
    });

    it('should throw on OOB', () => {
      const resState = {
        def: { type: 'buffer' },
        data: [10, 20, 30],
      };
      const resources = new Map([['buf1', resState]]);

      expect(() => _buffer_load(resources, 'buf1', 3)).toThrow('Runtime Error: buffer_load OOB');
      expect(() => _buffer_load(resources, 'buf1', -1)).toThrow('Runtime Error: buffer_load OOB');
    });

    it('should throw if buffer not found', () => {
      const resources = new Map();
      expect(() => _buffer_load(resources, 'buf1', 0)).toThrow('Runtime Error: buffer not found');
    });
  });

  describe('_createExecutor', () => {
    it('should execute compute shader with precomputed info', async () => {
      const meta: CompilationMetadata = {
        inputBinding: 0,
        inputLayout: {
          totalSize: 16,
          fields: [
            { name: 'u_val', offset: 0, type: 'f32', size: 4, align: 4 }
          ],
          hasRuntimeArray: false,
          alignment: 16
        },
        resourceBindings: new Map(),
        workgroupSize: [1, 1, 1],
        structLayouts: {}
      };

      const precomputed = new Map([['func1', precomputeShaderInfo(meta, [])]]);
      const pipelines = new Map([['func1', {
        getBindGroupLayout: vi.fn().mockReturnValue({})
      }]]);

      const executor = _createExecutor(mockDevice, pipelines, precomputed, new Map());
      const resources = new Map();

      await executor.executeShader('func1', [1, 1, 1], { u_val: 1.23 }, resources);

      expect(mockQueue.writeBuffer).toHaveBeenCalled();
      const [, , bufferSource] = mockQueue.writeBuffer.mock.calls[0];
      const view = new DataView(bufferSource instanceof ArrayBuffer ? bufferSource : bufferSource.buffer);
      expect(view.getFloat32(0, true)).toBeCloseTo(1.23);
    });

    it('should correctly handle nested structs in precomputed executor', async () => {
      const meta: CompilationMetadata = {
        inputBinding: 0,
        inputLayout: {
          totalSize: 32,
          fields: [
            { name: 'u_struct', offset: 0, type: 'MyStruct', size: 32, align: 16 }
          ],
          hasRuntimeArray: false,
          alignment: 16
        },
        resourceBindings: new Map(),
        workgroupSize: [1, 1, 1],
        structLayouts: {
          'mystruct': {
            size: 32,
            alignment: 16,
            members: [
              { name: 'v', offset: 0, type: 'vec3<f32>', size: 12, align: 16 },
              { name: 's', offset: 16, type: 'f32', size: 4, align: 4 }
            ]
          }
        }
      };

      const precomputed = new Map([['func1', precomputeShaderInfo(meta, [
        { id: 'MyStruct', members: [{ name: 'v', type: 'vec3<f32>' }, { name: 's', type: 'f32' }] }
      ])]]);

      const pipelines = new Map([['func1', {
        getBindGroupLayout: vi.fn().mockReturnValue({})
      }]]);

      const executor = _createExecutor(mockDevice, pipelines, precomputed, new Map());

      const inputs = {
        u_struct: {
          v: [1, 2, 3],
          s: 4.5
        }
      };

      await executor.executeShader('func1', [1, 1, 1], inputs, new Map());

      expect(mockQueue.writeBuffer).toHaveBeenCalled();
      const [, , bufferSource] = mockQueue.writeBuffer.mock.calls[0];
      const view = new DataView(bufferSource instanceof ArrayBuffer ? bufferSource : bufferSource.buffer);

      expect(view.getFloat32(0, true)).toBe(1);
      expect(view.getFloat32(4, true)).toBe(2);
      expect(view.getFloat32(8, true)).toBe(3);
      expect(view.getFloat32(12, true)).toBeCloseTo(4.5);
    });

    it('should correctly handle runtime arrays in precomputed executor', async () => {
      const meta: CompilationMetadata = {
        inputBinding: 0,
        inputLayout: {
          totalSize: 0,
          fields: [
            { name: 'u_arr', offset: 0, type: 'f32[]', size: 0, align: 4 }
          ],
          hasRuntimeArray: true,
          alignment: 4
        },
        resourceBindings: new Map(),
        workgroupSize: [1, 1, 1],
        structLayouts: {}
      };

      const precomputed = new Map([['func1', precomputeShaderInfo(meta, [])]]);
      const pipelines = new Map([['func1', {
        getBindGroupLayout: vi.fn().mockReturnValue({})
      }]]);

      const executor = _createExecutor(mockDevice, pipelines, precomputed, new Map());

      const inputs = {
        u_arr: [1.1, 2.2, 3.3]
      };

      await executor.executeShader('func1', [1, 1, 1], inputs, new Map());

      expect(mockQueue.writeBuffer).toHaveBeenCalled();
      const [, , bufferSource] = mockQueue.writeBuffer.mock.calls[0];
      const view = new DataView(bufferSource instanceof ArrayBuffer ? bufferSource : bufferSource.buffer);

      expect(view.getFloat32(0, true)).toBeCloseTo(1.1);
      expect(view.getFloat32(4, true)).toBeCloseTo(2.2);
      expect(view.getFloat32(8, true)).toBeCloseTo(3.3);
    });

    it('should restore structured data (vectors) during readback', async () => {
      // Mock a buffer with float4 data
      const meta: CompilationMetadata = {
        inputBinding: 0,
        resourceBindings: new Map([['buf1', 1]]),
        workgroupSize: [1, 1, 1],
        structLayouts: {}
      };

      const precomputed = new Map([['func1', precomputeShaderInfo(meta, [])]]);
      const pipelines = new Map([['func1', {
        getBindGroupLayout: vi.fn().mockReturnValue({})
      }]]);

      const resDef = { id: 'buf1', type: 'buffer', dataType: 'float4' };
      const resInfo = precomputeResourceLayout(resDef);
      const resourceInfos = new Map([['buf1', resInfo]]);

      const executor = _createExecutor(mockDevice, pipelines, precomputed, new Map(), resourceInfos);

      const resState = {
        id: 'buf1',
        def: resDef,
        width: 1, // 1 float4
        data: [[0, 0, 0, 0]],
        gpuBuffer: { size: 16, destroy: vi.fn(), mapAsync: vi.fn().mockResolvedValue(undefined), getMappedRange: vi.fn(), unmap: vi.fn() } as any
      };

      // Mock the buffer content: [0.1, 0.2, 0.3, 0.4]
      const bufferData = new Float32Array([0.1, 0.2, 0.3, 0.4]);

      // Override createBuffer to return a staging buffer with our data
      mockDevice.createBuffer.mockImplementation((desc: any) => {
        if (desc.usage & 1) { // MAP_READ
          return {
            size: desc.size,
            destroy: vi.fn(),
            mapAsync: vi.fn().mockResolvedValue(undefined),
            getMappedRange: vi.fn().mockReturnValue(bufferData.buffer),
            unmap: vi.fn()
          };
        }
        return {
          size: desc.size,
          destroy: vi.fn(),
          usage: desc.usage,
          mapAsync: vi.fn().mockResolvedValue(undefined),
          getMappedRange: vi.fn().mockReturnValue(new ArrayBuffer(desc.size)),
          unmap: vi.fn()
        };
      });

      const resources = new Map([['buf1', resState]]);

      await executor.executeShader('func1', [1, 1, 1], {}, resources);

      // Current implementation returns flat array [0.1, 0.2, 0.3, 0.4] if width=4 or [0.1] if width=1
      // Expected: [[0.1, 0.2, 0.3, 0.4]]
      expect(resState.data[0]).toHaveLength(4);
      expect(resState.data[0][0]).toBeCloseTo(0.1);
      expect(resState.data[0][1]).toBeCloseTo(0.2);
      expect(resState.data[0][2]).toBeCloseTo(0.3);
      expect(resState.data[0][3]).toBeCloseTo(0.4);
    });
  });
});
