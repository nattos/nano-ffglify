import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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
    return { _ensureGpuResource, _buffer_store, _buffer_load, _createExecutor };
  `);

  return fn(...Object.values(context));
}

const { _ensureGpuResource, _buffer_store, _buffer_load, _createExecutor } = getIntrinsics();

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
    it('should create an executor object', () => {
      const pipelines = new Map();
      const pipelineMeta = new Map();
      const renderPipelines = new Map();

      const executor = _createExecutor(mockDevice, pipelines, pipelineMeta, renderPipelines);

      expect(executor).toHaveProperty('executeShader');
      expect(executor).toHaveProperty('executeDraw');
    });

    it('should execute compute shader with data bindings', async () => {
      const pipelines = new Map([['func1', {
        getBindGroupLayout: vi.fn().mockReturnValue({})
      }]]);
      const meta = {
        inputBinding: 0,
        inputLayout: {
          totalSize: 16,
          fields: [
            { name: 'u_val', offset: 0, type: 'f32' }
          ]
        },
        resourceBindings: {}
      };
      const pipelineMeta = new Map([['func1', meta]]);
      const renderPipelines = new Map();

      const executor = _createExecutor(mockDevice, pipelines, pipelineMeta, renderPipelines);
      const resources = new Map();

      await executor.executeShader('func1', [1, 1, 1], { u_val: 1.23 }, resources);

      expect(mockDevice.createBuffer).toHaveBeenCalled(); // For indices/inputs
      expect(mockQueue.writeBuffer).toHaveBeenCalled();
      expect(mockDevice.createBindGroup).toHaveBeenCalled();
    });

    it('should flatten complex nested types in executeShader inputs', async () => {
      const pipelines = new Map([['func1', {
        getBindGroupLayout: vi.fn().mockReturnValue({})
      }]]);

      const meta = {
        inputBinding: 0,
        inputLayout: {
          totalSize: 64,
          fields: [
            { name: 'u_struct', offset: 0, type: 'MyStruct' }
          ]
        },
        structLayouts: {
          'MyStruct': {
            size: 64,
            members: [
              { name: 'v', offset: 0, type: 'vec4<f32>' },
              { name: 'm', offset: 16, type: 'mat2x2<f32>' },
              { name: 'a', offset: 32, type: 'f32[2]' }
            ]
          }
        },
        resourceBindings: {}
      };

      const pipelineMeta = new Map([['func1', meta]]);
      const executor = _createExecutor(mockDevice, pipelines, pipelineMeta, new Map());

      const inputs = {
        u_struct: {
          v: [1, 2, 3, 4],
          m: [1, 0, 0, 1],
          a: [10, 20]
        }
      };

      await executor.executeShader('func1', [1, 1, 1], inputs, new Map());

      expect(mockQueue.writeBuffer).toHaveBeenCalled();
      const [, , bufferSource] = mockQueue.writeBuffer.mock.calls[0];

      // bufferSource is an ArrayBuffer from the DataView
      const view = new DataView(bufferSource instanceof ArrayBuffer ? bufferSource : bufferSource.buffer);

      // Check vec4
      expect(view.getFloat32(0, true)).toBe(1);
      expect(view.getFloat32(12, true)).toBe(4);

      // Check mat2x2 (offset 16)
      // Column-major: m00 m01 m10 m11 -> wait, mat2x2 is 2 vec2s.
      // Column stride is 8.
      expect(view.getFloat32(16, true)).toBe(1);
      expect(view.getFloat32(24, true)).toBe(0); // second column start

      // Check array f32[2] (offset 32)
      expect(view.getFloat32(32, true)).toBe(10);
      expect(view.getFloat32(36, true)).toBe(20);
    });
  });
});
